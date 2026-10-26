import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type {
  ControlPlaneRegionsState,
  TenantConfig,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { RegionsController } from './regions.controller';
import { RegionsService, controlPlaneRegions } from './regions.service';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
integration(
  'Control plane regions on actual PostgreSQL, Redis and HTTP',
  () => {
    const secret = 'regions-fixture-secret-longer-than-32-characters';
    const previous = {
      secret: process.env.PLATFORM_JWT_SECRET,
      redis: process.env.REDIS_URL,
    };
    const database = `novagate_regions_${randomUUID().replaceAll('-', '')}`;
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
        controllers: [RegionsController],
        providers: [
          RegionsService,
          {
            provide: ConfigService,
            useValue: new ConfigService({
              CONTROL_PLANE_REGIONS: 'us-east,eu-west',
            }),
          },
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
        `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Regions fixture',$2,'free')`,
        [tenant, `${tenant}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(tenant);
      return tenant;
    }
    const session = (tenant: string) =>
      `Bearer ${sign({ sub: tenant }, secret)}`;
    async function call<T>(
      tenant: string,
      auth: string,
      init: { method?: string; body?: unknown } = {},
    ) {
      const response = await fetch(`${base}/tenants/${tenant}/control-plane`, {
        method: init.method ?? 'GET',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: response.status, body: (await response.json()) as T };
    }

    it('lists gateways across regions and their configuration versions', async () => {
      const tenant = await workspace();
      await db.query(
        `UPDATE public.tenants SET "gatewayConfigVersion"=9 WHERE id=$1`,
        [tenant],
      );
      const [live, stale, gone, old] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await db.query(
        `INSERT INTO public.gateway_instances ("tenantId","instanceId",name,region,"connectedAt","lastSeenAt","disconnectedAt","configVersion") VALUES
        ($1,$2,'edge-live','eu-west',NOW()-INTERVAL '1 hour',NOW(),NULL,9),
        ($1,$3,'edge-stale','us-east',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '5 minutes',NULL,8),
        ($1,$4,'edge-gone','us-east',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour',7),
        ($1,$5,'edge-old','us-east',NOW()-INTERVAL '3 days',NOW()-INTERVAL '2 days',NOW()-INTERVAL '2 days',1)`,
        [tenant, live, stale, gone, old],
      );
      const state = await call<ControlPlaneRegionsState>(
        tenant,
        session(tenant),
      );
      expect(state.status).toBe(200);
      expect(state.body).toMatchObject({
        regions: ['us-east', 'eu-west'],
        preferredRegion: null,
        configVersion: 9,
      });
      expect(
        state.body.gateways.map((g) => [
          g.name,
          g.region,
          g.online,
          g.configVersion,
        ]),
      ).toEqual([
        ['edge-live', 'eu-west', true, 9],
        // No heartbeat for 5 minutes: its region is unreachable.
        ['edge-stale', 'us-east', false, 8],
        ['edge-gone', 'us-east', false, 7],
      ]);
      // Disconnected for more than a day: pruned.
      expect(
        await db.query(
          `SELECT 1 FROM public.gateway_instances WHERE "instanceId"=$1`,
          [old],
        ),
      ).toEqual([]);
      const other = await workspace();
      expect((await call(tenant, session(other))).status).toBe(403);
    });

    it('saves a known preferred region and pushes it to gateways', async () => {
      const tenant = await workspace();
      for (const preferredRegion of ['ap-south', 'EU', 42])
        expect(
          (
            await call(tenant, session(tenant), {
              method: 'PUT',
              body: { preferredRegion },
            })
          ).status,
        ).toBe(400);
      expect(
        (
          await call(tenant, session(tenant), {
            method: 'PUT',
            body: { preferredRegion: 'eu-west', extra: 1 },
          })
        ).status,
      ).toBe(400);
      const saved = await call<ControlPlaneRegionsState>(
        tenant,
        session(tenant),
        {
          method: 'PUT',
          body: { preferredRegion: 'eu-west' },
        },
      );
      expect(saved.body.preferredRegion).toBe('eu-west');
      const deadline = Date.now() + 5000;
      while (
        !published.some((p) => p.tenantId === tenant) &&
        Date.now() < deadline
      )
        await new Promise((done) => setTimeout(done, 20));
      expect(
        published.find((p) => p.tenantId === tenant)?.config.preferredRegion,
      ).toBe('eu-west');
      expect((await push.assembleConfig(tenant)).preferredRegion).toBe(
        'eu-west',
      );
      // Unchanged: no new version.
      const [{ gatewayConfigVersion }] = await db.query(
        `SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1`,
        [tenant],
      );
      await call(tenant, session(tenant), {
        method: 'PUT',
        body: { preferredRegion: 'eu-west' },
      });
      const [after] = await db.query(
        `SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1`,
        [tenant],
      );
      expect(after.gatewayConfigVersion).toBe(gatewayConfigVersion);
      const cleared = await call<ControlPlaneRegionsState>(
        tenant,
        session(tenant),
        {
          method: 'PUT',
          body: { preferredRegion: null },
        },
      );
      expect(cleared.body.preferredRegion).toBeNull();
    });

    it('validates the configured region list', () => {
      expect(controlPlaneRegions(undefined)).toEqual([]);
      expect(controlPlaneRegions('us-east, eu-west')).toEqual([
        'us-east',
        'eu-west',
      ]);
      for (const bad of ['US', 'us-east,us-east', 'a,b,c,d,e,f,g,h,i'])
        expect(() => controlPlaneRegions(bad)).toThrow();
    });
  },
);
