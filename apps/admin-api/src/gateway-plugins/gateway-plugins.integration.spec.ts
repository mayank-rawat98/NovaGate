import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type {
  ConfigPreview,
  CreatedAutomationToken,
  GatewayPluginState,
  TenantConfig,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { ServicesController } from '../proxy-config/services.controller';
import { RoutesController } from '../proxy-config/routes.controller';
import { ConfigImportController } from '../config-import/config-import.controller';
import { ConfigImportService } from '../config-import/config-import.service';
import { configureConfigImportParser } from '../config-import/config-import.body-parser';
import { AutomationTokensController } from '../automation-tokens/automation-tokens.controller';
import { AutomationTokensService } from '../automation-tokens/automation-tokens.service';
import { catalogRoute } from '../portal/portal-catalog';
import { GatewayPluginsController } from './gateway-plugins.controller';
import { GatewayPluginsService } from './gateway-plugins.service';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
integration(
  'Third-party gateway plugins on actual PostgreSQL, Redis and HTTP',
  () => {
    const secret = 'gateway-plugins-fixture-secret-longer-than-32-chars';
    const previous = {
      secret: process.env.PLATFORM_JWT_SECRET,
      redis: process.env.REDIS_URL,
    };
    const database = `novagate_plugins_${randomUUID().replaceAll('-', '')}`;
    let root: DataSource, db: DataSource, app: INestApplication, base: string;
    let push: ConfigPushService, redis: Redis, subscriber: Redis;
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
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        extra: { max: 16, connectionTimeoutMillis: 3000 },
      });
      await db.initialize();
      await db.query(
        readFileSync(
          resolve(__dirname, '../../../../docker/postgres-init.sql'),
          'utf8',
        ),
      );
      await new MigrationService(db).onModuleInit();
      redis = new Redis(process.env.TEST_REDIS_URL as string);
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
          GatewayPluginsController,
          AutomationTokensController,
          ServicesController,
          RoutesController,
          ConfigImportController,
        ],
        providers: [
          GatewayPluginsService,
          AutomationTokensService,
          ConfigImportService,
          { provide: DataSource, useValue: db },
          { provide: ConfigPushService, useValue: push },
          { provide: APP_GUARD, useClass: TenantAuthGuard },
        ],
      }).compile();
      app = module.createNestApplication({
        logger: ['error'],
        forceCloseConnections: true,
      });
      configureConfigImportParser(app);
      app.setGlobalPrefix('api');
      await app.listen(0, '127.0.0.1');
      base = `${await app.getUrl()}/api`;
    }, 30000);

    afterEach(async () => {
      for (const tenant of tenants.splice(0)) {
        await redis.del(`gw:plugins:${tenant}`);
        await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
        for (const statement of [
          'DELETE FROM public.automation_tokens WHERE tenant_id=$1',
          'DELETE FROM public.api_keys WHERE "tenantId"=$1',
          'DELETE FROM public.pending_config_updates WHERE "tenantId"=$1',
        ])
          await db.query(statement, [tenant]);
        await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
      }
      published.splice(0);
    });

    afterAll(async () => {
      await app?.close();
      await push?.onModuleDestroy();
      subscriber?.disconnect();
      redis?.disconnect();
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
        `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Plugin fixture',$2,'free')`,
        [tenant, `${tenant}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(tenant);
      return tenant;
    }
    const session = (tenant: string) =>
      `Bearer ${sign({ sub: tenant }, secret)}`;
    async function call<T = unknown>(
      path: string,
      authorization: string,
      init: { method?: string; body?: unknown; type?: string } = {},
    ) {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization,
          ...(init.body === undefined
            ? {}
            : { 'content-type': init.type ?? 'application/json' }),
        },
        body:
          init.body === undefined
            ? undefined
            : typeof init.body === 'string'
              ? init.body
              : JSON.stringify(init.body),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // YAML exports stay text.
      }
      return {
        status: response.status,
        headers: response.headers,
        body: body as T,
      };
    }
    const status = {
      name: '@acme/stamp',
      package: '@acme/stamp',
      version: '1.0.0',
      state: 'active',
      protocols: ['http'],
      hooks: ['onRequest', 'onResponse'],
      failures: 0,
      lastError: null,
      quarantinedUntil: null,
    };

    it('reports the gateway plugin state and ignores missing or corrupt reports', async () => {
      const tenant = await workspace();
      const empty = await call<GatewayPluginState>(
        `/tenants/${tenant}/gateway-plugins`,
        session(tenant),
      );
      expect(empty.status).toBe(200);
      expect(empty.headers.get('cache-control')).toBe('no-store');
      expect(empty.body).toEqual({
        reportedAt: null,
        plugins: [],
        disabled: [],
      });
      const reportedAt = new Date().toISOString();
      await redis.set(
        `gw:plugins:${tenant}`,
        JSON.stringify({ reportedAt, plugins: [status] }),
        'EX',
        60,
      );
      expect(
        (await call(`/tenants/${tenant}/gateway-plugins`, session(tenant)))
          .body,
      ).toEqual({
        reportedAt,
        plugins: [status],
        disabled: [],
      });
      for (const corrupt of [
        'not json',
        JSON.stringify({
          reportedAt,
          plugins: [{ ...status, state: 'bogus' }],
        }),
        JSON.stringify({ reportedAt: 'yesterday', plugins: [status] }),
      ]) {
        await redis.set(`gw:plugins:${tenant}`, corrupt, 'EX', 60);
        expect(
          (await call(`/tenants/${tenant}/gateway-plugins`, session(tenant)))
            .body,
        ).toEqual(empty.body);
      }
      // Another workspace never sees this one's report.
      const other = await workspace();
      expect(
        (await call(`/tenants/${tenant}/gateway-plugins`, session(other)))
          .status,
      ).toBe(403);
    });

    it('persists the disabled list, pushes it to the gateway and skips no-op saves', async () => {
      const tenant = await workspace();
      const save = (disabled: unknown) =>
        call<GatewayPluginState>(
          `/tenants/${tenant}/gateway-plugins`,
          session(tenant),
          {
            method: 'PUT',
            body: { disabled },
          },
        );
      const saved = await save(['@b/x', '@a/y']);
      expect(saved.status).toBe(200);
      expect(saved.body.disabled).toEqual(['@a/y', '@b/x']);
      const [{ gatewayConfigVersion }] = await db.query(
        `SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1`,
        [tenant],
      );
      const [pending] = await db.query(
        `SELECT config FROM public.pending_config_updates WHERE "tenantId"=$1`,
        [tenant],
      );
      expect(pending.config.version).toBe(gatewayConfigVersion);
      expect(pending.config.config.disabledPlugins).toEqual(['@a/y', '@b/x']);
      for (let i = 0; i < 100 && !published.length; i++)
        await new Promise((done) => setTimeout(done, 20));
      expect(published.length).toBeGreaterThan(0);
      // The durable retry loop may redeliver the same version; never another.
      for (const payload of published)
        expect(payload).toMatchObject({
          tenantId: tenant,
          version: gatewayConfigVersion,
          config: { disabledPlugins: ['@a/y', '@b/x'] },
        });
      // Same set in another order: no new configuration version.
      expect((await save(['@a/y', '@b/x'])).status).toBe(200);
      const [after] = await db.query(
        `SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1`,
        [tenant],
      );
      expect(after.gatewayConfigVersion).toBe(gatewayConfigVersion);
      expect((await save([])).body.disabled).toEqual([]);

      for (const invalid of [
        ['cors'],
        ['@a/y', '@a/y'],
        Array.from({ length: 17 }, (_, i) => `@a/p${i}`),
        '@a/y',
        [42],
      ])
        expect((await save(invalid)).status).toBe(400);
      expect(
        (
          await call(`/tenants/${tenant}/gateway-plugins`, session(tenant), {
            method: 'PUT',
            body: { disabled: [], extra: true },
          })
        ).status,
      ).toBe(400);
    });

    it('lets read tokens view plugin state but keeps the kill switch session-only', async () => {
      const tenant = await workspace();
      const minted = await call<CreatedAutomationToken>(
        `/tenants/${tenant}/automation-tokens`,
        session(tenant),
        {
          method: 'POST',
          body: { name: 'monitor', scopes: ['workspace:read', 'config:write'] },
        },
      );
      expect(minted.status).toBe(201);
      const bearer = `Bearer ${minted.body.token}`;
      expect(
        (await call(`/tenants/${tenant}/gateway-plugins`, bearer)).status,
      ).toBe(200);
      expect(
        (
          await call(`/tenants/${tenant}/gateway-plugins`, bearer, {
            method: 'PUT',
            body: { disabled: ['@acme/stamp'] },
          })
        ).status,
      ).toBe(403);
    });

    it('accepts third-party plugins on routes with bounded configuration and round-trips them', async () => {
      const tenant = await workspace();
      const service = await call<{ id: string }>(
        `/tenants/${tenant}/services`,
        session(tenant),
        {
          method: 'POST',
          body: {
            name: 'users-api',
            targets: [{ url: 'https://users.example.test', weight: 100 }],
          },
        },
      );
      expect(service.status).toBe(201);
      const route = (plugins: unknown, pathPattern = '/users') =>
        call<{ id: string; plugins: unknown }>(
          `/tenants/${tenant}/routes`,
          session(tenant),
          {
            method: 'POST',
            body: {
              method: 'GET',
              pathPattern,
              serviceId: service.body.id,
              plugins,
            },
          },
        );
      const plugins = [
        { name: 'cors', config: { origins: ['https://app.example.test'] } },
        {
          name: '@acme/stamp',
          config: { value: 'v1', nested: { list: [1, 2] } },
        },
      ];
      const created = await route(plugins);
      expect(created.status).toBe(201);
      expect(created.body.plugins).toEqual(plugins);
      for (const invalid of [
        [{ name: 'stamp', config: {} }],
        [{ name: '@Acme/Stamp', config: {} }],
        [{ name: '@acme/stamp', config: { blob: 'x'.repeat(16400) } }],
        [{ name: '@acme/stamp', config: [] }],
        Array.from({ length: 33 }, (_, i) => ({
          name: `@acme/p${i}`,
          config: {},
        })),
      ])
        expect((await route(invalid, `/invalid-${randomUUID()}`)).status).toBe(
          400,
        );

      const exported = await call<string>(
        `/tenants/${tenant}/export`,
        session(tenant),
      );
      expect(exported.status).toBe(200);
      expect(exported.body).toContain('@acme/stamp');
      const preview = await call<ConfigPreview>(
        `/tenants/${tenant}/import`,
        session(tenant),
        {
          method: 'POST',
          body: exported.body,
          type: 'application/yaml',
        },
      );
      expect(preview.status).toBe(200);
      expect(preview.body.changes).toEqual([]);

      // The portal flags routes whose requirements it cannot describe.
      const row = {
        id: created.body.id,
        method: 'GET',
        pathPattern: '/users',
        authRequired: false,
        rateLimitOverride: null,
        portal: null,
      };
      expect(catalogRoute({ ...row, plugins }).customPolicies).toBe(true);
      expect(
        catalogRoute({ ...row, plugins: plugins.slice(0, 1) }).customPolicies,
      ).toBe(false);
    });
  },
);
