import * as http2 from 'node:http2';
import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Http2SessionPool } from './http2-session-pool.service';
import type { Http2Settings } from '../../config/configuration';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not converge');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
describe('bounded HTTP/2 pool over real sockets', () => {
  let server: http2.Http2Server;
  let pool: Http2SessionPool;
  let target: string;
  let mode: 'echo' | 'stall' | 'trickle' | 'overflow' | 'early' | 'headers';
  let received: Array<{ headers: http2.IncomingHttpHeaders; body: Buffer }>;
  const sessions = new Set<http2.ServerHttp2Session>();
  const extras: Array<http.Server | net.Server> = [];
  function configured(settings: Partial<Http2Settings>) {
    pool.destroyAll();
    pool = new Http2SessionPool(new ConfigService({ http2: settings }));
  }
  async function listen(listener: http.Server | net.Server) {
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    return `http://127.0.0.1:${(listener.address() as net.AddressInfo).port}`;
  }
  beforeEach(async () => {
    mode = 'echo';
    received = [];
    pool = new Http2SessionPool();
    server = http2.createServer({ settings: { maxConcurrentStreams: 1 } });
    server.on('session', (session) => {
      sessions.add(session);
      session.on('error', () => undefined);
      session.once('close', () => sessions.delete(session));
    });
    server.on('stream', (stream, headers) => {
      stream.on('error', () => undefined);
      const entry = { headers, body: Buffer.alloc(0) };
      received.push(entry);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('end', () => {
        entry.body = Buffer.concat(chunks);
        if (mode === 'stall') return;
        if (mode === 'early') {
          stream.close(http2.constants.NGHTTP2_CANCEL);
          return;
        }
        stream.respond(
          {
            ':status': 201,
            ...(mode === 'headers' ? { 'x-large': 'x'.repeat(2000) } : {}),
          },
          { waitForTrailers: true },
        );
        stream.once('wantTrailers', () =>
          stream.sendTrailers({ 'x-verified': 'yes' }),
        );
        if (mode === 'trickle') {
          const timer = setInterval(() => stream.write('x'), 25);
          stream.once('close', () => clearInterval(timer));
        } else
          stream.end(
            mode === 'overflow'
              ? Buffer.alloc(1024)
              : entry.body.length
                ? entry.body
                : 'ok',
          );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    target = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    pool.destroyAll();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const extra of extras.splice(0))
      await new Promise<void>((resolve) => extra.close(() => resolve()));
  });
  it('reuses verified sessions and preserves binary bytes, status and trailers', async () => {
    const bytes = Buffer.from([0, 255, 32, 10, 0]);
    const result = await pool.request(
      target,
      'POST',
      '/exact?name=value',
      { 'content-type': 'application/octet-stream' },
      bytes,
    );
    expect(result.statusCode).toBe(201);
    expect(result.body).toEqual(bytes);
    expect(result.trailers['x-verified']).toBe('yes');
    expect(received[0].body).toEqual(bytes);
    expect(received[0].headers[':path']).toBe('/exact?name=value');
    await until(() => pool.activeRequests === 0);
    await pool.request(target, 'GET', '/', {}, null);
    expect(pool.sessionCount).toBe(1);
  });
  it('preserves target path prefixes and query parameters without coalescing distinct request bytes', async () => {
    await pool.request(
      `${target}/base?fixed=a%2Fb`,
      'GET',
      '/exact?input=c%2Fd&input=e',
      {},
      null,
    );
    expect(received[0].headers[':path']).toBe(
      '/base/exact?fixed=a%2Fb&input=c%2Fd&input=e',
    );
  });
  it('rejects global call capacity until an actual cancelled stream closes', async () => {
    configured({ maxActiveRequests: 1 });
    mode = 'stall';
    const cancel = new AbortController();
    const first = pool.request(
      target,
      'GET',
      '/',
      {},
      null,
      1000,
      cancel.signal,
    );
    const rejected = expect(first).rejects.toMatchObject({
      status: 499,
      fallbackSafe: false,
    });
    await until(() => received.length === 1);
    await expect(
      pool.request(target, 'GET', '/', {}, null),
    ).rejects.toMatchObject({ status: 503 });
    expect(received).toHaveLength(1);
    cancel.abort();
    await rejected;
    await until(() => pool.activeRequests === 0);
    mode = 'echo';
    expect(
      (await pool.request(target, 'GET', '/', {}, null)).body.toString(),
    ).toBe('ok');
  });
  it('honors peer stream capacity without queueing past the per-target session bound', async () => {
    configured({ maxSessionsPerTarget: 1 });
    mode = 'stall';
    const cancel = new AbortController();
    const first = pool.request(
      target,
      'GET',
      '/',
      {},
      null,
      1000,
      cancel.signal,
    );
    const rejected = expect(first).rejects.toMatchObject({ status: 499 });
    await until(() => received.length === 1);
    await expect(
      pool.request(target, 'GET', '/', {}, null),
    ).rejects.toMatchObject({ status: 503 });
    expect(pool.sessionCount).toBe(1);
    cancel.abort();
    await rejected;
  });
  it.each(['maxTargets', 'maxSessions'] as const)(
    'bounds %s across different target origins',
    async (limit) => {
      configured({ [limit]: 1 });
      await pool.request(target, 'GET', '/', {}, null);
      await expect(
        pool.request('http://127.0.0.1:1', 'GET', '/', {}, null),
      ).rejects.toMatchObject({ status: 503, fallbackSafe: false });
      expect(pool.targetCount).toBe(1);
    },
  );
  it('closes idle sockets and removes empty target entries, retaining active streams', async () => {
    configured({ idleTimeoutMs: 100 });
    mode = 'stall';
    const cancel = new AbortController();
    const first = pool.request(
      target,
      'GET',
      '/',
      {},
      null,
      1000,
      cancel.signal,
    );
    const rejected = expect(first).rejects.toMatchObject({ status: 499 });
    await until(() => received.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(pool.sessionCount).toBe(1);
    cancel.abort();
    await rejected;
    await until(() => pool.sessionCount === 0);
    expect(pool.targetCount).toBe(0);
    await until(() => sessions.size === 0);
  });
  it('bounds response bytes and recovers without replaying the rejected call', async () => {
    configured({ maxResponseBytes: 256 });
    mode = 'overflow';
    await expect(
      pool.request(target, 'POST', '/', {}, Buffer.from('mutation')),
    ).rejects.toMatchObject({
      status: 502,
      code: 'HTTP2_RESPONSE_TOO_LARGE',
      fallbackSafe: false,
    });
    await until(() => pool.activeRequests === 0);
    expect(received).toHaveLength(1);
    mode = 'echo';
    await pool.request(target, 'GET', '/', {}, null);
    expect(received).toHaveLength(2);
  });
  it('uses an absolute deadline despite continuously arriving response data', async () => {
    mode = 'trickle';
    const started = Date.now();
    await expect(
      pool.request(target, 'GET', '/', {}, null, 150),
    ).rejects.toMatchObject({ status: 504, fallbackSafe: false });
    expect(Date.now() - started).toBeLessThan(1000);
    await until(() => pool.activeRequests === 0);
  });
  it('rejects premature closure instead of hanging or treating it as a success', async () => {
    mode = 'early';
    await expect(
      pool.request(target, 'POST', '/', {}, Buffer.from('mutation')),
    ).rejects.toMatchObject({ status: 502, fallbackSafe: false });
    expect(received).toHaveLength(1);
    await until(() => pool.activeRequests === 0);
  });
  it('bounds request headers before allocating a session and bounds response headers', async () => {
    configured({ maxHeaderBytes: 1024 });
    await expect(
      pool.request(target, 'GET', '/', { 'x-large': 'x'.repeat(2000) }, null),
    ).rejects.toMatchObject({ status: 431 });
    expect(pool.sessionCount).toBe(0);
    mode = 'headers';
    await expect(
      pool.request(target, 'GET', '/', {}, null),
    ).rejects.toMatchObject({ status: 502, fallbackSafe: false });
  });
  it('marks HTTP/1 protocol negotiation failure safe before opening any application stream', async () => {
    let requests = 0;
    const plain = http.createServer((_req, res) => {
      requests++;
      res.end('http1');
    });
    extras.push(plain);
    const origin = await listen(plain);
    await expect(
      pool.request(origin, 'POST', '/', {}, Buffer.from('mutation')),
    ).rejects.toMatchObject({ status: 502, fallbackSafe: true });
    expect(requests).toBe(0);
    await until(() => pool.sessionCount === 0);
  });
  it('bounds a peer that accepts TCP but never sends SETTINGS', async () => {
    configured({ connectTimeoutMs: 100 });
    const sockets = new Set<net.Socket>();
    const stalled = net.createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.once('close', () => sockets.delete(socket));
    });
    extras.push(stalled);
    const origin = await listen(stalled);
    await expect(
      pool.request(origin, 'GET', '/', {}, null),
    ).rejects.toMatchObject({ status: 504, fallbackSafe: false });
    await until(() => sockets.size === 0);
    await until(() => pool.sessionCount === 0);
  });
  it('stops admission and cancels live streams during shutdown', async () => {
    mode = 'stall';
    const first = pool.request(target, 'GET', '/', {}, null);
    const rejected = expect(first).rejects.toMatchObject({
      status: 502,
      fallbackSafe: false,
    });
    await until(() => received.length === 1);
    pool.destroyAll();
    await rejected;
    await until(() => pool.activeRequests === 0 && pool.sessionCount === 0);
    await expect(
      pool.request(target, 'GET', '/', {}, null),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('does not reuse a session after GOAWAY', async () => {
    await pool.request(target, 'GET', '/', {}, null);
    await until(() => pool.activeRequests === 0);
    const existing = [...sessions][0];
    existing.goaway();
    await until(() => pool.sessionCount === 0);
    expect((await pool.request(target, 'GET', '/', {}, null)).statusCode).toBe(
      201,
    );
    expect(received).toHaveLength(2);
  });
  it('revokes pooled calls when a configuration removes the target', async () => {
    pool.destroyAll();
    let changed!: () => void;
    const unsubscribe = jest.fn();
    const manager = {
      getTenantId: () => 'tenant',
      getConfig: () => ({ services: [] }),
      subscribeConfig: (listener: () => void) => {
        changed = listener;
        return unsubscribe;
      },
    };
    pool = new Http2SessionPool(new ConfigService(), manager as never);
    pool.onModuleInit();
    mode = 'stall';
    const first = pool.request(target, 'GET', '/', {}, null);
    const rejected = expect(first).rejects.toMatchObject({
      status: 502,
      fallbackSafe: false,
    });
    await until(() => received.length === 1);
    changed();
    await rejected;
    await until(() => pool.sessionCount === 0 && pool.activeRequests === 0);
    pool.onModuleDestroy();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('rejects untrusted TLS without marking it eligible for protocol fallback', async () => {
    const base = resolve(__dirname, '../../../../../.local-work/t');
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(resolve(base, 'http2-tls-'));
    try {
      const key = resolve(directory, 'key.pem'),
        cert = resolve(directory, 'cert.pem');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore', timeout: 15000 },
      );
      let dispatched = 0;
      const secure = http2.createSecureServer({
        key: readFileSync(key),
        cert: readFileSync(cert),
      });
      secure.on('stream', (stream) => {
        dispatched++;
        stream.end();
      });
      extras.push(secure);
      const origin = (await listen(secure)).replace('http:', 'https:');
      await expect(
        pool.request(origin, 'POST', '/', {}, Buffer.from('mutation')),
      ).rejects.toMatchObject({ status: 502, fallbackSafe: false });
      expect(dispatched).toBe(0);
      await until(() => pool.sessionCount === 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
