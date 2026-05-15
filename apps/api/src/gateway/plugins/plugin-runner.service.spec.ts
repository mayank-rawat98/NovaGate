import type { ServerResponse } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { PluginRunnerService } from './plugin-runner.service';
import type { RouteConfig } from '@api-gateway/shared-types';

function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    req: {
      requestId: 'test-id',
      headers: {},
      method: 'GET',
    } as unknown as PluginContext['req'],
    res: {} as ServerResponse,
    route: {
      id: 'r1',
      method: 'GET',
      pathPattern: '/test',
      serviceId: 's1',
      authRequired: false,
      enabled: true,
    } as RouteConfig,
    service: undefined,
    tenantId: 'tenant-1',
    requestId: 'test-id',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('PluginRunnerService', () => {
  let runner: PluginRunnerService;

  beforeEach(() => {
    runner = new PluginRunnerService();
  });

  describe('runOnRequest', () => {
    it('returns void when no plugins have onRequest', async () => {
      const plugin: GatewayPlugin = { name: 'noop' };
      const result = await runner.runOnRequest([plugin], makeCtx());
      expect(result).toBeUndefined();
    });

    it('returns void when onRequest returns void', async () => {
      const plugin: GatewayPlugin = {
        name: 'pass',
        async onRequest() {
          return;
        },
      };
      const result = await runner.runOnRequest([plugin], makeCtx());
      expect(result).toBeUndefined();
    });

    it('short-circuits on first PluginShortCircuit', async () => {
      const sc: PluginShortCircuit = {
        status: 403,
        body: '{"error":"FORBIDDEN"}',
      };
      const first: GatewayPlugin = {
        name: 'first',
        async onRequest() {
          return sc;
        },
      };
      const second = { name: 'second', onRequest: jest.fn() };
      const result = await runner.runOnRequest(
        [first, second as unknown as GatewayPlugin],
        makeCtx(),
      );
      expect(result).toBe(sc);
      expect(second.onRequest).not.toHaveBeenCalled();
    });

    it('runs all plugins when none short-circuit', async () => {
      const calls: string[] = [];
      const a: GatewayPlugin = {
        name: 'a',
        async onRequest() {
          calls.push('a');
        },
      };
      const b: GatewayPlugin = {
        name: 'b',
        async onRequest() {
          calls.push('b');
        },
      };
      await runner.runOnRequest([a, b], makeCtx());
      expect(calls).toEqual(['a', 'b']);
    });

    it('returns 500 short-circuit when plugin throws', async () => {
      const bad: GatewayPlugin = {
        name: 'bad',
        async onRequest() {
          throw new Error('kaboom');
        },
      };
      const result = await runner.runOnRequest([bad], makeCtx());
      expect(result).toBeDefined();
      const sc = result as PluginShortCircuit;
      expect(sc.status).toBe(500);
      const body = JSON.parse(sc.body as string);
      expect(body.error).toBe('PLUGIN_ERROR');
    });

    it('does not run plugins after a throwing plugin', async () => {
      const bad: GatewayPlugin = {
        name: 'bad',
        async onRequest() {
          throw new Error('boom');
        },
      };
      const after = { name: 'after', onRequest: jest.fn() };
      await runner.runOnRequest(
        [bad, after as unknown as GatewayPlugin],
        makeCtx(),
      );
      expect(after.onRequest).not.toHaveBeenCalled();
    });

    it('respects plugin order from array', async () => {
      const order: number[] = [];
      const plugins: GatewayPlugin[] = [1, 2, 3].map((n) => ({
        name: `p${n}`,
        async onRequest() {
          order.push(n);
        },
      }));
      await runner.runOnRequest(plugins, makeCtx());
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('runOnResponse', () => {
    it('calls onResponse for all plugins', async () => {
      const calls: string[] = [];
      const a: GatewayPlugin = {
        name: 'a',
        async onResponse() {
          calls.push('a');
        },
      };
      const b: GatewayPlugin = {
        name: 'b',
        async onResponse() {
          calls.push('b');
        },
      };
      const ctx = { ...makeCtx(), statusCode: 200, headers: {} };
      await runner.runOnResponse([a, b], ctx);
      expect(calls).toEqual(['a', 'b']);
    });

    it('continues running when a plugin throws', async () => {
      const bad: GatewayPlugin = {
        name: 'bad',
        async onResponse() {
          throw new Error('x');
        },
      };
      const good = { name: 'good', onResponse: jest.fn() };
      const ctx = { ...makeCtx(), statusCode: 200, headers: {} };
      await expect(
        runner.runOnResponse([bad, good as unknown as GatewayPlugin], ctx),
      ).resolves.not.toThrow();
      expect(good.onResponse).toHaveBeenCalled();
    });
  });

  describe('runOnError', () => {
    it('returns void when no plugins have onError', async () => {
      const plugin: GatewayPlugin = { name: 'noop' };
      const ctx = { ...makeCtx(), error: new Error('downstream') };
      expect(await runner.runOnError([plugin], ctx)).toBeUndefined();
    });

    it('short-circuits on first returned PluginShortCircuit', async () => {
      const sc: PluginShortCircuit = { status: 503, body: 'unavailable' };
      const first: GatewayPlugin = {
        name: 'first',
        async onError() {
          return sc;
        },
      };
      const second = { name: 'second', onError: jest.fn() };
      const ctx = { ...makeCtx(), error: new Error('err') };
      const result = await runner.runOnError(
        [first, second as unknown as GatewayPlugin],
        ctx,
      );
      expect(result).toBe(sc);
      expect(second.onError).not.toHaveBeenCalled();
    });
  });
});
