import { EventEmitter } from 'events';
import { Http2SessionPool } from './http2-session-pool.service';

// Build a mock stream whose events fire after listeners are attached
function makeMockStream(
  statusCode: number,
  body: Buffer = Buffer.alloc(0),
  trailers: Record<string, string> = {},
) {
  const stream = new EventEmitter() as EventEmitter & {
    end: jest.Mock;
    setTimeout: jest.Mock;
    close: jest.Mock;
  };
  // Real http2 streams expose setTimeout/close; the pool sets a stream timeout.
  stream.setTimeout = jest.fn();
  stream.close = jest.fn();

  // Fire events: either when end() is called (body present) or when endStream
  // fires — we trigger via a helper so the caller controls timing.
  const fireEvents = () => {
    setImmediate(() => {
      stream.emit('response', {
        ':status': statusCode,
        'content-type': 'application/json',
      });
      if (body.length) stream.emit('data', body);
      stream.emit('trailers', trailers);
      stream.emit('end');
    });
  };

  stream.end = jest.fn().mockImplementation((data?: Buffer) => {
    if (data && data.length) {
      // Store the written body for assertion
      (stream as typeof stream & { _sentBody?: Buffer })._sentBody = data;
    }
    fireEvents();
  });

  // For requests with endStream:true the pool does NOT call req.end().
  // Fire automatically after listeners are registered via a no-arg end marker.
  // We detect this by watching the pool call req.end without args (null body path).
  // Instead, expose a trigger so the test session mock can call it.
  (stream as typeof stream & { _fireEvents: () => void })._fireEvents =
    fireEvents;

  return stream;
}

jest.mock('http2', () => {
  return { connect: jest.fn() };
});

function makeMockSession(
  streams: ReturnType<typeof makeMockStream>[],
): Record<string, unknown> {
  let callIndex = 0;
  const session = {
    destroyed: false,
    remoteSettings: { maxConcurrentStreams: 100 },
    request: jest
      .fn()
      .mockImplementation(
        (_headers: unknown, options?: { endStream?: boolean }) => {
          const stream = streams[callIndex++];
          // When endStream is true, the pool won't call req.end(); trigger events manually.
          if (options?.endStream) {
            (
              stream as ReturnType<typeof makeMockStream> & {
                _fireEvents: () => void;
              }
            )._fireEvents();
          }
          return stream;
        },
      ),
    on: jest.fn(),
    destroy: jest.fn().mockImplementation(function (this: {
      destroyed: boolean;
    }) {
      this.destroyed = true;
    }),
  };
  return session;
}

describe('Http2SessionPool', () => {
  let pool: Http2SessionPool;
  let http2: { connect: jest.Mock };

  beforeEach(() => {
    pool = new Http2SessionPool();
    http2 = jest.requireMock('http2') as { connect: jest.Mock };
    http2.connect.mockClear();
  });

  afterEach(() => {
    pool.destroyAll();
  });

  it('creates a new session on the first request', async () => {
    const stream = makeMockStream(200, Buffer.from('hello'));
    const session = makeMockSession([stream]);
    http2.connect.mockReturnValue(session);

    const result = await pool.request(
      'http://downstream:8080',
      'GET',
      '/health',
      {},
      null,
    );

    expect(http2.connect).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(200);
    expect(result.body.toString()).toBe('hello');
  });

  it('reuses the same session for a second request to the same target', async () => {
    const stream1 = makeMockStream(200);
    const stream2 = makeMockStream(201);
    const session = makeMockSession([stream1, stream2]);
    http2.connect.mockReturnValue(session);

    const r1 = await pool.request(
      'http://downstream:8080',
      'GET',
      '/a',
      {},
      null,
    );
    const r2 = await pool.request(
      'http://downstream:8080',
      'GET',
      '/b',
      {},
      null,
    );

    expect(http2.connect).toHaveBeenCalledTimes(1);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(201);
  });

  it('forwards request body when provided', async () => {
    const body = Buffer.from('{"key":"value"}');
    const stream = makeMockStream(200);
    const session = makeMockSession([stream]);
    http2.connect.mockReturnValue(session);

    await pool.request(
      'http://downstream:8080',
      'POST',
      '/data',
      { 'content-type': 'application/json' },
      body,
    );

    expect(stream.end).toHaveBeenCalledWith(body);
  });

  it('includes trailers in response', async () => {
    const stream = makeMockStream(200, Buffer.alloc(0), { 'grpc-status': '0' });
    const session = makeMockSession([stream]);
    http2.connect.mockReturnValue(session);

    const result = await pool.request(
      'http://downstream:8080',
      'POST',
      '/',
      {},
      null,
    );
    expect((result.trailers as Record<string, string>)['grpc-status']).toBe(
      '0',
    );
  });

  it('rejects when stream emits an error', async () => {
    const errStream = new EventEmitter() as EventEmitter & {
      end: jest.Mock;
      setTimeout: jest.Mock;
      close: jest.Mock;
    };
    errStream.end = jest.fn();
    errStream.setTimeout = jest.fn();
    errStream.close = jest.fn();
    const session = {
      destroyed: false,
      remoteSettings: { maxConcurrentStreams: 100 },
      request: jest
        .fn()
        .mockImplementation(
          (_headers: unknown, options?: { endStream?: boolean }) => {
            if (options?.endStream) {
              setImmediate(() =>
                errStream.emit('error', new Error('connection reset')),
              );
            }
            return errStream;
          },
        ),
      on: jest.fn(),
      destroy: jest.fn(),
    };
    http2.connect.mockReturnValue(session);

    await expect(
      pool.request('http://downstream:8080', 'GET', '/', {}, null),
    ).rejects.toThrow('connection reset');
  });

  it('destroyAll tears down all sessions', async () => {
    const stream = makeMockStream(200);
    const session = makeMockSession([stream]);
    http2.connect.mockReturnValue(session);

    await pool.request('http://downstream:8080', 'GET', '/', {}, null);

    pool.destroyAll();
    expect(session.destroy).toHaveBeenCalled();
  });
});
