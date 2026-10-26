import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { readFileSync as read } from 'node:fs';
import type { TenantConfig, WasmPluginState } from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { RoutesController } from '../proxy-config/routes.controller';
import { ServicesController } from '../proxy-config/services.controller';
import { WasmPluginsController } from './wasm-plugins.controller';
import { WasmPluginsService } from './wasm-plugins.service';
import { WASM_CATALOG } from './catalog.generated';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
integration('WebAssembly plugins on actual PostgreSQL, Redis and HTTP', () => {
  const secret = 'wasm-fixture-secret-longer-than-32-characters-x';
  const previous = {
    secret: process.env.PLATFORM_JWT_SECRET,
    redis: process.env.REDIS_URL,
  };
  const database = `novagate_wasm_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let push: ConfigPushService, subscriber: Redis;
  const published: Array<{
    tenantId: string;
    config: TenantConfig;
    version: number;
  }> = [];
  const tenants: string[] = [];

  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = secret;
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${database}`;
    db = new DataSource({ type: 'postgres', url: url.toString() });
    await db.initialize();
    await db.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    await new MigrationService(db).onModuleInit();
    subscriber = new Redis(process.env.TEST_REDIS_URL as string);
    await subscriber.subscribe('config.update');
    subscriber.on('message', (_channel, message) => {
      const payload = JSON.parse(message);
      if (tenants.includes(payload.tenantId)) published.push(payload);
    });
    push = new ConfigPushService(db);
    push.onModuleInit();
    const module = await Test.createTestingModule({
      controllers: [
        WasmPluginsController,
        RoutesController,
        ServicesController,
      ],
      providers: [
        WasmPluginsService,
        { provide: DataSource, useValue: db },
        { provide: ConfigPushService, useValue: push },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication({
      logger: ['error'],
      forceCloseConnections: true,
    });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await push?.onModuleDestroy();
    subscriber?.disconnect();
    for (const tenant of tenants) {
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      for (const table of [
        'api_keys',
        'pending_config_updates',
        'gateway_instances',
      ])
        await db.query(`DELETE FROM public.${table} WHERE "tenantId"=$1`, [
          tenant,
        ]);
      await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
    }
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
    for (const [key, value] of [
      ['PLATFORM_JWT_SECRET', previous.secret],
      ['REDIS_URL', previous.redis],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  async function workspace() {
    const tenant = randomUUID();
    tenants.push(tenant);
    await db.query(
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'WASM fixture',$2,'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    return tenant;
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  const fixture = (name: string) =>
    read(
      resolve(
        __dirname,
        `../../../../libs/plugin-sdk/wasm/fixtures/${name}.wasm`,
      ),
    );
  async function call<T>(
    path: string,
    tenant: string,
    init: { method?: string; body?: unknown; auth?: string } = {},
  ) {
    const response = await fetch(`${base}/tenants/${tenant}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: init.auth ?? session(tenant),
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  const waitPublished = async (tenant: string, count: number) => {
    const deadline = Date.now() + 5000;
    while (
      published.filter((p) => p.tenantId === tenant).length < count &&
      Date.now() < deadline
    )
      await new Promise((done) => setTimeout(done, 20));
    return published.filter((p) => p.tenantId === tenant);
  };

  it('ships a catalog whose embedded modules match their digests', () => {
    expect(WASM_CATALOG.map((entry) => entry.id)).toEqual([
      'header-stamp',
      'require-header',
      'header-blocklist',
    ]);
    for (const entry of WASM_CATALOG) {
      const bytes = Buffer.from(entry.module, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.sha256,
      );
      expect(bytes.length).toBe(entry.size);
      // Committed builds match the embedded catalog.
      expect(
        read(
          resolve(
            __dirname,
            `../../../../libs/plugin-sdk/wasm/catalog/${entry.id}.wasm`,
          ),
        ).equals(bytes),
      ).toBe(true);
    }
  });

  it('installs from the catalog and publishes metadata without the module bytes', async () => {
    const tenant = await workspace();
    const empty = await call<WasmPluginState>('/wasm-plugins', tenant);
    expect(empty.status).toBe(200);
    expect(empty.body.plugins).toEqual([]);
    expect(
      empty.body.catalog.map((entry) => [entry.id, entry.installed]),
    ).toEqual([
      ['header-stamp', false],
      ['require-header', false],
      ['header-blocklist', false],
    ]);
    const installed = await call<WasmPluginState>(
      '/wasm-plugins/install',
      tenant,
      {
        method: 'POST',
        body: { catalogId: 'header-stamp' },
      },
    );
    expect(installed.status).toBe(200);
    expect(installed.body.plugins).toEqual([
      expect.objectContaining({
        name: 'header-stamp',
        source: 'catalog',
        catalogId: 'header-stamp',
        hooks: expect.arrayContaining(['on_request', 'on_response']),
      }),
    ]);
    expect(installed.body.catalog[0].installed).toBe(true);
    const [publication] = await waitPublished(tenant, 1);
    expect(publication.config.wasmPlugins).toEqual([
      {
        name: 'header-stamp',
        sha256: WASM_CATALOG[0].sha256,
        hooks: expect.arrayContaining(['on_request', 'on_response']),
        allowedHosts: [],
      },
    ]);
    expect(JSON.stringify(publication)).not.toContain(
      WASM_CATALOG[0].module.slice(0, 40),
    );
    // Installing the same name twice is refused.
    expect(
      (
        await call('/wasm-plugins/install', tenant, {
          method: 'POST',
          body: { catalogId: 'header-stamp' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('/wasm-plugins/install', tenant, {
          method: 'POST',
          body: { catalogId: 'nope' },
        })
      ).status,
    ).toBe(400);
  });

  it('validates uploads with the sandbox rules', async () => {
    const tenant = await workspace();
    const upload = (body: Record<string, unknown>) =>
      call<{ message?: string }>('/wasm-plugins/upload', tenant, {
        method: 'POST',
        body,
      });
    const good = {
      name: 'echo',
      version: '1.0.0',
      module: fixture('echo').toString('base64'),
    };
    const refused = await upload({
      ...good,
      name: 'fs',
      module: fixture('wasi-fs').toString('base64'),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('wasi_snapshot_preview1.path_open');
    expect(
      (
        await upload({
          ...good,
          module: fixture('own-memory').toString('base64'),
        })
      ).status,
    ).toBe(400);
    expect((await upload({ ...good, name: 'Echo' })).status).toBe(400);
    expect((await upload({ ...good, version: 'latest' })).status).toBe(400);
    expect(
      (await upload({ ...good, allowedHosts: ['https://x.test'] })).status,
    ).toBe(400);
    expect((await upload({ ...good, module: 'not base64!' })).status).toBe(400);
    expect((await upload({ ...good, extra: true })).status).toBe(400);
    const ok = await upload({
      ...good,
      allowedHosts: ['api.partner.test', 'hooks.test:8443'],
    });
    expect(ok.status).toBe(200);
    // Session-only: automation tokens cannot install code.
    expect(
      (
        await call('/wasm-plugins/upload', tenant, {
          method: 'POST',
          body: good,
          auth: 'Bearer ngat_x',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses to remove a plugin that a route uses, then removes it', async () => {
    const tenant = await workspace();
    await call('/wasm-plugins/install', tenant, {
      method: 'POST',
      body: { catalogId: 'require-header' },
    });
    const service = await call<{ id: string }>('/services', tenant, {
      method: 'POST',
      body: {
        name: 'api',
        targets: [{ url: 'http://127.0.0.1:9', weight: 1 }],
      },
    });
    const route = await call<{ id: string }>('/routes', tenant, {
      method: 'POST',
      body: {
        method: 'GET',
        pathPattern: '/secure',
        serviceId: service.body.id,
        plugins: [
          { name: 'wasm:require-header', config: { header: 'x-token' } },
        ],
      },
    });
    expect(route.status).toBe(201);
    const blocked = await call<{ message: string }>(
      '/wasm-plugins/require-header',
      tenant,
      { method: 'DELETE' },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('GET /secure');
    await call(`/routes/${route.body.id}`, tenant, { method: 'DELETE' });
    const removed = await call<WasmPluginState>(
      '/wasm-plugins/require-header',
      tenant,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.plugins).toEqual([]);
    expect((await push.assembleConfig(tenant)).wasmPlugins).toEqual([]);
    expect(
      (await call('/wasm-plugins/require-header', tenant, { method: 'DELETE' }))
        .status,
    ).toBe(404);
    // Invalid wasm route names are refused.
    expect(
      (
        await call('/routes', tenant, {
          method: 'POST',
          body: {
            method: 'GET',
            pathPattern: '/x',
            serviceId: service.body.id,
            plugins: [{ name: 'wasm:Bad', config: {} }],
          },
        })
      ).status,
    ).toBe(400);
  });
});
