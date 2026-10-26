import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { MigrationService } from '../database/migration.service';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import {
  LogExportSchedulerService,
  validateSchedule,
} from './log-export-scheduler.service';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a saved archive schedule');
  return value;
}
const settings = {
  enabled: true,
  cadence: 'near_real_time',
  filter: {},
  expectedRevision: null,
};
const storage = { enabled: true, retentionDays: 7 } as ObjectStorageService;
describe('Schedule input and lifecycle boundaries', () => {
  it.each([
    null,
    [],
    {},
    { ...settings, enabled: 'true' },
    { ...settings, cadence: 'daily' },
    { ...settings, filter: null },
    { ...settings, filter: { from: '2026-01-01' } },
    { ...settings, filter: { pathPrefix: '/bad\npath' } },
    { ...settings, filter: { minStatusCode: 600 } },
    { ...settings, filter: { consumerId: '../other' } },
    { ...settings, expectedRevision: undefined },
    { ...settings, expectedRevision: 1 },
    { ...settings, destination: 'http://private/' },
  ])('rejects unsupported settings before persistence: %j', (body) => {
    expect(() => validateSchedule(body)).toThrow();
  });
  it('normalizes IDs without accepting a caller-owned cursor or time basis', () => {
    const id = randomUUID();
    expect(
      validateSchedule({
        ...settings,
        expectedRevision: id.toUpperCase(),
        filter: { consumerId: id.toUpperCase() },
      }),
    ).toEqual({
      ...settings,
      expectedRevision: id,
      filter: { consumerId: id },
    });
    expect(() =>
      validateSchedule({ ...settings, cursor: '2000-01-01T00:00:00Z' }),
    ).toThrow();
    expect(() =>
      validateSchedule({ ...settings, timeBasis: 'request' }),
    ).toThrow();
  });
  it('starts one timer, prevents overlapping sweeps and drains actual work before stopping', async () => {
    jest.useFakeTimers();
    const service = new LogExportSchedulerService({} as DataSource, storage);
    let finish!: (value: boolean) => void;
    const next = jest
      .spyOn(service, 'scheduleNext')
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      )
      .mockResolvedValue(false);
    try {
      service.onApplicationBootstrap();
      service.onApplicationBootstrap();
      jest.advanceTimersByTime(10000);
      expect(next).toHaveBeenCalledTimes(1);
      let stopped = false;
      const shutdown = service.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish(true);
      await shutdown;
      jest.advanceTimersByTime(10000);
      expect(next).toHaveBeenCalledTimes(1);
      next.mockRestore();
      expect(await service.scheduleNext()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
  it('never starts scheduling when object storage is disabled', async () => {
    const db = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    } as unknown as DataSource;
    const service = new LogExportSchedulerService(db, {
      enabled: false,
    } as ObjectStorageService);
    service.onApplicationBootstrap();
    await service.tick();
    await expect(service.save(randomUUID(), settings)).rejects.toThrow(
      'not enabled',
    );
    expect(db.transaction).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });
});

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration(
  'Durable receipt schedules on real PostgreSQL with a non-UTC session',
  () => {
    let root: DataSource;
    let db: DataSource;
    let schedules: LogExportSchedulerService;
    let replica: LogExportSchedulerService;
    const database = `novagate_schedules_${randomUUID().replace(/-/g, '')}`;
    const tenant = randomUUID();
    const other = randomUUID();
    const schema = tenantSchema(tenant);
    const from = new Date(
      Math.floor((Date.now() - 180000) / 60000) * 60000,
    ).toISOString();
    const to = new Date(Date.parse(from) + 60000).toISOString();
    async function due(id = tenant, cursor = from) {
      const state = await schedules.save(id, settings);
      await db.query(
        `UPDATE public.log_export_schedules SET cursor_at=$2,next_due_at=clock_timestamp()-INTERVAL '1 second' WHERE tenant_id=$1`,
        [id, cursor],
      );
      return required(state.schedule);
    }
    async function log(
      id: string,
      receipt: string,
      requestTime = '2000-01-01T00:00:00Z',
      path = '/scheduled',
      status = 200,
      consumer: string | null = null,
    ) {
      await db.query(
        `INSERT INTO ${schema}.request_logs (id,path,"statusCode","consumerId",timestamp,"receivedAt") VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, path, status, consumer, requestTime, receipt],
      );
    }
    beforeAll(async () => {
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
          options: '-c timezone=Asia/Kolkata',
          max: 20,
          connectionTimeoutMillis: 3000,
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
          `INSERT INTO public.tenants (id,name,email,"planId") VALUES ($1,'Schedule test',$2,'free')`,
          [id, `${id}@example.test`],
        );
        await new TenantProvisioningService(db).provisionTenant(id);
      }
      await new MigrationService(db).onModuleInit();
      schedules = new LogExportSchedulerService(db, storage);
      replica = new LogExportSchedulerService(db, storage);
    }, 30000);
    beforeEach(async () => {
      await db.query(
        `TRUNCATE public.log_export_jobs,public.log_export_schedules`,
      );
      await db.query(`DELETE FROM ${schema}.request_logs`);
      await db.query(
        `UPDATE public.tenants SET "logRetentionDays"=30,"logRetentionFloor"=clock_timestamp()-INTERVAL '30 days'`,
      );
    });
    afterAll(async () => {
      await schedules?.onModuleDestroy();
      await replica?.onModuleDestroy();
      if (db?.isInitialized) await db.destroy();
      if (root?.isInitialized) {
        await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await root.destroy();
      }
    }, 30000);
    it('starts at database save time, aligns hourly UTC boundaries, and returns no internal lease/filter state', async () => {
      expect((await db.query('SHOW TimeZone'))[0].TimeZone).toBe(
        'Asia/Kolkata',
      );
      const before = Date.now();
      const result = await schedules.save(tenant.toUpperCase(), {
        ...settings,
        cadence: 'hourly',
      });
      expect(
        Date.parse(required(result.schedule).cursor),
      ).toBeGreaterThanOrEqual(before - 1000);
      expect(required(result.schedule).nextWindowAt).toMatch(/:00:00\.000Z$/);
      expect(result.pendingJobs).toBe(0);
      expect((await schedules.get(other)).schedule).toBeNull();
      expect(JSON.stringify(result)).not.toContain('tenant_id');
      expect(await schedules.scheduleNext()).toBe(false);
    });
    it('serializes two create/update replicas and rejects stale revisions, including delete/recreate ABA', async () => {
      const results = await Promise.allSettled([
        schedules.save(tenant, settings),
        replica.save(tenant, settings),
      ]);
      expect(
        results.filter((item) => item.status === 'fulfilled'),
      ).toHaveLength(1);
      const original = required((await schedules.get(tenant)).schedule);
      const edits = await Promise.allSettled([
        schedules.save(tenant, {
          ...settings,
          enabled: false,
          expectedRevision: original.revision,
        }),
        replica.save(tenant, {
          ...settings,
          cadence: 'hourly',
          expectedRevision: original.revision,
        }),
      ]);
      expect(edits.filter((item) => item.status === 'fulfilled')).toHaveLength(
        1,
      );
      const updated = required((await schedules.get(tenant)).schedule);
      await expect(
        schedules.remove(tenant, { expectedRevision: original.revision }),
      ).rejects.toThrow('changed');
      await schedules.remove(tenant, { expectedRevision: updated.revision });
      const recreated = required(
        (await schedules.save(tenant, settings)).schedule,
      );
      expect(recreated.id).not.toBe(original.id);
      await expect(
        schedules.save(tenant, {
          ...settings,
          expectedRevision: original.revision,
        }),
      ).rejects.toThrow('changed');
    });
    it('creates half-open receipt windows once across replicas and includes gateway logs from long ago', async () => {
      const schedule = await due();
      await log(randomUUID(), from);
      await log(randomUUID(), new Date(Date.parse(to) - 1).toISOString());
      await log(randomUUID(), to);
      await log(randomUUID(), new Date(Date.parse(from) - 1).toISOString());
      await Promise.all([schedules.scheduleNext(), replica.scheduleNext()]);
      expect(
        await db.query(
          `SELECT id FROM public.log_export_jobs WHERE window_from=$1`,
          [from],
        ),
      ).toHaveLength(1);
      await schedules.scheduleNext();
      const jobs = await db.query(
        `SELECT * FROM public.log_export_jobs ORDER BY window_from`,
      );
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
        schedule_id: schedule.id,
        time_basis: 'receipt',
        kind: 'scheduled',
        window_from: new Date(from),
        window_to: new Date(to),
      });
      expect(
        new Set(
          jobs.map((job: { window_from: Date }) =>
            job.window_from.toISOString(),
          ),
        ).size,
      ).toBe(2);
      await schedules.tick();
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(2);
      expect((await schedules.get(other)).pendingJobs).toBe(0);
    });
    it('preserves a partial first window to the microsecond rather than including pre-save receipt rows', async () => {
      const cursor = from.slice(0, 17) + '56.123456Z';
      await due(tenant, cursor);
      await log(randomUUID(), from.slice(0, 17) + '56.123455Z');
      await log(randomUUID(), from.slice(0, 17) + '56.123457Z');
      expect(required((await schedules.get(tenant)).schedule).cursor).toBe(
        cursor,
      );
      await schedules.scheduleNext();
      const [job] = await db.query(`SELECT filter FROM public.log_export_jobs`);
      expect(job.filter.from).toBe(cursor);
      expect(
        (
          await db.query(
            `SELECT COUNT(*)::integer AS count FROM ${schema}.request_logs WHERE "receivedAt">=$1::timestamptz AND "receivedAt"<$2::timestamptz`,
            [job.filter.from, job.filter.to],
          )
        )[0].count,
      ).toBe(1);
    });
    it('fast-forwards fully expired backlog once and reports skipped windows', async () => {
      const state = await due(
        tenant,
        new Date(Date.now() - 40 * 86400000).toISOString(),
      );
      await log(randomUUID(), from);
      await schedules.scheduleNext();
      const schedule = required((await schedules.get(tenant)).schedule);
      expect(schedule.retentionSkippedWindows).toBeGreaterThan(10000);
      expect(Date.parse(schedule.cursor)).toBeGreaterThan(
        Date.now() - 31 * 86400000,
      );
      expect(schedule.revision).toBe(state.revision);
      const jobs = await db.query('SELECT * FROM public.log_export_jobs');
      expect(jobs).toHaveLength(0);
    });
    it('archives only retained receipts in a partial window and labels its data loss', async () => {
      await due();
      const cutoff = from.slice(0, 17) + '30.123456Z';
      await db.query(
        `UPDATE public.tenants SET "logRetentionDays"=90,"logRetentionFloor"=$2 WHERE id=$1`,
        [tenant, cutoff],
      );
      await log(randomUUID(), from);
      await log(randomUUID(), cutoff);
      await schedules.scheduleNext();
      const state = await schedules.get(tenant);
      expect(required(state.schedule).retentionSkippedWindows).toBe(1);
      const [job] = await db.query(
        `SELECT filter,retention_days,to_char(retention_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff FROM public.log_export_jobs`,
      );
      expect(job.filter.from).toBe(from);
      expect(job.cutoff).toBe(cutoff);
      expect(job.retention_days).toBe(90);
    });
    it('honors status, literal path prefix and consumer filters before creating a window job', async () => {
      const consumer = randomUUID();
      const schedule = await due();
      await schedules.save(tenant, {
        ...settings,
        expectedRevision: schedule.revision,
        filter: { minStatusCode: 500, pathPrefix: '/%_', consumerId: consumer },
      });
      await log(randomUUID(), from, undefined, '/products', 500, consumer);
      await log(randomUUID(), from, undefined, '/%_literal', 200, consumer);
      await log(randomUUID(), from, undefined, '/%_literal', 500, randomUUID());
      await schedules.scheduleNext();
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(0);
      const current = required((await schedules.get(tenant)).schedule);
      const receipt = current.cursor;
      await log(randomUUID(), receipt, undefined, '/%_literal', 500, consumer);
      await db.query(
        `UPDATE public.log_export_schedules SET next_due_at=clock_timestamp()-INTERVAL '1 second'`,
      );
      await schedules.scheduleNext();
      expect(
        (await db.query(`SELECT filter FROM public.log_export_jobs`))[0].filter,
      ).toMatchObject({
        minStatusCode: 500,
        pathPrefix: '/%_',
        consumerId: consumer,
        from: receipt,
      });
    });
    it('advances empty windows without empty objects and enforces a finite sweep for long idle backlogs', async () => {
      const old = new Date(Date.parse(from) - 86400000).toISOString();
      await due(tenant, old);
      await schedules.tick();
      expect(
        Date.parse(required((await schedules.get(tenant)).schedule).cursor),
      ).toBe(Date.parse(old) + 16 * 60000);
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(0);
      expect((await schedules.get(tenant)).backlogSeconds).toBeGreaterThan(0);
    });
    it("visits another due tenant before continuing one tenant's much older backlog", async () => {
      await due(tenant, new Date(Date.parse(from) - 86400000).toISOString());
      await due(other, from);
      await schedules.tick();
      expect(
        Date.parse(required((await schedules.get(other)).schedule).cursor),
      ).toBeGreaterThan(Date.parse(from));
      expect((await schedules.get(tenant)).backlogSeconds).toBeGreaterThan(0);
    });
    it('retains cursor while the queue is full, then recovers without dropping its window', async () => {
      await due();
      await log(randomUUID(), from);
      const exports = new LogExportService(db, storage);
      await Promise.all(
        Array.from({ length: 20 }, () => exports.create(tenant, { from, to })),
      );
      await schedules.scheduleNext();
      const blocked = await schedules.get(tenant);
      expect(blocked.pendingJobs).toBe(20);
      expect(required(blocked.schedule).cursor).toBe(from);
      expect(required(blocked.schedule).error).toContain(
        'log retention still applies',
      );
      await db.query(`UPDATE public.log_export_jobs SET status='failed'`);
      await db.query(
        `UPDATE public.log_export_schedules SET next_due_at=clock_timestamp()-INTERVAL '1 second'`,
      );
      await schedules.scheduleNext();
      expect(required((await schedules.get(tenant)).schedule).cursor).toBe(to);
      expect(
        required((await schedules.get(tenant)).schedule).error,
      ).toBeUndefined();
      expect(
        await db.query(
          `SELECT id FROM public.log_export_jobs WHERE kind='scheduled'`,
        ),
      ).toHaveLength(1);
    });
    it('pause and updates retain backlog; removing a schedule preserves immutable queued jobs', async () => {
      const schedule = await due();
      await log(randomUUID(), from);
      const paused = await schedules.save(tenant, {
        ...settings,
        enabled: false,
        expectedRevision: schedule.revision,
      });
      await schedules.tick();
      expect(required(paused.schedule).cursor).toBe(from);
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(0);
      const resumed = await schedules.save(tenant, {
        ...settings,
        expectedRevision: required(paused.schedule).revision,
      });
      expect(required(resumed.schedule).cursor).toBe(from);
      await schedules.scheduleNext();
      const before = (
        await db.query(`SELECT * FROM public.log_export_jobs`)
      )[0];
      await schedules.remove(tenant, {
        expectedRevision: required(resumed.schedule).revision,
      });
      const after = (await db.query(`SELECT * FROM public.log_export_jobs`))[0];
      expect(after.id).toBe(before.id);
      expect(after.filter).toEqual(before.filter);
      expect(after.status).toBe('queued');
      expect(after.schedule_id).toBeNull();
      expect(after.time_basis).toBe('receipt');
    });
    it('serializes a pause racing a scheduler and keeps previously queued filters immutable', async () => {
      const original = await due();
      await log(randomUUID(), from);
      await Promise.all([
        schedules.scheduleNext(),
        replica.save(tenant, {
          ...settings,
          enabled: false,
          expectedRevision: original.revision,
        }),
      ]);
      const jobs = await db.query(`SELECT * FROM public.log_export_jobs`);
      expect(jobs.length).toBeLessThanOrEqual(1);
      await schedules.tick();
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(jobs.length);
      const paused = required((await schedules.get(tenant)).schedule);
      await schedules.save(tenant, {
        ...settings,
        filter: { minStatusCode: 599 },
        expectedRevision: paused.revision,
      });
      expect(
        (await db.query(`SELECT filter FROM public.log_export_jobs`)).map(
          (row: { filter: unknown }) => row.filter,
        ),
      ).toEqual(jobs.map((row: { filter: unknown }) => row.filter));
    });
    it('fences uncommitted receipt writes rather than moving past an incomplete ingestion transaction', async () => {
      await due();
      const writer = db.createQueryRunner();
      await writer.connect();
      await writer.startTransaction();
      try {
        await writer.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          [`log-receipt:${tenant}`],
        );
        await writer.query(
          `INSERT INTO ${schema}.request_logs (id,path,timestamp,"receivedAt") VALUES ($1,'/uncommitted','2000-01-01T00:00:00Z',$2)`,
          [randomUUID(), from],
        );
        await schedules.scheduleNext();
        expect(required((await schedules.get(tenant)).schedule).cursor).toBe(
          from,
        );
        expect(
          await db.query(`SELECT id FROM public.log_export_jobs`),
        ).toHaveLength(0);
        await writer.commitTransaction();
      } finally {
        if (writer.isTransactionActive) await writer.rollbackTransaction();
        await writer.release();
      }
      await db.query(
        `UPDATE public.log_export_schedules SET next_due_at=clock_timestamp()-INTERVAL '1 second'`,
      );
      await schedules.scheduleNext();
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(1);
    });
    it('rolls back the job and cursor together when final cursor persistence fails', async () => {
      await due();
      await log(randomUUID(), from);
      await db.query(`CREATE FUNCTION public.reject_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cursor_at<>OLD.cursor_at THEN RAISE EXCEPTION 'verification cursor failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_cursor BEFORE UPDATE ON public.log_export_schedules FOR EACH ROW EXECUTE FUNCTION public.reject_cursor()`);
      try {
        await expect(schedules.scheduleNext()).rejects.toThrow(
          'verification cursor failure',
        );
        expect(
          await db.query(`SELECT id FROM public.log_export_jobs`),
        ).toHaveLength(0);
        expect(required((await schedules.get(tenant)).schedule).cursor).toBe(
          from,
        );
      } finally {
        await db.query(
          `DROP TRIGGER reject_cursor ON public.log_export_schedules; DROP FUNCTION public.reject_cursor()`,
        );
      }
      await replica.scheduleNext();
      expect(
        await db.query(`SELECT id FROM public.log_export_jobs`),
      ).toHaveLength(1);
      expect(required((await schedules.get(tenant)).schedule).cursor).toBe(to);
    });
    it('holds the settlement interval and isolates malformed or foreign tenant selectors', async () => {
      const cursor = new Date(
        Math.floor(Date.now() / 60000) * 60000,
      ).toISOString();
      await due(tenant, cursor);
      await schedules.scheduleNext();
      expect(required((await schedules.get(tenant)).schedule).cursor).toBe(
        cursor,
      );
      await expect(
        schedules.get('tenant; DROP TABLE public.tenants'),
      ).rejects.toThrow();
      await expect(
        schedules.save(other, {
          ...settings,
          expectedRevision: required((await schedules.get(tenant)).schedule)
            .revision,
        }),
      ).rejects.toThrow('changed');
      expect((await schedules.get(other)).schedule).toBeNull();
    });
    it('bounds a blocked schedule status read and recovers after the competing transaction releases it', async () => {
      await schedules.save(tenant, settings);
      const locker = db.createQueryRunner();
      await locker.connect();
      await locker.startTransaction();
      try {
        await locker.query(
          `LOCK TABLE public.log_export_jobs IN ACCESS EXCLUSIVE MODE`,
        );
        await expect(schedules.get(tenant)).rejects.toThrow('lock timeout');
      } finally {
        await locker.rollbackTransaction();
        await locker.release();
      }
      expect(required((await schedules.get(tenant)).schedule).enabled).toBe(
        true,
      );
    });
    it('normalizes legacy naive log times as UTC, adds receipt defaults and remains idempotent', async () => {
      const legacy = tenantSchema(other);
      await db.query(
        `ALTER TABLE ${legacy}.request_logs DROP COLUMN "receivedAt", ALTER COLUMN timestamp TYPE TIMESTAMP USING timestamp AT TIME ZONE 'UTC'`,
      );
      const id = randomUUID();
      await db.query(
        `INSERT INTO ${legacy}.request_logs (id,timestamp) VALUES ($1,'2026-01-01 12:34:56.123456'::timestamp)`,
        [id],
      );
      await new MigrationService(db).onModuleInit();
      const [first] = await db.query(
        `SELECT to_char(timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS utc,"receivedAt" FROM ${legacy}.request_logs WHERE id=$1`,
        [id],
      );
      expect(first.utc).toBe('2026-01-01T12:34:56.123456Z');
      expect(first.receivedAt).toBeInstanceOf(Date);
      await new MigrationService(db).onModuleInit();
      const [second] = await db.query(
        `SELECT timestamp,"receivedAt" FROM ${legacy}.request_logs WHERE id=$1`,
        [id],
      );
      expect(second.timestamp.toISOString()).toBe('2026-01-01T12:34:56.123Z');
      expect(second.receivedAt).toEqual(first.receivedAt);
    });
  },
);
