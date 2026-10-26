import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import { once } from 'node:events';
import { IdentityProviderService } from './identity-provider.service';
import type { IdentityProviderSettings } from '../../../config/configuration';

function make(settings: Partial<IdentityProviderSettings> = {}) {
  return new IdentityProviderService(
    new ConfigService({
      identityProvider: {
        allowInsecureHttp: true,
        timeoutMs: 1000,
        ...settings,
      },
    }),
  );
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('bounded identity-provider network and admission', () => {
  let server: http.Server;
  let provider: IdentityProviderService;
  let base: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  beforeEach(async () => {
    provider = make();
    handler = (_req, res) => res.end('{"ok":true}');
    server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    provider.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('requires HTTPS by default and rejects userinfo, fragments and other protocols', async () => {
    const secure = new IdentityProviderService(new ConfigService());
    await expect(secure.requestJson(base)).rejects.toThrow();
    for (const url of [
      'https://user:secret@example.com',
      'https://example.com/#fragment',
      'file:///tmp/file',
    ])
      expect(() => secure.endpoint(url)).toThrow();
    expect(secure.endpoint('https://example.com/jwks').protocol).toBe('https:');
    secure.onModuleDestroy();
  });
  it('accepts bounded JSON and releases network capacity', async () => {
    expect(await provider.requestJson(base)).toEqual({ ok: true });
    await pause(10);
    expect(provider.activeFetches).toBe(0);
  });
  it.each(['[]', 'null', 'broken', '"string"'])(
    'rejects non-object JSON %s',
    async (body) => {
      handler = (_req, res) => res.end(body);
      await expect(provider.requestJson(base)).rejects.toThrow();
    },
  );
  it('rejects redirects without sending credentials to the redirect destination', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      res.writeHead(302, { location: base + '/other' });
      res.end();
    };
    await expect(
      provider.requestJson(base, { body: 'client_secret=fixture' }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it.each([true, false])(
    'limits declared and chunked response bytes (declared=%s)',
    async (declared) => {
      provider = make({ maxResponseBytes: 1024 });
      handler = (_req, res) => {
        if (declared) res.setHeader('content-length', '4096');
        res.write(' '.repeat(2048));
        res.end('{}');
      };
      await expect(provider.requestJson(base)).rejects.toThrow();
    },
  );
  it('limits upstream response headers', async () => {
    provider = make({ maxHeaderBytes: 1024 });
    handler = (_req, res) => {
      res.setHeader('x-huge', 'a'.repeat(4096));
      res.end('{}');
    };
    await expect(provider.requestJson(base)).rejects.toThrow();
  });
  it('uses an absolute deadline even while response data trickles', async () => {
    provider = make({ timeoutMs: 100 });
    handler = (_req, res) => {
      res.write('{');
      const timer = setInterval(() => res.write(' '), 10);
      res.once('close', () => clearInterval(timer));
    };
    const start = Date.now();
    await expect(provider.requestJson(base)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
    await pause(20);
    expect(provider.activeFetches).toBe(0);
  });
  it('rejects excess fetches and cancels sockets on shutdown', async () => {
    provider = make({ maxConcurrentFetches: 1, timeoutMs: 1000 });
    handler = (_req, res) => res.write('{');
    const first = provider.requestJson(base);
    const rejection = expect(first).rejects.toThrow();
    await expect(provider.requestJson(base)).rejects.toThrow('capacity');
    provider.onModuleDestroy();
    await rejection;
    await pause(20);
    expect(provider.activeFetches).toBe(0);
  });
  it('coalesces requests without letting one caller cancel another', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      setTimeout(() => res.end('{}'), 20);
    };
    const abort = new AbortController();
    const work = (signal: AbortSignal) =>
      provider.requestJson(base, { signal });
    const first = provider.coalesce('same', work, abort.signal);
    const rejection = expect(first).rejects.toThrow();
    const second = provider.coalesce('same', work);
    abort.abort();
    await rejection;
    expect(await second).toEqual({});
    expect(calls).toBe(1);
    expect(provider.occupiedAdmissions).toBe(0);
  });
  it('retains admission for unabortable work until it settles', async () => {
    provider = make({ maxPendingRequests: 1, timeoutMs: 100 });
    let resolve!: (value: number) => void;
    const pending = provider.coalesce(
      'stalled',
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    await expect(pending).rejects.toThrow();
    expect(provider.occupiedAdmissions).toBe(1);
    await expect(provider.coalesce('another', async () => 1)).rejects.toThrow(
      'capacity',
    );
    resolve(1);
    await pause(0);
    expect(provider.occupiedAdmissions).toBe(0);
    expect(await provider.coalesce('another', async () => 2)).toBe(2);
  });
  it('aborts shared work when the last caller leaves and never caches its result', async () => {
    const abort = new AbortController();
    let signal!: AbortSignal;
    const pending = provider.coalesce(
      'key',
      async (shared) => {
        signal = shared;
        await pause(20);
        provider.putCached('key', true, 1000, shared);
        return true;
      },
      abort.signal,
    );
    const rejection = expect(pending).rejects.toThrow();
    await pause(0);
    abort.abort();
    await rejection;
    expect(signal.aborted).toBe(true);
    await pause(30);
    expect(provider.cacheSize).toBe(0);
  });
  it('evicts expired and least-recently-used entries under a fixed cache cap', async () => {
    provider = make({ maxCacheEntries: 2 });
    provider.putCached('a', 1, 1000);
    provider.putCached('b', 2, 1000);
    expect(provider.getCached('a')).toBe(1);
    provider.putCached('c', 3, 1);
    expect(provider.getCached('b')).toBeUndefined();
    expect(provider.cacheSize).toBe(2);
    await pause(5);
    expect(provider.getCached('c')).toBeUndefined();
    expect(provider.cacheSize).toBe(1);
  });
});
