import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import type {
  BaseWsMessage,
  PluginContext,
  TenantConfig,
} from '@api-gateway/shared-types';
import { PluginRegistryService } from '../plugin-registry.service';
import { WasmPluginService } from './wasm-plugin.service';
import type { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service';
import type { ControlPlaneConnectorService } from '../../connector/control-plane-connector.service';

const redisUrl = process.env.TEST_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const bytes = readFileSync(
  resolve(
    __dirname,
    '../../../../../../libs/plugin-sdk/wasm/fixtures/echo.wasm',
  ),
);
const sha256 = createHash('sha256').update(bytes).digest('hex');

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

function context(): PluginContext {
  return {
    req: {
      method: 'GET',
      url: '/orders?x=1',
      headers: { 'x-input': 'hi', 'x-remove-me': '1' },
      requestId: 'r',
    } as unknown as PluginContext['req'],
    res: {
      headersSent: false,
      setHeader: jest.fn(),
    } as unknown as PluginContext['res'],
    route: {
      id: 'route',
      method: 'GET',
      pathPattern: '/orders',
      serviceId: 'service',
      enabled: true,
      authRequired: false,
      plugins: [{ name: 'wasm:echo', config: {} }],
    },
    service: undefined,
    tenantId: 'tenant',
    requestId: 'r',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

integration('WasmPluginService with real Redis', () => {
  const redis = new Redis(`${redisUrl}/9`);
  const services: WasmPluginService[] = [];
  afterAll(async () => {
    for (const service of services) await service.onModuleDestroy();
    await redis.flushdb();
    redis.disconnect();
  });

  function start(config: Partial<TenantConfig>) {
    let current = {
      routes: [],
      services: [],
      consumers: [],
      ...config,
    } as TenantConfig;
    const configListeners = new Set<() => void>();
    const messageListeners = new Map<string, (m: BaseWsMessage) => void>();
    const sent: BaseWsMessage[] = [];
    const registry = new PluginRegistryService(undefined as never);
    const service = new WasmPluginService(
      new ConfigService({}),
      registry,
      {
        getConfig: () => current,
        subscribeConfig: (listener: () => void) => {
          configListeners.add(listener);
          return () => configListeners.delete(listener);
        },
      } as unknown as GatewayConfigManagerService,
      {
        onMessage: (type: string, listener: (m: BaseWsMessage) => void) => {
          messageListeners.set(type, listener);
          return () => messageListeners.delete(type);
        },
        onAuthenticated: () => () => undefined,
        sendTransient: (message: BaseWsMessage) => {
          sent.push(message);
          return true;
        },
      } as unknown as ControlPlaneConnectorService,
      redis,
    );
    services.push(service);
    service.onModuleInit();
    return {
      service,
      registry,
      sent,
      deliver: (module: string | null, digest = sha256) =>
        messageListeners.get('wasm.module')?.({
          type: 'wasm.module' as never,
          payload: { sha256: digest, module },
        }),
      setConfig(next: Partial<TenantConfig>) {
        current = { ...current, ...next };
        for (const listener of configListeners) listener();
      },
    };
  }
  const plugin = {
    name: 'echo',
    sha256,
    hooks: ['on_request' as const],
    allowedHosts: [],
  };

  it('fetches by digest, refuses tampered bytes and runs the verified module', async () => {
    await redis.flushdb();
    const gateway = start({ wasmPlugins: [plugin] });
    await until(
      () => gateway.sent.some((m) => m.type === ('wasm.fetch' as never)),
      'fetch',
    );
    expect(
      gateway.sent.find((m) => m.type === ('wasm.fetch' as never))?.payload,
    ).toEqual({ sha256 });
    // Until the module arrives, routes using it fail closed.
    const [waiting] = gateway.registry.resolve([
      { name: 'wasm:echo', config: {} },
    ]);
    expect((await waiting.onRequest?.(context()))?.status).toBe(503);

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 1;
    gateway.deliver(tampered.toString('base64'));
    await until(
      () => gateway.service.statuses()[0]?.state === 'failed',
      'refused',
    );
    expect(gateway.service.statuses()[0].lastError).toContain('digest');

    gateway.deliver(bytes.toString('base64'));
    await until(
      () => gateway.service.statuses()[0]?.state === 'active',
      'active',
    );
    const [active] = gateway.registry.resolve([
      { name: 'wasm:echo', config: {} },
    ]);
    const ctx = context();
    expect(await active.onRequest?.(ctx)).toBeUndefined();
    expect(ctx.req.headers).toMatchObject({
      'x-echo-method': 'GET',
      'x-echo-path': '/orders',
      'x-echo-input': 'hi',
    });
    expect(ctx.req.headers['x-remove-me']).toBeUndefined();
    expect(gateway.service.statuses()[0]).toMatchObject({
      calls: 1,
      failures: 0,
    });
    expect(gateway.service.statuses()[0].p99Us).toBeLessThan(50000);
    expect(await redis.get(`wasm:${sha256}`)).toBe(bytes.toString('base64'));

    // Removed from configuration: routes still naming it fail closed.
    gateway.setConfig({ wasmPlugins: [] });
    await until(() => gateway.service.statuses().length === 0, 'removed');
    const [removed] = gateway.registry.resolve([
      { name: 'wasm:echo', config: {} },
    ]);
    expect((await removed.onRequest?.(context()))?.status).toBe(503);
  });

  it('starts from the local Redis cache without the control plane', async () => {
    const gateway = start({ wasmPlugins: [plugin] });
    await until(
      () => gateway.service.statuses()[0]?.state === 'active',
      'cached',
    );
    expect(gateway.sent.some((m) => m.type === ('wasm.fetch' as never))).toBe(
      false,
    );
  });

  it('never resolves an unknown wasm plugin to nothing', async () => {
    const gateway = start({});
    const [unknown] = gateway.registry.resolve([
      { name: 'wasm:missing', config: {} },
    ]);
    expect((await unknown.onRequest?.(context()))?.status).toBe(503);
    expect(() =>
      gateway.registry.resolve([{ name: 'wasm:Bad', config: {} }]),
    ).toThrow();
  });
});
