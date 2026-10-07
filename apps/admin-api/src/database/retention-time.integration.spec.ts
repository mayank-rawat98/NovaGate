import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource, type EntityManager } from 'typeorm';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { MigrationService } from './migration.service';
import { TracesService } from '../proxy-config/traces.service';
import { LogExportService } from '../log-export/log-export.service';
import { LogExportSchedulerService } from '../log-export/log-export-scheduler.service';
import { ObjectStorageService } from '../log-export/object-storage.service';
import { AlertRulesService } from '../alerts/alert-rules.service';
import { AlertEvaluatorService } from '../alerts/alert-evaluator.service';
import { AlertDeliveryService } from '../alerts/alert-delivery.service';
import { AlertTransportService } from '../alerts/alert-transport.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const cases = (times: string[]) =>
  ['UTC', 'America/New_York', 'Asia/Kolkata'].flatMap((zone) =>
    times.map((now) => ({ zone, now })),
  );
const afterTransitions = cases([
  '2026-03-09T12:00:00Z',
  '2026-11-02T12:00:00Z',
]);
const beforeTransitions = cases([
  '2026-03-06T12:00:00Z',
  '2026-10-30T12:00:00Z',
]);
integration(
  'Elapsed-day reads, deliveries and archive lifetimes on PostgreSQL',
  () => {
    const database = 'novagate_admin_time_' + randomUUID().replace(/-/g, '');
    const tenant = randomUUID(),
      schema = tenantSchema(tenant);
    const traceId = '0123456789abcdef0123456789abcdef';
    let root: DataSource, db: DataSource, source: DataSource;
    let zone: string, now: string;
    let rules: AlertRulesService,
      evaluator: AlertEvaluatorService,
      delivery: AlertDeliveryService;
    let exports: LogExportService, schedules: LogExportSchedulerService;
    const cleanup = jest.fn().mockResolvedValue(undefined);
    const deliver = jest.fn().mockResolvedValue(undefined);
    const storage = {
      enabled: true,
      retentionDays: 7,
      cleanup,
    } as unknown as ObjectStorageService;
    const config = new ConfigService({
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 7).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    });
    const fixedClock = (sql: string) =>
      sql.replace(/\b(?:NOW|clock_timestamp)\(\)/gi, `'${now}'::timestamptz`);

    beforeAll(async () => {
      root = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await root.initialize();
      await root.query('CREATE DATABASE ' + database);
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      url.pathname = '/' + database;
      db = new DataSource({ type: 'postgres', url: url.toString() });
      await db.initialize();
      await db.query(
        readFileSync(
          resolve(__dirname, '../../../../docker/postgres-init.sql'),
          'utf8',
        ),
      );
      await db.query(
        `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Time fixture',$2,'free')`,
        [tenant, tenant + '@example.test'],
      );
      await new TenantProvisioningService(db).provisionTenant(tenant);
      await new MigrationService(db).onModuleInit();
    }, 30000);
    afterEach(async () => {
      await delivery?.onModuleDestroy();
      await evaluator?.onModuleDestroy();
      await rules?.onModuleDestroy();
      await exports?.onModuleDestroy();
      await schedules?.onModuleDestroy();
    });
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (root?.isInitialized) {
        await root.query(
          'DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)',
        );
        await root.destroy();
      }
    });
    async function prepare(input: { zone: string; now: string }) {
      ({ zone, now } = input);
      cleanup.mockClear();
      deliver.mockClear();
      const transaction = (
        isolationOrFn:
          | 'READ COMMITTED'
          | ((manager: EntityManager) => Promise<unknown>),
        optionalFn?: (manager: EntityManager) => Promise<unknown>,
      ) => {
        const callback =
          typeof isolationOrFn === 'function' ? isolationOrFn : optionalFn;
        if (!callback) throw new Error('Expected transaction callback');
        const run = async (manager: EntityManager) => {
          await manager.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          return callback({
            query: (sql: string, params?: unknown[]) =>
              manager.query(fixedClock(sql), params),
          } as EntityManager);
        };
        return typeof isolationOrFn === 'function'
          ? db.transaction(run)
          : db.transaction(isolationOrFn, run);
      };
      // Freeze only database clock calls; all predicates, locks and service state
      // transitions still execute on real PostgreSQL in the selected session zone.
      source = {
        transaction,
        query: (sql: string, params?: unknown[]) =>
          transaction((manager) => manager.query(sql, params)),
      } as unknown as DataSource;
      await db.query(`DELETE FROM public.alert_delivery_schedule;
      DELETE FROM ${schema}.alert_events; DELETE FROM ${schema}.alert_channels;
      DELETE FROM public.log_export_jobs; DELETE FROM public.log_export_schedules;
      TRUNCATE ${schema}.trace_spans, ${schema}.request_logs;
      UPDATE public.tenants SET "logRetentionFloor"='2000-01-01T00:00:00Z'`);
      rules = new AlertRulesService(source, config);
      evaluator = new AlertEvaluatorService(source, rules);
      delivery = new AlertDeliveryService(source, rules, {
        deliver,
      } as unknown as AlertTransportService);
      exports = new LogExportService(source, storage);
      schedules = new LogExportSchedulerService(source, storage);
    }
    async function alertEvents() {
      const ids: string[] = [];
      for (const offset of [-1, 0, 1]) {
        const [{ id }] = await db.query(
          `INSERT INTO ${schema}.alert_events
        ("ruleName",metric,operator,threshold,"windowMinutes",state,value,"createdAt")
        VALUES('Boundary','error_rate','>',0.1,1,'firing',0.5,$1::timestamptz-INTERVAL '720 hours'+$2*INTERVAL '1 microsecond') RETURNING id`,
          [now, offset],
        );
        ids.push(id);
      }
      return ids;
    }
    it.each(afterTransitions)(
      'trace detail retains the inclusive microsecond cutoff: $zone $now',
      async (input) => {
        await prepare(input);
        for (const [index, offset] of [-1, 0, 1].entries())
          await db.query(
            `INSERT INTO ${schema}.trace_spans ("traceId","spanId",name,kind,timestamp,"durationMs",status,attributes)
        VALUES($1,$2,'Boundary','server',$3::timestamptz-INTERVAL '48 hours'+$4*INTERVAL '1 microsecond',1,'ok','{}')`,
            [traceId, index.toString(16).padStart(16, '1'), now, offset],
          );
        const traces = new TracesService(
          source,
          new ConfigService({ traceQueries: { retentionDays: 2 } }),
        );
        const result = await traces.detail(tenant, traceId);
        expect(result.spans.map((s) => s.spanId)).toEqual([
          '1111111111111111',
          '1111111111111112',
        ]);
      },
    );
    it.each(afterTransitions)(
      'alert read and physical history cleanup agree at the microsecond boundary: $zone $now',
      async (input) => {
        await prepare(input);
        const ids = await alertEvents();
        for (const id of ids) {
          const [{ id: deliveryId }] = await db.query(
            `INSERT INTO ${schema}.alert_deliveries ("eventId","channelName",type,"channelRevision") VALUES($1,'Boundary','webhook',1) RETURNING id`,
            [id],
          );
          await db.query(
            'INSERT INTO public.alert_delivery_schedule("tenantId","deliveryId") VALUES($1,$2)',
            [tenant, deliveryId],
          );
        }
        expect((await rules.history(tenant)).map((e) => e.id)).toEqual([
          ids[2],
          ids[1],
        ]);
        await rules.withTenantTransaction(tenant, (manager, name) =>
          evaluator.pruneTenant(manager, name, tenant),
        );
        expect(
          (
            await db.query(
              `SELECT id FROM ${schema}.alert_events ORDER BY "createdAt" DESC`,
            )
          ).map((e: { id: string }) => e.id),
        ).toEqual([ids[2], ids[1]]);
        expect(
          (await db.query('SELECT * FROM public.alert_delivery_schedule'))
            .length,
        ).toBe(2);
        expect(
          (await db.query(`SELECT * FROM ${schema}.alert_deliveries`)).length,
        ).toBe(2);
      },
    );
    it.each(afterTransitions)(
      'alert delivery rejects expired events before any transport attempt: $zone $now',
      async (input) => {
        await prepare(input);
        const ids = await alertEvents();
        const channel = await rules.createChannel(tenant, {
          name: 'Boundary',
          type: 'webhook',
          url: 'https://example.test/events',
          secret: 'fixture-only-signing-secret-at-least-32-bytes',
        });
        const deliveries: string[] = [];
        for (const event of ids) {
          const [{ id }] = await db.query(
            `INSERT INTO ${schema}.alert_deliveries ("eventId","channelId","channelName",type,"channelRevision") VALUES($1,$2,'Boundary','webhook',1) RETURNING id`,
            [event, channel.id],
          );
          await db.query(
            'INSERT INTO public.alert_delivery_schedule("tenantId","deliveryId","dueAt") VALUES($1,$2,$3)',
            [tenant, id, now],
          );
          deliveries.push(id);
        }
        const leases = await delivery.claimDue();
        expect(leases).toHaveLength(3);
        for (const id of deliveries) {
          const lease = leases.find((l) => l.deliveryId === id);
          if (!lease) throw new Error('Missing claimed boundary delivery');
          expect(await delivery.deliverLease(lease)).toBe(id !== deliveries[0]);
        }
        expect(deliver).toHaveBeenCalledTimes(2);
        const states = await db.query(
          `SELECT id,status,attempts FROM ${schema}.alert_deliveries`,
        );
        expect(
          states.find((s: { id: string }) => s.id === deliveries[0]),
        ).toMatchObject({ status: 'cancelled', attempts: 0 });
        for (const id of deliveries.slice(1))
          expect(states.find((s: { id: string }) => s.id === id)).toMatchObject(
            { status: 'delivered', attempts: 1 },
          );
      },
    );
    it.each(beforeTransitions)(
      'manual and scheduled jobs have the same exact seven-day download lifetime: $zone $now',
      async (input) => {
        await prepare(input);
        const manual = await exports.create(tenant, {
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-01T01:00:00Z',
        });
        expect(Date.parse(manual.expiresAt) - Date.parse(now)).toBe(
          7 * 86400000,
        );
        await schedules.save(tenant, {
          enabled: true,
          cadence: 'near_real_time',
          filter: {},
          expectedRevision: null,
        });
        await db.query(
          `UPDATE public.log_export_schedules SET cursor_at=$1::timestamptz-INTERVAL '2 minutes',started_at=$1::timestamptz-INTERVAL '5 minutes',next_due_at=$1::timestamptz-INTERVAL '1 second'`,
          [now],
        );
        await db.query(
          `INSERT INTO ${schema}.request_logs(id,path,timestamp,"receivedAt") VALUES(gen_random_uuid(),'/boundary',$1,$1::timestamptz-INTERVAL '90 seconds')`,
          [now],
        );
        expect(await schedules.scheduleNext()).toBe(true);
        const jobs = (await exports.list(tenant)).jobs;
        expect(jobs).toHaveLength(2);
        expect(jobs.map((j) => j.kind).sort()).toEqual(['manual', 'scheduled']);
        for (const job of jobs)
          expect(Date.parse(job.expiresAt) - Date.parse(now)).toBe(
            7 * 86400000,
          );
      },
    );
    it.each(afterTransitions)(
      'archive metadata cleanup retains the exact thirty-day boundary: $zone $now',
      async (input) => {
        await prepare(input);
        const ids: string[] = [];
        for (const offset of [-1, 0, 1]) {
          const [{ id }] = await db.query(
            `INSERT INTO public.log_export_jobs(tenant_id,filter,expires_at,status) VALUES($1,'{}',$2::timestamptz-INTERVAL '720 hours'+$3*INTERVAL '1 microsecond','failed') RETURNING id`,
            [tenant, now, offset],
          );
          ids.push(id);
        }
        await exports.cleanupExpired();
        const jobs = (await exports.list(tenant)).jobs;
        expect(jobs.map((j) => j.id).sort()).toEqual(ids.slice(1).sort());
        expect(jobs.every((j) => j.status === 'expired')).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(3);
      },
    );
  },
);
