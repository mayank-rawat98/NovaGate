import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { PluginContext } from '@api-gateway/shared-types';
import { createMockContext } from '@api-gateway/plugin-sdk';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginRunnerService } from '../plugin-runner.service';
import { PluginLoaderService } from './plugin-loader.service';

const examples = resolve(
  __dirname,
  '../../../../../../libs/plugin-sdk/examples',
);

describe('third-party plugin loading', () => {
  let directory: string;
  let disabled: string[] = [];
  const loaders: PluginLoaderService[] = [];

  function install(name: string, version: string, source: string) {
    const root = join(directory, 'node_modules', ...name.split('/'));
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js' }),
    );
    writeFileSync(join(root, 'index.js'), source);
  }
  function load(
    packages: Array<{ package: string; version: string }>,
    overrides: Partial<{
      hookTimeoutMs: number;
      failureThreshold: number;
      quarantineMs: number;
    }> = {},
  ) {
    const registry = new PluginRegistryService([
      { name: 'cors', onRequest: async () => undefined },
    ]);
    const loader = new PluginLoaderService(
      new ConfigService({
        thirdPartyPlugins: {
          directory,
          packages,
          hookTimeoutMs: 200,
          failureThreshold: 2,
          quarantineMs: 60000,
          ...overrides,
        },
      }) as never,
      registry,
      { getConfig: () => ({ disabledPlugins: disabled }) } as never,
    );
    loader.onModuleInit();
    loaders.push(loader);
    return { loader, registry };
  }
  const context = (headers: Record<string, string> = {}) =>
    createMockContext({
      headers,
      route: {
        plugins: [
          { name: '@novagate-examples/header-stamp', config: { value: 'v1' } },
        ],
      },
    }) as PluginContext;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'novagate-plugins-'));
    disabled = [];
    for (const example of ['header-stamp', 'crash-on-request'])
      cpSync(
        join(examples, example),
        join(directory, 'node_modules', '@novagate-examples', example),
        { recursive: true },
      );
  });
  afterEach(() => {
    for (const loader of loaders.splice(0)) loader.onApplicationShutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads pinned packages and runs their hooks through the plugin runner', async () => {
    const { loader, registry } = load([
      { package: '@novagate-examples/header-stamp', version: '1.0.0' },
    ]);
    const [plugin] = registry.resolve([
      { name: '@novagate-examples/header-stamp', config: { value: 'v1' } },
    ]);
    const ctx = context();
    expect(
      await new PluginRunnerService().runOnRequest([plugin], ctx),
    ).toBeUndefined();
    expect(ctx.req.headers['x-plugin-stamp']).toBe('v1');
    await plugin.onResponse?.({ ...ctx, statusCode: 200, headers: {} });
    expect(ctx.res.getHeader('x-plugin-stamp')).toBe('v1');
    expect(loader.statuses()).toEqual([
      {
        name: '@novagate-examples/header-stamp',
        package: '@novagate-examples/header-stamp',
        version: '1.0.0',
        state: 'active',
        protocols: ['http'],
        hooks: ['onRequest', 'onResponse'],
        failures: 0,
        lastError: null,
        quarantinedUntil: null,
      },
    ]);
  });

  it('marks unloadable packages failed and fails their routes closed', async () => {
    install(
      '@acme/wrong-version',
      '2.0.0',
      'module.exports = { name: "@acme/wrong-version", onRequest: async () => {} };',
    );
    install(
      '@acme/bad-export',
      '1.0.0',
      'module.exports = { name: "@acme/bad-export" };',
    );
    install('@acme/throws', '1.0.0', 'throw new Error("load\\nfailure")');
    install(
      '@acme/renamed',
      '1.0.0',
      'module.exports = { name: "@acme/other", onRequest: async () => {} };',
    );
    install(
      '@acme/collides',
      '1.0.0',
      'module.exports = { name: "cors", onRequest: async () => {} };',
    );
    const { loader, registry } = load([
      { package: '@acme/wrong-version', version: '1.0.0' },
      { package: '@acme/bad-export', version: '1.0.0' },
      { package: '@acme/throws', version: '1.0.0' },
      { package: '@acme/renamed', version: '1.0.0' },
      { package: '@acme/collides', version: '1.0.0' },
      { package: '@acme/missing', version: '1.0.0' },
    ]);
    const statuses = loader.statuses();
    expect(statuses.map((status) => [status.name, status.state])).toEqual(
      [
        '@acme/wrong-version',
        '@acme/bad-export',
        '@acme/throws',
        '@acme/renamed',
        '@acme/collides',
        '@acme/missing',
      ].map((name) => [name, 'failed']),
    );
    expect(statuses[0].lastError).toContain('does not match pinned 1.0.0');
    // Messages are single-line and never include stacks.
    expect(statuses[2].lastError).toBe('Error: load failure');
    expect(statuses.every((status) => !status.lastError?.includes('\n'))).toBe(
      true,
    );
    const [placeholder] = registry.resolve([
      { name: '@acme/missing', config: {} },
    ]);
    const result = await new PluginRunnerService().runOnRequest(
      [placeholder],
      context(),
    );
    expect(result).toMatchObject({ status: 503 });
    expect(JSON.parse(String(result && result.body)).error).toBe(
      'PLUGIN_UNAVAILABLE',
    );
    // The built-in plugin was not replaced.
    expect(registry.getRegisteredNames()).toContain('cors');
  });

  it('fails closed on throws and timeouts, then quarantines and recovers', async () => {
    const { loader, registry } = load(
      [{ package: '@novagate-examples/crash-on-request', version: '1.0.0' }],
      { quarantineMs: 1000 },
    );
    const [plugin] = registry.resolve([
      { name: '@novagate-examples/crash-on-request', config: {} },
    ]);
    const thrown = await plugin.onRequest?.(
      context({ 'x-crash-mode': 'throw' }),
    );
    expect(thrown).toMatchObject({ status: 502 });
    expect(JSON.parse(String(thrown && thrown.body)).error).toBe(
      'PLUGIN_FAILED',
    );
    const started = Date.now();
    const hung = await plugin.onRequest?.(context({ 'x-crash-mode': 'hang' }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hung).toMatchObject({ status: 502 });
    const status = loader.statuses()[0];
    expect(status).toMatchObject({ state: 'quarantined', failures: 2 });
    expect(status.lastError).toBe('Error: onRequest exceeded 200 ms');
    const blocked = await plugin.onRequest?.(context());
    expect(JSON.parse(String(blocked && blocked.body)).error).toBe(
      'PLUGIN_UNAVAILABLE',
    );
    await new Promise((done) => setTimeout(done, 1050));
    expect(await plugin.onRequest?.(context())).toBeUndefined();
    expect(loader.statuses()[0]).toMatchObject({
      state: 'active',
      failures: 0,
    });
  });

  it('attributes asynchronous crashes to the plugin by its installed path', async () => {
    const { loader } = load([
      { package: '@novagate-examples/crash-on-request', version: '1.0.0' },
    ]);
    const raw = require(
      join(directory, 'node_modules/@novagate-examples/crash-on-request'),
    );
    const error = await raw
      .onRequest(context({ 'x-crash-mode': 'throw' }))
      .catch((caught: Error) => caught);
    expect(loader.attributeCrash(error)).toBe(true);
    expect(loader.statuses()[0].state).toBe('quarantined');
    expect(loader.attributeCrash(new Error('gateway bug'))).toBe(false);
    expect(loader.attributeCrash('not an error')).toBe(false);
  });

  it('honours the workspace disabled list on every protocol path', async () => {
    const { loader, registry } = load([
      { package: '@novagate-examples/header-stamp', version: '1.0.0' },
    ]);
    const [plugin] = registry.resolve([
      { name: '@novagate-examples/header-stamp', config: { value: 'v1' } },
    ]);
    disabled = ['@novagate-examples/header-stamp'];
    const ctx = context();
    const result = await plugin.onRequest?.(ctx);
    expect(JSON.parse(String(result && result.body)).error).toBe(
      'PLUGIN_DISABLED',
    );
    expect(ctx.req.headers['x-plugin-stamp']).toBeUndefined();
    await plugin.onResponse?.({ ...ctx, statusCode: 200, headers: {} });
    expect(ctx.res.getHeader('x-plugin-stamp')).toBeUndefined();
    expect(loader.statuses()[0].state).toBe('disabled');
  });

  it('does nothing without a configured directory', () => {
    const registry = new PluginRegistryService([]);
    const loader = new PluginLoaderService(
      new ConfigService({
        thirdPartyPlugins: { directory: null, packages: [] },
      }) as never,
      registry,
      { getConfig: () => undefined } as never,
    );
    loader.onModuleInit();
    expect(loader.statuses()).toEqual([]);
  });
});
