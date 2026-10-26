import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { stringify, parse } from 'yaml';
import type {
  ConfigApplyResult,
  ConfigPreview,
  DeclarativeConfig,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { RetentionCaseWork } from '../database/retention-case-work.fixture';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { ConfigImportController } from './config-import.controller';
import { ConfigImportService } from './config-import.service';
import { configureConfigImportParser } from './config-import.body-parser';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration(
  'Declarative configuration on actual PostgreSQL and authenticated HTTP',
  () => {
    const secret = 'config-import-fixture-secret-longer-than-32-characters';
    const previousSecret = process.env.PLATFORM_JWT_SECRET;
    const database = `novagate_import_${randomUUID().replaceAll('-', '')}`;
    let root: DataSource,
      db: DataSource,
      app: INestApplication,
      base: string,
      push: ConfigPushService;
    const publish = jest.fn().mockResolvedValue(false);
    const cases = new RetentionCaseWork();
    const tenants: string[] = [];
    beforeAll(async () => {
      process.env.PLATFORM_JWT_SECRET = secret;
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
        extra: {
          max: 12,
          connectionTimeoutMillis: 3000,
          options: '-c statement_timeout=15000 -c lock_timeout=3000',
        },
      });
      await db.initialize();
      await db.query(
        readFileSync(
          resolve(__dirname, '../../../../docker/postgres-init.sql'),
          'utf8',
        ),
      );
      await new MigrationService(db).onModuleInit();
      push = new ConfigPushService(db);
      const module = await Test.createTestingModule({
        controllers: [ConfigImportController],
        providers: [
          ConfigImportService,
          { provide: DataSource, useValue: db },
          {
            provide: ConfigPushService,
            useValue: { persistUpdate: push.persistUpdate.bind(push), publish },
          },
          { provide: APP_GUARD, useClass: TenantAuthGuard },
        ],
      }).compile();
      app = module.createNestApplication({
        logger: false,
        forceCloseConnections: true,
      });
      configureConfigImportParser(app);
      app.setGlobalPrefix('api');
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
    }, 30000);
    afterEach(
      () =>
        cases.finish(async () => {
          publish.mockClear();
          for (const tenant of tenants.splice(0)) {
            await db.query(
              `DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`,
            );
            for (const [table, field] of [
              ['api_keys', 'tenantId'],
              ['pending_config_updates', 'tenantId'],
            ] as const)
              await db.query(
                `DELETE FROM public.${table} WHERE "${field}"=$1`,
                [tenant],
              );
            await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
          }
        }),
      30000,
    );
    afterAll(async () => {
      await app?.close();
      if (db?.isInitialized) await db.destroy();
      if (root?.isInitialized) {
        await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await root.destroy();
      }
      if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previousSecret;
    });
    async function workspace() {
      const tenant = randomUUID();
      tenants.push(tenant);
      await db.query(
        `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Import fixture',$2,'free')`,
        [tenant, `${tenant}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(tenant);
      return tenant;
    }
    const document = (): DeclarativeConfig => ({
      version: 1,
      services: [
        {
          name: 'users-api',
          targets: [{ url: 'https://users.example.test', weight: 100 }],
          healthCheckPath: '/health',
          timeoutMs: 10000,
        },
      ],
      routes: [
        {
          method: 'GET',
          pathPattern: '/users',
          serviceId: 'users-api',
          authRequired: true,
          enabled: true,
          plugins: [
            { name: 'rate-limit', config: { max: 200, windowMs: 60000 } },
          ],
        },
      ],
      consumers: [{ name: 'mobile-app', groups: ['read-only'] }],
    });
    const auth = (tenant: string) =>
      `Bearer ${sign({ sub: tenant }, secret, { expiresIn: '5m' })}`;
    function request(tenant: string, path: string, options: RequestInit = {}) {
      return fetch(`${base}/api/tenants/${tenant}/${path}`, {
        ...options,
        headers: { Authorization: auth(tenant), ...options.headers },
        signal: AbortSignal.timeout(5000),
      });
    }
    async function preview(tenant: string, config: DeclarativeConfig) {
      const response = await request(tenant, 'import?dryRun=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/yaml' },
        body: stringify(config),
      });
      const body = await response.json();
      expect(response.status).toBe(200);
      return body as ConfigPreview;
    }
    async function apply(
      tenant: string,
      config: DeclarativeConfig,
      revision: string,
    ) {
      return request(tenant, 'import?dryRun=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${revision}"`,
        },
        body: JSON.stringify(config),
      });
    }
    async function seed(
      tenant: string,
      config: DeclarativeConfig = document(),
    ) {
      const before = await preview(tenant, config);
      const applied = await apply(tenant, config, before.revision);
      const body = await applied.json();
      expect(applied.status).toBe(200);
      return body as ConfigApplyResult;
    }
    async function fingerprint(tenant: string) {
      const schema = tenantSchema(tenant);
      return db.query(
        `SELECT (SELECT jsonb_agg(s ORDER BY id) FROM ${schema}.services s) AS services,
      (SELECT jsonb_agg(r ORDER BY id) FROM ${schema}.routes r) AS routes,(SELECT jsonb_agg(c ORDER BY id) FROM ${schema}.consumers c) AS consumers,
      (SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1) AS version,(SELECT config FROM public.pending_config_updates WHERE "tenantId"=$1) AS pending`,
        [tenant],
      );
    }
    it('previews without writes and atomically applies one full configuration and durable outbox', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        const before = await fingerprint(tenant);
        const proposed = await preview(tenant, config);
        expect(proposed.changes.map((change) => change.action)).toEqual([
          'create',
          'create',
          'create',
        ]);
        expect(await fingerprint(tenant)).toEqual(before);
        expect(publish).not.toHaveBeenCalled();
        const response = await apply(tenant, config, proposed.revision);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const result = (await response.json()) as ConfigApplyResult;
        expect(result.changed).toBe(3);
        expect(result.consumerKeys).toHaveLength(1);
        const [stored] = await db.query(
          `SELECT id,"keyHash" FROM ${tenantSchema(tenant)}.consumers`,
        );
        expect(stored.id).toBe(result.consumerKeys[0].id);
        expect(stored.keyHash).toBe(
          createHash('sha256')
            .update(result.consumerKeys[0].apiKey)
            .digest('hex'),
        );
        const [pending] = await db.query(
          'SELECT config FROM public.pending_config_updates WHERE "tenantId"=$1',
          [tenant],
        );
        expect(pending.config.version).toBe(result.configVersion);
        expect(pending.config.config.routes[0].serviceId).toBe(
          pending.config.config.services[0].id,
        );
        expect(JSON.stringify(await fingerprint(tenant))).not.toContain(
          result.consumerKeys[0].apiKey,
        );
        expect(publish).toHaveBeenCalledTimes(1);
      }));
    it('reviews and commits all 400 changes when replacing the maximum 200 consumers', () =>
      cases.run(async () => {
        const tenant = await workspace();
        const config: DeclarativeConfig = {
          version: 1,
          services: [],
          routes: [],
          consumers: Array.from({ length: 200 }, (_, i) => ({
            name: `old-${i}`,
          })),
        };
        const seeded = await seed(tenant, config);
        config.consumers = Array.from({ length: 200 }, (_, i) => ({
          name: `new-${i}`,
        }));
        const before = await fingerprint(tenant);
        const proposed = await preview(tenant, config);
        expect(
          proposed.changes.filter((change) => change.action === 'create'),
        ).toHaveLength(200);
        expect(
          proposed.changes.filter((change) => change.action === 'remove'),
        ).toHaveLength(200);
        expect(await fingerprint(tenant)).toEqual(before);
        const response = await apply(tenant, config, proposed.revision);
        expect(response.status).toBe(200);
        const result = (await response.json()) as ConfigApplyResult;
        expect(result.changed).toBe(400);
        expect(result.consumerKeys).toHaveLength(200);
        expect(result.configVersion).toBe(seeded.configVersion + 1);
        const schema = tenantSchema(tenant);
        const [counts] = await db.query(
          `SELECT COUNT(*) FILTER (WHERE "revokedAt" IS NULL)::integer AS active, COUNT(*) FILTER (WHERE "revokedAt" IS NOT NULL)::integer AS revoked FROM ${schema}.consumers`,
        );
        expect(counts).toEqual({ active: 200, revoked: 200 });
      }));
    it('exports YAML without credentials or hashes and round trips without rotating keys or publishing', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        config.routes[0].plugins = [
          {
            name: 'oauth2-client-credentials',
            config: {
              tokenEndpoint: 'https://id.example.test/token',
              clientId: 'application',
              clientSecret: 'never-return-secret',
            },
          },
          {
            name: 'hmac-auth',
            config: {
              header: 'x-signature',
              algorithm: 'sha256',
              secrets: ['never-return-hmac'],
            },
          },
          {
            name: 'request-transform',
            config: {
              addHeaders: { Authorization: 'Bearer never-return-header' },
            },
          },
        ];
        const first = await seed(tenant, config);
        const before = await fingerprint(tenant);
        publish.mockClear();
        const exported = await request(tenant, 'export');
        expect(exported.status).toBe(200);
        expect(exported.headers.get('content-type')).toContain(
          'application/yaml',
        );
        expect(exported.headers.get('cache-control')).toBe('no-store');
        const source = await exported.text();
        expect(source).not.toMatch(
          /never-return|keyHash|passwordHash|apiKey|configOrder/,
        );
        expect(source).not.toContain(first.consumerKeys[0].apiKey);
        const imported = parse(source) as DeclarativeConfig;
        const proposed = await preview(tenant, imported);
        expect(proposed.changes).toEqual([]);
        const same = await apply(tenant, imported, proposed.revision);
        expect(same.status).toBe(200);
        expect(((await same.json()) as ConfigApplyResult).consumerKeys).toEqual(
          [],
        );
        expect(await fingerprint(tenant)).toEqual(before);
        expect(publish).not.toHaveBeenCalled();
        const other = await workspace();
        const missing = await request(other, 'import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/yaml' },
          body: source,
        });
        expect(missing.status).toBe(400);
      }));
    it('round trips consumer monthly quotas; null and absent both mean none', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        config.consumers = [
          { name: 'mobile-app', groups: [], monthlyQuota: 5000 },
          { name: 'partner', groups: [] },
        ];
        await seed(tenant, config);
        const [mobile] = await db.query(
          `SELECT "monthlyQuota" FROM ${tenantSchema(tenant)}.consumers WHERE name='mobile-app'`,
        );
        expect(mobile.monthlyQuota).toBe(5000);
        const exported = parse(
          await (await request(tenant, 'export')).text(),
        ) as DeclarativeConfig;
        expect(exported.consumers).toEqual([
          {
            name: 'mobile-app',
            rateLimitTier: 'authenticated',
            groups: [],
            monthlyQuota: 5000,
          },
          { name: 'partner', rateLimitTier: 'authenticated', groups: [] },
        ]);
        const explicitNull = structuredClone(exported) as unknown as {
          consumers: Array<Record<string, unknown>>;
        };
        explicitNull.consumers[1].monthlyQuota = null;
        expect(
          (await preview(tenant, explicitNull as unknown as DeclarativeConfig))
            .changes,
        ).toEqual([]);
        // Removing the quota is a change that reaches the database.
        delete exported.consumers[0].monthlyQuota;
        const removal = await preview(tenant, exported);
        expect(removal.changes).toEqual([
          expect.objectContaining({
            resource: 'consumer',
            key: 'mobile-app',
            fields: ['monthlyQuota'],
          }),
        ]);
        expect((await apply(tenant, exported, removal.revision)).status).toBe(
          200,
        );
        const [cleared] = await db.query(
          `SELECT "monthlyQuota" FROM ${tenantSchema(tenant)}.consumers WHERE name='mobile-app'`,
        );
        expect(cleared.monthlyQuota).toBeNull();
        for (const monthlyQuota of [0, 1.5, 2_000_000_001]) {
          const invalid = await request(tenant, 'import?dryRun=true', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...exported,
              consumers: [{ name: 'mobile-app', monthlyQuota }],
            }),
          });
          expect(invalid.status).toBe(400);
        }
      }));
    it('preserves identities and existing keys, soft deletes removals and never resurrects revoked consumers', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        const first = await seed(tenant, config);
        const [original] = await db.query(
          `SELECT id FROM ${tenantSchema(tenant)}.services`,
        );
        config.consumers[0].groups = ['write'];
        config.services[0].timeoutMs = 20000;
        const response = await apply(
          tenant,
          config,
          (await preview(tenant, config)).revision,
        );
        expect(response.status).toBe(200);
        expect(
          ((await response.json()) as ConfigApplyResult).consumerKeys,
        ).toEqual([]);
        expect(
          (await db.query(`SELECT id FROM ${tenantSchema(tenant)}.services`))[0]
            .id,
        ).toBe(original.id);
        const empty: DeclarativeConfig = {
          version: 1,
          services: [],
          routes: [],
          consumers: [],
        };
        const removed = await apply(
          tenant,
          empty,
          (await preview(tenant, empty)).revision,
        );
        expect(removed.status).toBe(200);
        for (const [table, column] of [
          ['services', 'deletedAt'],
          ['routes', 'deletedAt'],
          ['consumers', 'revokedAt'],
        ] as const)
          expect(
            (
              await db.query(
                `SELECT "${column}" IS NOT NULL AS removed FROM ${tenantSchema(tenant)}.${table}`,
              )
            )[0].removed,
          ).toBe(true);
        const second = await seed(tenant, config);
        expect(second.consumerKeys[0].id).not.toBe(first.consumerKeys[0].id);
        expect(second.consumerKeys[0].apiKey).not.toBe(
          first.consumerKeys[0].apiKey,
        );
      }));
    it('retains route and plugin order in export and the actual gateway payload', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        config.routes.unshift({
          ...config.routes[0],
          pathPattern: '/users/private',
          plugins: [
            { name: 'acl', config: { allow: ['read-only'] } },
            { name: 'cors', config: { origins: ['https://app.example.test'] } },
          ],
        });
        await seed(tenant, config);
        config.routes.reverse();
        const proposed = await preview(tenant, config);
        expect(
          proposed.changes.filter((change) => change.fields.includes('order')),
        ).toHaveLength(2);
        expect((await apply(tenant, config, proposed.revision)).status).toBe(
          200,
        );
        const payload = await push.assembleConfig(tenant);
        expect(payload.routes.map((route) => route.pathPattern)).toEqual(
          config.routes.map((route) => route.pathPattern),
        );
        expect(payload.routes[1].plugins?.map((plugin) => plugin.name)).toEqual(
          ['acl', 'cors'],
        );
        const exported = parse(
          await (await request(tenant, 'export')).text(),
        ) as DeclarativeConfig;
        expect(exported.routes.map((route) => route.pathPattern)).toEqual(
          config.routes.map((route) => route.pathPattern),
        );
      }));
    it('rejects changed documents, stale direct CRUD writes, expired previews and cross-workspace revisions', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        await seed(tenant, config);
        const proposed = await preview(tenant, config);
        const before = await fingerprint(tenant);
        const changed = structuredClone(config);
        changed.services[0].timeoutMs = 30000;
        expect((await apply(tenant, changed, proposed.revision)).status).toBe(
          409,
        );
        expect(await fingerprint(tenant)).toEqual(before);
        const other = await workspace();
        expect((await apply(other, config, proposed.revision)).status).toBe(
          409,
        );
        expect(
          (
            await apply(
              tenant,
              config,
              `1000000000.${proposed.revision.split('.')[1]}`,
            )
          ).status,
        ).toBe(409);
        await db.query(
          `UPDATE ${tenantSchema(tenant)}.consumers SET groups='["drift"]'::jsonb`,
        );
        const drifted = await fingerprint(tenant);
        expect((await apply(tenant, config, proposed.revision)).status).toBe(
          409,
        );
        expect(await fingerprint(tenant)).toEqual(drifted);
      }));
    it('allows only one competing replica apply from the same preview', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document(),
          proposed = await preview(tenant, config);
        const second = new ConfigImportService(db, {
          persistUpdate: push.persistUpdate.bind(push),
          publish,
        } as unknown as ConfigPushService);
        try {
          const outcomes = await Promise.allSettled([
            app
              .get(ConfigImportService)
              .apply(tenant, config, proposed.revision),
            second.apply(tenant, config, proposed.revision),
          ]);
          expect(
            outcomes.filter((outcome) => outcome.status === 'fulfilled'),
          ).toHaveLength(1);
          const rejected = outcomes.find(
            (outcome) => outcome.status === 'rejected',
          );
          expect(
            rejected?.status === 'rejected' && rejected.reason.getStatus(),
          ).toBe(409);
          expect(
            (
              await db.query(
                `SELECT COUNT(*)::integer AS records FROM ${tenantSchema(tenant)}.consumers`,
              )
            )[0].records,
          ).toBe(1);
        } finally {
          await second.onModuleDestroy();
        }
      }));
    it('rolls back all configuration and the version if outbox persistence fails', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document(),
          proposed = await preview(tenant, config),
          before = await fingerprint(tenant);
        await db.query(
          `ALTER TABLE public.pending_config_updates ADD CONSTRAINT reject_import CHECK("tenantId"<>'${tenant}'::uuid)`,
        );
        try {
          expect((await apply(tenant, config, proposed.revision)).status).toBe(
            500,
          );
          expect(await fingerprint(tenant)).toEqual(before);
          expect(publish).not.toHaveBeenCalled();
        } finally {
          await db.query(
            'ALTER TABLE public.pending_config_updates DROP CONSTRAINT reject_import',
          );
        }
        expect((await apply(tenant, config, proposed.revision)).status).toBe(
          200,
        );
      }));
    it(
      'bounds lock contention, preserves state and recovers after the lock is released',
      () =>
        cases.run(async () => {
          const tenant = await workspace(),
            config = document(),
            proposed = await preview(tenant, config),
            before = await fingerprint(tenant),
            locker = db.createQueryRunner();
          await locker.connect();
          try {
            await locker.startTransaction();
            await locker.query(
              `LOCK TABLE ${tenantSchema(tenant)}.routes IN ROW EXCLUSIVE MODE`,
            );
            const start = performance.now();
            const response = await apply(tenant, config, proposed.revision);
            expect(response.status).toBe(503);
            expect(performance.now() - start).toBeLessThan(2500);
            expect(await fingerprint(tenant)).toEqual(before);
            await locker.commitTransaction();
            expect(
              (await apply(tenant, config, proposed.revision)).status,
            ).toBe(200);
          } finally {
            if (locker.isTransactionActive) await locker.rollbackTransaction();
            await locker.release();
          }
        }),
      10000,
    );
    it(
      'bounds tenant admission and drains admitted database work during shutdown',
      () =>
        cases.run(async () => {
          const tenant = await workspace(),
            config = document(),
            locker = db.createQueryRunner();
          const worker = new ConfigImportService(db, {
            persistUpdate: push.persistUpdate.bind(push),
            publish,
          } as unknown as ConfigPushService);
          await locker.connect();
          let settled:
              | Promise<PromiseSettledResult<ConfigPreview>[]>
              | undefined,
            stopped: Promise<void> | undefined;
          try {
            await locker.startTransaction();
            await locker.query(
              `LOCK TABLE ${tenantSchema(tenant)}.services IN ACCESS EXCLUSIVE MODE`,
            );
            settled = Promise.allSettled([
              worker.preview(tenant, JSON.parse(JSON.stringify(config))),
              worker.preview(tenant, JSON.parse(JSON.stringify(config))),
            ]);
            const deadline = performance.now() + 800;
            let waiting = 0;
            while (performance.now() < deadline) {
              waiting = Number(
                (
                  await root.query(
                    `SELECT COUNT(*)::integer AS waiting FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`,
                    [database],
                  )
                )[0].waiting,
              );
              if (waiting === 2) break;
              await new Promise((done) => setTimeout(done, 10));
            }
            if (waiting !== 2) {
              const outcomes = await settled;
              throw new AggregateError(
                outcomes.flatMap((outcome) =>
                  outcome.status === 'rejected' ? [outcome.reason] : [],
                ),
                `Expected two admitted PostgreSQL reads waiting on the held table lock: ${outcomes.map((outcome) => (outcome.status === 'rejected' ? outcome.reason.message : 'fulfilled')).join('; ')}`,
              );
            }
            await expect(worker.preview(tenant, config)).rejects.toThrow(
              'busy',
            );
            let drained = false;
            stopped = worker.onModuleDestroy().then(() => {
              drained = true;
            });
            await expect(worker.export(tenant)).rejects.toThrow('busy');
            expect(drained).toBe(false);
            await locker.commitTransaction();
            const completed = await settled;
            expect(
              completed.every((result) => result.status === 'fulfilled'),
            ).toBe(true);
            await stopped;
            expect(drained).toBe(true);
          } finally {
            if (locker.isTransactionActive) await locker.rollbackTransaction();
            await settled;
            await stopped;
            await worker.onModuleDestroy();
            await locker.release();
          }
        }),
      10000,
    );
    it('enforces session scope, preview requirements, media types and no-store errors', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        expect(
          (await fetch(`${base}/api/tenants/${tenant}/export`)).status,
        ).toBe(401);
        const foreign = await request(tenant, 'export', {
          headers: { Authorization: auth(randomUUID()) },
        });
        expect(foreign.status).toBe(403);
        expect(foreign.headers.get('cache-control')).toBe('no-store');
        expect((await apply(tenant, config, '')).status).toBe(400);
        expect(
          (
            await request(tenant, 'import?dryRun=maybe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config),
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await request(tenant, 'import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/xml' },
              body: '<config/>',
            })
          ).status,
        ).toBe(415);
      }));
    it.each([
      'version: 1\nversion: 1\nservices: []\nroutes: []\nconsumers: []',
      '{"version":1,"version":1,"services":[],"routes":[],"consumers":[]}',
      'version: 1\nservices: &items []\nroutes: *items\nconsumers: []',
      'version: 1\nservices: !!js/function never-return\nroutes: []\nconsumers: []',
      'version: 1\nservices: []\nroutes: []\nconsumers: []\n---\nversion: 1',
      '{"version":1,"services":[],"routes":[],"consumers":[],"__proto__":{"polluted":true}}',
      `version: 1\nservices: []\nroutes: []\nconsumers: []\nextra: ${'['.repeat(30)}0${']'.repeat(30)}`,
      `version: 1\nservices: []\nroutes: []\nconsumers: []\nextra: ${'['.repeat(1500)}0${']'.repeat(1500)}`,
    ])(
      'refuses malformed/unsafe document %s without reflecting source or changing state',
      (source) =>
        cases.run(async () => {
          const tenant = await workspace(),
            before = await fingerprint(tenant);
          const response = await request(tenant, 'import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: source,
          });
          expect(response.status).toBe(400);
          expect(await response.text()).not.toContain('never-return');
          expect(await fingerprint(tenant)).toEqual(before);
        }),
    );
    it('refuses oversized exports from individual controls without publishing a partial document', () =>
      cases.run(async () => {
        const tenant = await workspace();
        await seed(tenant);
        const targets = Array.from({ length: 100 }, (_, i) => ({
          url: `https://upstream.example.test/${i}/${'a'.repeat(800)}`,
          weight: 100,
        }));
        await db.query(
          `UPDATE ${tenantSchema(tenant)}.services SET targets=$1::jsonb`,
          [JSON.stringify(targets)],
        );
        const before = await fingerprint(tenant);
        const response = await request(tenant, 'export');
        expect(response.status).toBe(409);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const body = await response.text();
        expect(body).toContain(
          'Export exceeds the import byte or complexity limits',
        );
        expect(body).not.toContain('upstream.example.test');
        expect(await fingerprint(tenant)).toEqual(before);
      }));
    it('rejects duplicate identities, foreign references, invalid policies, bounds and secret-bearing URL exports', () =>
      cases.run(async () => {
        const tenant = await workspace();
        const invalid: DeclarativeConfig[] = [];
        let config = document();
        config.services.push(config.services[0]);
        invalid.push(config);
        config = document();
        config.routes[0].serviceId = 'missing';
        invalid.push(config);
        config = document();
        config.routes[0].plugins = [{ name: 'constructor', config: {} }];
        invalid.push(config);
        config = document();
        config.routes[0].plugins = [
          { name: 'rate-limit', config: { max: -1 } },
        ];
        invalid.push(config);
        config = document();
        Object.assign(config.services[0].targets[0], {
          unexpected: 'never-return',
        });
        invalid.push(config);
        config = document();
        config.services[0].targets[0].url =
          'https://user:password@example.test';
        invalid.push(config);
        config = document();
        config.consumers = Array.from({ length: 201 }, (_, i) => ({
          name: `consumer-${i}`,
        }));
        invalid.push(config);
        for (const body of invalid)
          expect(
            (
              await request(tenant, 'import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              })
            ).status,
          ).toBe(400);
        const oversized = await request(tenant, 'import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/yaml' },
          body: 'a'.repeat(65537),
        });
        expect(oversized.status).toBe(413);
        config = document();
        config.services[0].targets[0].url =
          'https://upstream.example.test?api_key=never-return';
        await seed(tenant, config);
        const exported = await request(tenant, 'export');
        expect(exported.status).toBe(409);
        expect(await exported.text()).not.toContain('never-return');
      }));
    it('refuses malformed URL-like metadata with a private conflict instead of a server error', () =>
      cases.run(async () => {
        const tenant = await workspace(),
          config = document();
        config.services[0].name = 'http://';
        config.routes[0].serviceId = 'http://';
        await seed(tenant, config);
        const before = await fingerprint(tenant);
        const exported = await request(tenant, 'export');
        expect(exported.status).toBe(409);
        expect(await exported.text()).not.toContain('http://');
        expect(await fingerprint(tenant)).toEqual(before);
      }));
  },
);
