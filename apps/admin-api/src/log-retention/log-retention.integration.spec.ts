import { RETENTION_CUTOFF_SQL } from './log-retention.policy';
import type { LogRetentionState, RequestLog } from '@api-gateway/shared-types';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { LogRetentionService } from './log-retention.service';
import { LogRetentionController } from './log-retention.controller';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { AnalyticsController } from '../proxy-config/analytics.controller';
import { ConsumerAnalyticsService } from '../proxy-config/consumer-analytics.service';
import { MetricsStreamService } from '../proxy-config/metrics-stream.service';
import { ConfigPushService } from '../config-push/config-push.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { MigrationService } from '../database/migration.service';
import { LogExportService } from '../log-export/log-export.service';
import { ObjectStorageService } from '../log-export/object-storage.service';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const SECRET = 'retention-local-verification-secret-over-32-chars';
integration(
  'Retention on PostgreSQL with non-UTC sessions and authenticated HTTP',
  () => {
    let root: DataSource,
      db: DataSource,
      service: LogRetentionService,
      app: INestApplication,
      url: string;
    const database = 'novagate_retention_' + randomUUID().replace(/-/g, '');
    const tenant = randomUUID(),
      other = randomUUID();
    const schema = tenantSchema(tenant);
    const previousSecret = process.env.PLATFORM_JWT_SECRET;
    function headers(id = tenant) {
      return {
        authorization:
          'Bearer ' + sign({ sub: id }, SECRET, { expiresIn: '10m' }),
      };
    }
    async function logs(id = tenant) {
      const r = await fetch(url + '/tenants/' + id + '/logs', {
        headers: headers(id),
      });
      expect(r.status).toBe(200);
      return r.json() as Promise<RequestLog[]>;
    }
    async function insert(
      receipt: string,
      path: string,
      requestTime = '1900-01-01T00:00:00Z',
    ) {
      await db.query(
        `INSERT INTO ${schema}.request_logs (id,path,timestamp,"receivedAt") VALUES (gen_random_uuid(),$1,$2,$3)`,
        [path, requestTime, receipt],
      );
    }
    beforeAll(async () => {
      process.env.PLATFORM_JWT_SECRET = SECRET;
      root = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await root.initialize();
      await root.query('CREATE DATABASE ' + database);
      const u = new URL(process.env.TEST_DATABASE_URL as string);
      u.pathname = '/' + database;
      db = new DataSource({
        type: 'postgres',
        url: u.toString(),
        extra: {
          max: 12,
          connectionTimeoutMillis: 3000,
          options: '-c timezone=Asia/Kolkata',
        },
      });
      await db.initialize();
      await db.query(
        readFileSync(
          resolve(__dirname, '../../../../docker/postgres-init.sql'),
          'utf8',
        ),
      );
      for (const id of [tenant, other]) {
        await db.query(
          `INSERT INTO public.tenants (id,name,email,"planId") VALUES ($1,'Retention fixture',$2,'free')`,
          [id, id + '@example.test'],
        );
        await new TenantProvisioningService(db).provisionTenant(id);
      }
      await new MigrationService(db).onModuleInit();
      service = new LogRetentionService(db);
      jest
        .spyOn(service, 'onApplicationBootstrap')
        .mockImplementation(() => undefined);
      const module = await Test.createTestingModule({
        controllers: [LogRetentionController, AnalyticsController],
        providers: [
          { provide: LogRetentionService, useValue: service },
          { provide: DataSource, useValue: db },
          { provide: APP_GUARD, useClass: TenantAuthGuard },
          { provide: ConfigPushService, useValue: {} },
          { provide: MetricsStreamService, useValue: {} },
          { provide: ConsumerAnalyticsService, useValue: {} },
        ],
      }).compile();
      app = module.createNestApplication({ forceCloseConnections: true });
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    }, 30000);
    afterAll(async () => {
      await app?.close();
      if (db?.isInitialized) await db.destroy();
      if (root?.isInitialized) {
        await root.query(
          'DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)',
        );
        await root.destroy();
      }
      if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previousSecret;
    });
    beforeEach(async () => {
      await db.query('DELETE FROM public.log_export_jobs');
      for (const id of [tenant, other])
        await db.query('DELETE FROM ' + tenantSchema(id) + '.request_logs');
      await db.query(
        `UPDATE public.tenants SET "logRetentionDays"=30,"logRetentionRevision"=gen_random_uuid(),"logRetentionFloor"=clock_timestamp()-INTERVAL '30 days',"logRetentionPending"=false,"logRetentionError"=false,"logRetentionCheckedAt"=clock_timestamp()`,
      );
    });
    it('requires tenant sessions, defaults to 30 days and uses strict revisions with no-op preservation', async () => {
      const endpoint = url + '/tenants/' + tenant + '/log-retention';
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: headers(other) })).status).toBe(
        403,
      );
      const read = await fetch(endpoint, { headers: headers() });
      expect(read.headers.get('cache-control')).toBe('no-store');
      const state = (await read.json()) as LogRetentionState;
      expect(state.days).toBe(30);
      expect(state.timeBasis).toBe('receipt');
      expect(
        (
          await service.save(tenant, {
            days: 30,
            expectedRevision: state.revision,
          })
        ).revision,
      ).toBe(state.revision);
      const changed = await service.save(tenant, {
        days: 7,
        expectedRevision: state.revision,
      });
      expect(changed.revision).not.toBe(state.revision);
      await expect(
        service.save(tenant, { days: 90, expectedRevision: state.revision }),
      ).rejects.toThrow('Reload');
    });
    it('filters immediately on trusted receipt age and never resurrects rows after increasing retention', async () => {
      const [{ old, fresh }] = await db.query(
        `SELECT clock_timestamp()-INTERVAL '5 days' AS old,clock_timestamp() AS fresh`,
      );
      await insert(old.toISOString(), '/expired');
      await insert(fresh.toISOString(), '/late-request-fresh-receipt');
      const exports = new LogExportService(db, {
        enabled: true,
        retentionDays: 7,
      } as ObjectStorageService);
      const archive = await exports.create(tenant, {
        from: '1900-01-01T00:00:00Z',
        to: '1900-01-02T00:00:00Z',
      });
      const initial = await service.get(tenant);
      const short = await service.save(tenant, {
        days: 1,
        expectedRevision: initial.revision,
      });
      expect((await logs()).map((l: { path: string }) => l.path)).toEqual([
        '/late-request-fresh-receipt',
      ]);
      const [{ count }] = await db.query(
        `SELECT count(*)::integer AS count FROM ${schema}.request_logs`,
      );
      expect(count).toBe(2);
      await service.save(tenant, {
        days: 90,
        expectedRevision: short.revision,
      });
      expect((await logs()).map((l: { path: string }) => l.path)).toEqual([
        '/late-request-fresh-receipt',
      ]);
      expect(
        (await exports.list(tenant)).jobs.find((j) => j.id === archive.id)
          ?.status,
      ).toBe('expired');
      await service.prune();
      expect((await service.get(tenant)).cleanup).toBe('healthy');
      expect(
        (await db.query(`SELECT path FROM ${schema}.request_logs`)).map(
          (l: { path: string }) => l.path,
        ),
      ).toEqual(['/late-request-fresh-receipt']);
      await exports.onModuleDestroy();
    });
    it('preserves the exact inclusive microsecond cutoff through reads and physical deletion', async () => {
      const [{ floor }] = await db.query(
        `WITH changed AS (UPDATE public.tenants SET "logRetentionDays"=90,"logRetentionFloor"=clock_timestamp()-INTERVAL '2 days',"logRetentionPending"=true WHERE id=$1 RETURNING "logRetentionFloor") SELECT to_char("logRetentionFloor" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS floor FROM changed`,
        [tenant],
      );
      await db.query(
        `INSERT INTO ${schema}.request_logs (id,path,timestamp,"receivedAt") VALUES
      (gen_random_uuid(),'/before',clock_timestamp(),$1::timestamptz-INTERVAL '1 microsecond'),
      (gen_random_uuid(),'/boundary',clock_timestamp(),$1),
      (gen_random_uuid(),'/after',clock_timestamp(),$1::timestamptz+INTERVAL '1 microsecond')`,
        [floor],
      );
      expect((await service.get(tenant)).receivedFrom).toBe(floor);
      expect(
        (await logs()).map((l: { path: string }) => l.path).sort(),
      ).toEqual(['/after', '/boundary']);
      await service.prune();
      expect(
        (
          await db.query(
            `SELECT path FROM ${schema}.request_logs ORDER BY path`,
          )
        ).map((l: { path: string }) => l.path),
      ).toEqual(['/after', '/boundary']);
    });
    it('uses identical 24-hour receipt lifetimes across daylight-saving transitions and session zones', async () => {
      await db.query(
        `UPDATE public.tenants SET "logRetentionDays"=2,"logRetentionFloor"='2000-01-01T00:00:00Z' WHERE id=$1`,
        [tenant],
      );
      for (const zone of ['America/New_York', 'UTC', 'Asia/Kolkata']) {
        const cutoff = await db.transaction(async (manager) => {
          await manager.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          // Only the clock is fixed; evaluate the production cutoff expression on PostgreSQL.
          const expression = RETENTION_CUTOFF_SQL.replaceAll(
            'clock_timestamp()',
            '$1::timestamptz',
          );
          const [row] = await manager.query(
            `SELECT to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff FROM public.tenants WHERE id=$2`,
            ['2026-11-02T12:00:00Z', tenant],
          );
          return row.cutoff;
        });
        expect(cutoff).toBe('2026-10-31T12:00:00.000000Z');
      }
    });
    it('serializes admitted archive inserts and retention edits without a foreign-key deadlock', async () => {
      const initial = await service.get(tenant),
        admission = db.createQueryRunner();
      await admission.connect();
      await admission.startTransaction();
      let change: Promise<unknown> | undefined;
      try {
        await admission.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'log-export:' + tenant,
        ]);
        change = service
          .save(tenant, { days: 7, expectedRevision: initial.revision })
          .catch((error) => error);
        for (let i = 0; i < 50; i++) {
          const [{ waiting }] = await db.query(
            `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`,
          );
          if (waiting) break;
          if (i === 49)
            throw new Error('Retention writer did not reach admission lock');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const [job] = await admission.query(
          `INSERT INTO public.log_export_jobs (tenant_id,filter,expires_at,retention_revision,retention_days,retention_from)
        SELECT id,'{}'::jsonb,clock_timestamp()+INTERVAL '7 days',"logRetentionRevision","logRetentionDays","logRetentionFloor" FROM public.tenants WHERE id=$1 RETURNING id`,
          [tenant],
        );
        await admission.commitTransaction();
        expect(await change).toMatchObject({ days: 7 });
        expect(
          (
            await db.query(
              'SELECT status FROM public.log_export_jobs WHERE id=$1',
              [job.id],
            )
          )[0].status,
        ).toBe('expired');
      } finally {
        if (admission.isTransactionActive)
          await admission.rollbackTransaction();
        await change;
        await admission.release();
      }
    });
    it('does not skip a locked expired row or falsely report completed deletion', async () => {
      const [log] = await db.query(
        `INSERT INTO ${schema}.request_logs (id,path,"receivedAt") VALUES (gen_random_uuid(),'/locked-expired',clock_timestamp()-INTERVAL '40 days') RETURNING id`,
      );
      await db.query(
        'UPDATE public.tenants SET "logRetentionPending"=true,"logRetentionCheckedAt"=NULL WHERE id=$1',
        [tenant],
      );
      const locker = db.createQueryRunner();
      await locker.connect();
      await locker.startTransaction();
      try {
        await locker.query(
          `SELECT id FROM ${schema}.request_logs WHERE id=$1 FOR UPDATE`,
          [log.id],
        );
        const started = performance.now();
        await service.prune();
        expect(performance.now() - started).toBeLessThan(2500);
        expect((await service.get(tenant)).cleanup).toBe('retrying');
        expect(await logs()).toHaveLength(0);
        expect(
          await db.query(`SELECT id FROM ${schema}.request_logs WHERE id=$1`, [
            log.id,
          ]),
        ).toHaveLength(1);
      } finally {
        await locker.rollbackTransaction();
        await locker.release();
      }
      await db.query(
        `UPDATE public.tenants SET "logRetentionCheckedAt"=clock_timestamp()-INTERVAL '2 minutes' WHERE id=$1`,
        [tenant],
      );
      await service.prune();
      expect((await service.get(tenant)).cleanup).toBe('healthy');
      expect(
        await db.query(`SELECT id FROM ${schema}.request_logs WHERE id=$1`, [
          log.id,
        ]),
      ).toHaveLength(0);
    }, 10000);
    it('revokes archives with unknown legacy retention once and preserves proven new snapshots on repeated upgrades', async () => {
      const [legacy] = await db.query(
        `INSERT INTO public.log_export_jobs (tenant_id,status,filter,expires_at,privacy_revision)
        SELECT id,'completed','{}'::jsonb,clock_timestamp()+INTERVAL '7 days',"logPrivacyRevision" FROM public.tenants WHERE id=$1 RETURNING id`,
        [tenant],
      );
      const exports = new LogExportService(db, {
        enabled: true,
        retentionDays: 7,
      } as ObjectStorageService);
      const current = await exports.create(tenant, {
        from: '1900-01-01T00:00:00Z',
        to: '1900-01-02T00:00:00Z',
      });
      await new MigrationService(db).onModuleInit();
      await new MigrationService(db).onModuleInit();
      expect(
        (
          await db.query(
            'SELECT status,error FROM public.log_export_jobs WHERE id=$1',
            [legacy.id],
          )
        )[0],
      ).toMatchObject({
        status: 'expired',
        error: 'Log retention changed. Create a new archive.',
      });
      expect(
        (await exports.list(tenant)).jobs.find((j) => j.id === current.id)
          ?.status,
      ).toBe('queued');
      expect(
        (await exports.list(tenant)).jobs.find((j) => j.id === current.id)
          ?.retention?.revision,
      ).toBe((await service.get(tenant)).revision);
      await exports.onModuleDestroy();
    });
    it('resumes more than one sweep of bounded cleanup after worker restart', async () => {
      await db.query(
        `INSERT INTO ${schema}.request_logs (id,"receivedAt") SELECT gen_random_uuid(),clock_timestamp()-INTERVAL '40 days' FROM generate_series(1,4001)`,
      );
      await db.query(
        'UPDATE public.tenants SET "logRetentionPending"=true,"logRetentionCheckedAt"=NULL WHERE id=$1',
        [tenant],
      );
      await service.prune();
      expect(
        (
          await db.query(
            `SELECT count(*)::integer AS count FROM ${schema}.request_logs`,
          )
        )[0].count,
      ).toBe(1);
      expect((await service.get(tenant)).cleanup).toBe('pending');
      const restarted = new LogRetentionService(db);
      await restarted.prune();
      expect(
        (
          await db.query(
            `SELECT count(*)::integer AS count FROM ${schema}.request_logs`,
          )
        )[0].count,
      ).toBe(0);
      expect((await restarted.get(tenant)).cleanup).toBe('healthy');
      await restarted.onModuleDestroy();
    });
    it('reports bounded failures and still cleans another tenant without a hot retry loop', async () => {
      await db.query('DROP TABLE ' + tenantSchema(other) + '.request_logs');
      await db.query(
        `INSERT INTO ${schema}.request_logs (id,"receivedAt") VALUES (gen_random_uuid(),clock_timestamp()-INTERVAL '40 days')`,
      );
      await db.query(
        'UPDATE public.tenants SET "logRetentionPending"=true,"logRetentionCheckedAt"=NULL',
      );
      await service.prune();
      expect((await service.get(other)).cleanup).toBe('retrying');
      expect((await service.get(tenant)).cleanup).toBe('healthy');
      const checked = (await service.get(other)).lastCheckedAt;
      await service.prune();
      expect((await service.get(other)).lastCheckedAt).toBe(checked);
      await new TenantProvisioningService(db).provisionTenant(other);
    });
  },
);
