import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { inspectWasmModule } from '@api-gateway/shared-types';
import { WasmSandbox, type WasmSandboxSettings } from './wasm-sandbox';

const fixture = (name: string) =>
  readFileSync(
    resolve(
      __dirname,
      `../../../../../../libs/plugin-sdk/wasm/fixtures/${name}.wasm`,
    ),
  );
const settings: WasmSandboxSettings = {
  timeoutMs: 50,
  workers: 1,
  maxQueue: 8,
  allowHttp: true,
};
const request = {
  method: 'POST',
  path: '/orders/7',
  headers: { 'x-input': 'hello', 'x-remove-me': 'gone', host: 'api.test' },
  consumerId: '0b2c6a52-4a8a-4f7a-9c4e-2d6f1c0e9a11',
};
const sandboxes: WasmSandbox[] = [];
async function sandbox(
  name: string,
  overrides: Partial<WasmSandboxSettings> = {},
  allowedHosts: string[] = [],
) {
  const bytes = fixture(name);
  const created = new WasmSandbox(
    await WebAssembly.compile(bytes),
    inspectWasmModule(bytes),
    allowedHosts,
    { ...settings, ...overrides },
  );
  sandboxes.push(created);
  return created;
}
afterEach(async () => {
  for (const created of sandboxes.splice(0)) await created.close();
});

describe('WebAssembly module inspection', () => {
  it('refuses WASI filesystem imports and modules with their own memory', () => {
    expect(() => inspectWasmModule(fixture('wasi-fs'))).toThrow(
      'wasi_snapshot_preview1.path_open is not available',
    );
    expect(() => inspectWasmModule(fixture('own-memory'))).toThrow(
      'must import their memory',
    );
    expect(() => inspectWasmModule(Buffer.from('not wasm'))).toThrow();
    expect(() => inspectWasmModule(Buffer.alloc(1048577))).toThrow(
      'limited to',
    );
  });

  it('reports hooks, imported memory and host functions', () => {
    expect(inspectWasmModule(fixture('echo'))).toMatchObject({
      hooks: expect.arrayContaining(['on_request', 'on_response']),
      memory: { initial: 2, maximum: null },
    });
  });
});

describe('WasmSandbox', () => {
  it('runs hooks well under 50 ms with only host-function access', async () => {
    const echo = await sandbox('echo');
    // The first call includes thread start; measure warm calls.
    await echo.run('on_request', { request, config: {} });
    const started = performance.now();
    const result = await echo.run('on_request', { request, config: {} });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(50);
    expect(result.elapsedUs).toBeLessThan(50000);
    expect(result.actions).toEqual({
      setRequestHeaders: {
        'x-echo-method': 'POST',
        'x-echo-path': '/orders/7',
        'x-echo-input': 'hello',
        'x-echo-consumer': request.consumerId,
        // The host header is restricted: the setter returned -1.
        'x-echo-restricted': 'r',
      },
      removeRequestHeaders: ['x-remove-me'],
      setResponseHeaders: {},
      respond: null,
    });
    expect(result.logs).toEqual([{ level: 'info', message: 'echo ran' }]);
    const response = await echo.run('on_response', {
      request,
      config: {},
      status: 201,
    });
    expect(response.actions.setResponseHeaders).toEqual({
      'x-echo-status': '201',
    });
  });

  it('terminates a runaway module at its deadline and keeps serving', async () => {
    const loop = await sandbox('loop');
    const echo = await sandbox('echo');
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      await expect(
        loop.run('on_request', { request, config: {} }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      // Deadline plus thread start on the first call.
      expect(performance.now() - started).toBeLessThan(i ? 300 : 2000);
    }
    await expect(
      echo.run('on_request', { request, config: {} }),
    ).resolves.toBeTruthy();
  });

  it('caps memory at 10 MiB', async () => {
    const grow = await sandbox('grow');
    const result = await grow.run('on_request', { request, config: {} });
    // 200 more pages would pass 160; one more page succeeds from 2.
    expect(result.actions.setRequestHeaders).toEqual({
      'x-grow-200': '-1',
      'x-grow-1': '2',
    });
  });

  it('reports traps as failures', async () => {
    const trap = await sandbox('trap');
    await expect(
      trap.run('on_request', { request, config: {} }),
    ).rejects.toMatchObject({ code: 'TRAP' });
  });

  it('bounds queued calls', async () => {
    const loop = await sandbox('loop', { maxQueue: 1, timeoutMs: 200 });
    const first = loop.run('on_request', { request, config: {} });
    const second = loop.run('on_request', { request, config: {} });
    await expect(
      loop.run('on_request', { request, config: {} }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    await expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(second).rejects.toMatchObject({ code: 'TIMEOUT' });
  }, 10000);

  describe('http_get', () => {
    let server: http.Server;
    let origin: string;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/slow') setTimeout(() => res.end('late'), 500);
        else res.end('pong from allowlisted host\nsecond line');
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });

    it('calls allowlisted hosts only', async () => {
      const allowed = await sandbox('http', { timeoutMs: 1000 }, [origin]);
      const ok = await allowed.run('on_request', {
        request,
        config: { url: `http://${origin}/ping` },
      });
      expect(ok.actions.setRequestHeaders).toEqual({
        'x-http-status': '200',
        'x-http-body': 'pong from allowlisted host',
      });
      const refused = await allowed.run('on_request', {
        request,
        config: { url: 'http://169.254.169.254/latest/meta-data' },
      });
      expect(refused.actions.setRequestHeaders).toEqual({
        'x-http-status': '-1',
      });
    });

    it('requires HTTPS unless the operator allows HTTP', async () => {
      const strict = await sandbox('http', { allowHttp: false }, [origin]);
      const refused = await strict.run('on_request', {
        request,
        config: { url: `http://${origin}/ping` },
      });
      expect(refused.actions.setRequestHeaders['x-http-status']).toBe('-1');
    });

    it('keeps calls within the plugin deadline', async () => {
      const slow = await sandbox('http', { timeoutMs: 100 }, [origin]);
      await slow.run('on_request', { request, config: {} });
      const started = performance.now();
      const outcome = await slow
        .run('on_request', {
          request,
          config: { url: `http://${origin}/slow` },
        })
        .then((result) => result.actions.setRequestHeaders['x-http-status'])
        .catch((error) => error.code);
      expect(['-2', 'TIMEOUT']).toContain(outcome);
      expect(performance.now() - started).toBeLessThan(400);
    });
  });
});
