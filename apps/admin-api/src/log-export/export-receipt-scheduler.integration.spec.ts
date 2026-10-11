import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { DataSource, type EntityManager } from 'typeorm';
import type {
  LogExportDeliverySchedule,
  LogExportDestinationType,
  LogExportDeliveryBatch,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { ExportDestinationsService } from './export-destinations.service';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { ExportDeliverySchedulerService } from './export-delivery-scheduler.service';
import { ExportDeliveryWorkerService } from './export-delivery-worker.service';
import { ExportTransportService } from './export-transport.service';
import { exportDeliveryBody } from './export-delivery-encoding';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const keySettings = {
  LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({
    fixture: Buffer.alloc(32, 9).toString('base64'),
  }),
  LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'fixture',
};
integration(
  'External receipt producer and replica scheduling on PostgreSQL',
  () => {
    let root: DataSource,
      db: DataSource,
      store: ExportDeliveryStoreService,
      replica: ExportDeliveryStoreService,
      destinations: ExportDestinationsService;
    let clock: string | undefined;
    const tenant = randomUUID(),
      other = randomUUID(),
      database = `novagate_receipts_${randomUUID().replace(/-/g, '')}`;
    const config = new ConfigService(keySettings);
    const schedulers = new Set<ExportDeliverySchedulerService>();
    const runtimes = new Set<Promise<void>>();
    const resourceCleanup = new Set<() => Promise<unknown>>();
    function clockDatabase() {
      // Freeze only the clock in production SQL. Predicates, locks, windows and
      // transactions remain real; this avoids weakening minute/hour test budgets.
      return {
        transaction: (work: (manager: EntityManager) => Promise<unknown>) =>
          db.transaction((manager) =>
            work({
              query: (sql: string, params: unknown[] = []) => {
                if (!clock || !sql.includes('clock_timestamp()'))
                  return manager.query(sql, params);
                return manager.query(
                  sql.replaceAll(
                    'clock_timestamp()',
                    `$${params.length + 1}::timestamptz`,
                  ),
                  [...params, clock],
                );
              },
            } as unknown as EntityManager),
          ),
      } as unknown as DataSource;
    }
    async function schedule(
      type: LogExportDestinationType = 'webhook',
      owner = tenant,
    ) {
      const created = await destinations.create(owner, {
        name: `Receipt ${type}`,
        credentials:
          type === 'webhook'
            ? {
                type,
                url: 'https://logs.example.com/controlled',
                signingSecret: 'fixture-signing-secret-more-than-32-bytes',
              }
            : type === 'datadog'
              ? { type, site: 'datadoghq.eu', apiKey: 'a'.repeat(32) }
              : {
                  type,
                  endpoint: 'https://s3.example.com',
                  region: 'us-east-1',
                  bucket: 'fixture-logs',
                  forcePathStyle: true,
                  accessKeyId: 'fixture',
                  secretAccessKey: 'fixture',
                },
      });
      return store.saveSchedule(owner, created.id, {
        enabled: true,
        cadence: 'near_real_time',
        filter: {},
        payloadPrivacy: { clientIp: 'omit', userAgent: 'omit' },
        expectedRevision: null,
        expectedDestinationRevision: created.revision,
      });
    }
    async function save(
      current: LogExportDeliverySchedule,
      changes: Record<string, unknown>,
    ) {
      return store.saveSchedule(tenant, current.destinationId, {
        enabled: current.enabled,
        cadence: current.cadence,
        filter: current.filter,
        payloadPrivacy: current.payloadPrivacy,
        expectedRevision: current.revision,
        expectedDestinationRevision: current.destinationRevision,
        ...changes,
      });
    }
    async function readyWindow(
      current: LogExportDeliverySchedule,
      startAt?: string,
    ) {
      const [{ start, end }] = await db.query(
        `SELECT to_char(b AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
      to_char((b+INTERVAL '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "end"
      FROM (SELECT date_bin(INTERVAL '1 minute',COALESCE($1::timestamptz,clock_timestamp()-INTERVAL '3 minutes'),'1970-01-01T00:00:00Z'::timestamptz) AS b) w`,
        [startAt ?? null],
      );
      await db.query(
        'UPDATE public.log_export_delivery_schedules SET started_at=$2,cursor_at=$2,cursor_id=NULL,next_due_at=$2 WHERE destination_id=$1',
        [current.destinationId, start],
      );
      clock = new Date(Date.parse(end) + 16000).toISOString();
      return { start, end };
    }
    async function insert(
      count: number,
      receipt: string,
      values: Record<string, unknown> = {},
    ) {
      const rows = Array.from({ length: count }, () => ({
        id: randomUUID(),
        requestId: randomUUID(),
        path: '/accepted',
        method: 'GET',
        statusCode: 200,
        userAgent: 'fixture-agent',
        ...values,
      }));
      await db.query(
        `INSERT INTO ${tenantSchema(tenant)}.request_logs
      (id,"requestId",path,method,"statusCode","responseTimeMs","clientIp","userAgent",timestamp,"receivedAt")
      SELECT id,"requestId",path,method,"statusCode",2,'203.0.113.8',"userAgent",'2001-01-01T00:00:00Z',$2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,"requestId" text,path text,method text,"statusCode" integer,"userAgent" text)`,
        [JSON.stringify(rows), receipt],
      );
      return rows.map((row) => row.id);
    }
    async function receiptAt(start: string, interval = '10 seconds') {
      const [{ receipt }] = await db.query(
        `SELECT to_char(($1::timestamptz+$2::interval) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS receipt`,
        [start, interval],
      );
      return receipt as string;
    }
    async function jobs(destination: string): Promise<
      Array<{
        id: string;
        source_ids: string[];
        payload: LogExportDeliveryBatch | null;
        status: string;
        error: string | null;
        attempts: number;
        lease_id: string | null;
        schedule_id: string | null;
        record_count: number;
      }>
    > {
      return db.query(
        'SELECT * FROM public.log_export_deliveries WHERE destination_id=$1 ORDER BY created_at,id',
        [destination],
      );
    }
    async function current(destination: string) {
      const result = await store.getSchedule(tenant, destination);
      if (!result) throw new Error('Expected persisted receipt schedule');
      return result;
    }
    async function terminalHistory(
      configured: LogExportDeliverySchedule,
      ids: string[],
      count: number,
      scheduled = true,
      statuses = ['delivered'],
      age = '1 hour',
    ): Promise<Array<{ id: string }>> {
      return db.query(
        `INSERT INTO public.log_export_deliveries
        (id,tenant_id,destination_id,destination_revision,privacy_revision,retention_revision,source_ids,payload_privacy,receipt_from,
         record_count,status,attempts,expires_at,created_at,completed_at,schedule_id,is_scheduled)
        SELECT gen_random_uuid(),t.id,d.id,d.revision,t."logPrivacyRevision",t."logRetentionRevision",$3::uuid[],$4::jsonb,
          $7::timestamptz-INTERVAL '3 minutes',cardinality($3::uuid[]),($6::text[])[1+(n-1)%cardinality($6::text[])],1,
          $7::timestamptz+INTERVAL '1 hour',$7::timestamptz-$8::interval+n*INTERVAL '1 microsecond',
          $7::timestamptz-$8::interval+n*INTERVAL '1 microsecond',CASE WHEN $5 THEN d.id ELSE NULL END,$5
        FROM public.tenants t JOIN public.log_export_destinations d ON d.tenant_id=t.id
        CROSS JOIN generate_series(1,$9::integer) n WHERE t.id=$1 AND d.id=$2 RETURNING id`,
        [
          tenant,
          configured.destinationId,
          [...ids].sort(),
          JSON.stringify(configured.payloadPrivacy),
          scheduled,
          statuses,
          clock,
          age,
          count,
        ],
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
          max: 12,
          connectionTimeoutMillis: 3000,
          options: '-c timezone=America/New_York',
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
          "INSERT INTO public.tenants (id,name,email,\"planId\") VALUES ($1,'Receipts',$2,'free')",
          [id, `${id}@example.test`],
        );
        await new TenantProvisioningService(db).provisionTenant(id);
      }
      await new MigrationService(db).onModuleInit();
    }, 30000);
    beforeEach(async () => {
      clock = undefined;
      await db.query(
        'DELETE FROM public.log_export_deliveries;DELETE FROM public.log_export_destinations;DELETE FROM public.log_export_delivery_history_totals',
      );
      for (const id of [tenant, other])
        await db.query(`DELETE FROM ${tenantSchema(id)}.request_logs`);
      await db.query(`UPDATE public.tenants SET "logPrivacy"='{"clientIp":"omit","userAgent":"omit"}',"logPrivacyRevision"=gen_random_uuid(),
      "logRetentionDays"=30,"logRetentionFloor"=clock_timestamp()-INTERVAL '720 hours',"logRetentionRevision"=gen_random_uuid()`);
      store = new ExportDeliveryStoreService(clockDatabase(), config);
      replica = new ExportDeliveryStoreService(clockDatabase(), config);
      destinations = new ExportDestinationsService(db, config);
    });
    afterEach(async () => {
      const failures: unknown[] = [];
      const recordFailures = (results: PromiseSettledResult<unknown>[]) => {
        for (const result of results)
          if (result.status === 'rejected') failures.push(result.reason);
      };
      recordFailures(
        await Promise.allSettled(
          [...schedulers].map((scheduler) => scheduler.onModuleDestroy()),
        ),
      );
      recordFailures(await Promise.allSettled([...runtimes]));
      for (const release of resourceCleanup)
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      resourceCleanup.clear();
      schedulers.clear();
      recordFailures(
        await Promise.allSettled([
          store.onModuleDestroy(),
          replica.onModuleDestroy(),
          destinations.onModuleDestroy(),
        ]),
      );
      if (failures.length)
        throw new AggregateError(failures, 'Receipt runtime cleanup failed');
    }, 30000);
    afterAll(async () => {
      const errors: unknown[] = [];
      for (const release of [
        async () => {
          if (db?.isInitialized) await db.destroy();
        },
        async () => {
          if (root?.isInitialized)
            await root.query(
              `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
            );
        },
        async () => {
          if (root?.isInitialized) await root.destroy();
        },
      ])
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length)
        throw new AggregateError(errors, 'Receipt database cleanup failed');
    });
    it('starts from a precise receipt boundary and never automatically backfills existing logs', async () => {
      const [{ before }] = await db.query(
        `SELECT to_char((clock_timestamp()-INTERVAL '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS before`,
      );
      const old = await insert(1, before);
      const configured = await schedule();
      const fresh = await insert(
        1,
        await receiptAt(configured.cursor, '1 microsecond'),
      );
      clock = new Date(
        Date.parse(configured.nextWindowAt) + 15000,
      ).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId)).flatMap((job) => job.source_ids),
      ).toEqual(fresh);
      expect(
        (await jobs(configured.destinationId)).flatMap((job) => job.source_ids),
      ).not.toContain(old[0]);
      expect((await current(configured.destinationId)).startedAt).toBe(
        configured.startedAt,
      );
    });
    it('waits through settlement and includes an authenticated late-request record by receipt', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      clock = new Date(Date.parse(window.end) + 14999).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(await jobs(configured.destinationId)).toHaveLength(0);
      clock = new Date(Date.parse(window.end) + 15000).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      const [job] = await jobs(configured.destinationId);
      expect(job.source_ids).toEqual(ids);
      if (!job.payload) throw new Error('Queued delivery lost its payload');
      expect(job.payload.records[0].timestamp).toBe(
        '2001-01-01T00:00:00.000000Z',
      );
      expect(job.payload.records[0].clientIp).toBe('[redacted]');
      expect(job.payload.records[0].userAgent).toBeUndefined();
      expect(job.schedule_id).toBe(configured.destinationId);
    });
    it('keeps partial microsecond/UUID cursors and includes an exact next-window boundary', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const receipt = await receiptAt(window.start, '10 seconds 1 microsecond');
      const ids = await insert(513, receipt);
      await store.produceNext(tenant, configured.destinationId);
      expect((await current(configured.destinationId)).cursor).toBe(receipt);
      await store.produceNext(tenant, configured.destinationId);
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId))
          .map((job) => job.record_count)
          .sort((a, b) => a - b),
      ).toEqual([1, 256, 256]);
      expect(
        (await jobs(configured.destinationId))
          .flatMap((job) => job.source_ids)
          .sort(),
      ).toEqual(ids.sort());
      expect((await current(configured.destinationId)).cursor).toBe(window.end);
      const boundary = await insert(1, window.end, {
        id: '00000000-0000-0000-0000-000000000000',
      });
      clock = new Date(Date.parse(window.end) + 75000).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId)).flatMap((job) => job.source_ids),
      ).toContain(boundary[0]);
    });
    it('rolls back a new batch if cursor persistence fails and retries without duplicates', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      await insert(1, await receiptAt(window.start));
      await db.query(`CREATE FUNCTION fail_receipt_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.admitted_records>OLD.admitted_records THEN RAISE EXCEPTION 'owned fixture failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER fail_receipt_cursor BEFORE UPDATE ON public.log_export_delivery_schedules FOR EACH ROW EXECUTE FUNCTION fail_receipt_cursor()`);
      try {
        await expect(
          store.produceNext(tenant, configured.destinationId),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(await jobs(configured.destinationId)).toHaveLength(0);
        expect((await current(configured.destinationId)).cursor).toBe(
          window.start,
        );
      } finally {
        await db.query(
          'DROP TRIGGER fail_receipt_cursor ON public.log_export_delivery_schedules;DROP FUNCTION fail_receipt_cursor()',
        );
      }
      await store.produceNext(tenant, configured.destinationId);
      await replica.produceNext(tenant, configured.destinationId);
      expect(await jobs(configured.destinationId)).toHaveLength(1);
    });
    it('serializes the same receipt window across independent replicas', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(300, await receiptAt(window.start));
      await Promise.all([
        store.produceNext(tenant, configured.destinationId),
        replica.produceNext(tenant, configured.destinationId),
      ]);
      for (let i = 0; i < 2; i++)
        await store.produceNext(tenant, configured.destinationId);
      const selected = (await jobs(configured.destinationId)).flatMap(
        (job) => job.source_ids,
      );
      expect(selected.sort()).toEqual(ids.sort());
      expect(new Set(selected).size).toBe(300);
    });
    it('preserves the cursor under queue pressure instead of pretending records were admitted', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      for (let i = 0; i < 20; i++)
        await store.admit(tenant, configured.destinationId, randomUUID(), ids);
      await store.produceNext(tenant, configured.destinationId);
      expect(await current(configured.destinationId)).toMatchObject({
        cursor: window.start,
        error: 'queue_full',
        admittedRecords: 0,
      });
    });
    it('keeps scheduling at full caller and scheduled history while preserving caller deduplication', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(3, await receiptAt(window.start));
      const manual = await terminalHistory(configured, ids, 1000, false);
      await terminalHistory(configured, ids, 1000, true, [
        'failed',
        'expired',
        'delivered',
      ]);
      await expect(
        store.admit(tenant, configured.destinationId, randomUUID(), ids),
      ).rejects.toBeInstanceOf(ConflictException);
      await store.produceNext(tenant, configured.destinationId);
      const lease = await store.claim(tenant, configured.destinationId);
      if (!lease)
        throw new Error('Full terminal history stopped scheduled delivery');
      expect(lease.batch.records.map((row) => row.id).sort()).toEqual(
        [...ids].sort(),
      );
      expect(
        await store.finish(tenant, lease.id, lease.leaseId, {
          delivered: true,
        }),
      ).toBe(true);
      await store.produceNext(tenant, configured.destinationId);
      expect((await current(configured.destinationId)).admittedRecords).toBe(3);
      expect(
        (
          await store.admit(
            tenant,
            configured.destinationId,
            manual[0].id,
            ids,
            configured.payloadPrivacy,
          )
        ).id,
      ).toBe(manual[0].id);
      const [{ caller, scheduled }] = await db.query(
        `SELECT COUNT(*) FILTER (WHERE schedule_id IS NULL)::integer AS caller,
        COUNT(*) FILTER (WHERE schedule_id IS NOT NULL)::integer AS scheduled FROM public.log_export_deliveries WHERE tenant_id=$1`,
        [tenant],
      );
      expect({ caller, scheduled }).toEqual({ caller: 1000, scheduled: 1000 });
      const history = await store.historyState(
        tenant,
        configured.destinationId,
      );
      expect(history.deliveries).toHaveLength(50);
      expect(history.coverage).toMatchObject({
        scope: 'workspace',
        scheduledTerminalLimit: 1000,
        prunedScheduledBatches: { delivered: '0', failed: '1', expired: '0' },
        prunedScheduledRecords: { delivered: '0', failed: '3', expired: '0' },
      });
      expect(history.coverage.lastPrunedAt).toBeDefined();
      expect(JSON.stringify(history)).not.toMatch(
        /source_ids|payload|credentials|private-fixture/,
      );
    });
    it('never compacts queued payloads or a current processing lease under history and queue pressure', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      for (let i = 0; i < 20; i++)
        await store.admit(tenant, configured.destinationId, randomUUID(), ids);
      await db.query(
        'UPDATE public.log_export_deliveries SET schedule_id=$1,is_scheduled=true WHERE destination_id=$1',
        [configured.destinationId],
      );
      const lease = await store.claim(tenant, configured.destinationId);
      if (!lease) throw new Error('Expected a real current lease');
      const before = exportDeliveryBody('webhook', lease.batch);
      await terminalHistory(configured, ids, 1200);
      await store.produceNext(tenant, configured.destinationId);
      expect((await current(configured.destinationId)).error).toBe(
        'queue_full',
      );
      expect(await store.leaseEligible(tenant, lease.id, lease.leaseId)).toBe(
        true,
      );
      const rows = await jobs(configured.destinationId),
        owned = rows.find((row) => row.id === lease.id);
      if (!owned?.payload)
        throw new Error('Compaction erased an active payload');
      expect(owned.lease_id).toBe(lease.leaseId);
      expect(exportDeliveryBody('webhook', owned.payload)).toEqual(before);
      expect(
        rows.filter((row) => ['queued', 'processing'].includes(row.status)),
      ).toHaveLength(20);
      expect(rows).toHaveLength(1020);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('200');
    });
    it('serializes acknowledgements and compaction across independent replicas without losing source records', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(300, await receiptAt(window.start));
      await terminalHistory(configured, [ids[0]], 999);
      await Promise.all([
        store.produceNext(tenant, configured.destinationId),
        replica.produceNext(tenant, configured.destinationId),
      ]);
      // A replica may skip the locked cursor; revisit the remaining page normally.
      await store.produceNext(tenant, configured.destinationId);
      const queued = (await jobs(configured.destinationId)).filter(
        (row) => row.status === 'queued',
      );
      expect(queued.length).toBe(2);
      expect(queued.flatMap((row) => row.source_ids).sort()).toEqual(
        [...ids].sort(),
      );
      const leases = await Promise.all([
        store.claim(tenant, configured.destinationId),
        replica.claim(tenant, configured.destinationId),
      ]);
      if (!leases[0] || !leases[1])
        throw new Error('Expected independent leased batches');
      expect(leases[0].id).not.toBe(leases[1].id);
      expect(
        await Promise.all([
          store.finish(tenant, leases[0].id, leases[0].leaseId, {
            delivered: true,
          }),
          replica.finish(tenant, leases[1].id, leases[1].leaseId, {
            delivered: true,
          }),
        ]),
      ).toEqual([true, true]);
      expect(await jobs(configured.destinationId)).toHaveLength(1000);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledRecords.delivered,
      ).toBe('1');
      expect((await current(configured.destinationId)).admittedRecords).toBe(
        300,
      );
    });
    it('rolls back history deletion, coverage, source admission and cursor when coverage persistence fails', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      await terminalHistory(configured, ids, 1001);
      await db.query(`CREATE FUNCTION fail_history_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled coverage failure'; END $$;
        CREATE TRIGGER fail_history_coverage BEFORE INSERT OR UPDATE ON public.log_export_delivery_history_totals FOR EACH ROW EXECUTE FUNCTION fail_history_coverage()`);
      resourceCleanup.add(() =>
        db.query(
          'DROP TRIGGER IF EXISTS fail_history_coverage ON public.log_export_delivery_history_totals; DROP FUNCTION IF EXISTS fail_history_coverage()',
        ),
      );
      await expect(
        store.produceNext(tenant, configured.destinationId),
      ).rejects.toThrow();
      expect(await jobs(configured.destinationId)).toHaveLength(1001);
      expect((await current(configured.destinationId)).cursor).toBe(
        window.start,
      );
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('0');
      await db.query(
        'DROP TRIGGER fail_history_coverage ON public.log_export_delivery_history_totals; DROP FUNCTION fail_history_coverage()',
      );
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId)).filter(
          (row) => row.status === 'queued',
        ),
      ).toHaveLength(1);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('1');
    });
    it('records age-expired scheduled coverage once while preserving independent caller history rules', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(3, await receiptAt(window.start));
      await terminalHistory(
        configured,
        ids,
        400,
        false,
        ['delivered'],
        '170 hours',
      );
      await terminalHistory(
        configured,
        ids,
        700,
        true,
        ['delivered'],
        '169 hours',
      );
      await store.cleanup();
      expect(await jobs(configured.destinationId)).toHaveLength(600);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('100');
      await store.cleanup();
      await store.cleanup();
      await store.cleanup();
      const history = await store.historyState(
        tenant,
        configured.destinationId,
      );
      expect(history.deliveries).toHaveLength(0);
      expect(history.coverage.prunedScheduledBatches.delivered).toBe('700');
      expect(history.coverage.prunedScheduledRecords.delivered).toBe('2100');
    });
    it('preserves scheduled history classification after schedule deletion and reconstruction', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      await terminalHistory(configured, ids, 1000, false);
      await terminalHistory(configured, ids, 1001, true);
      await db.query(
        'DELETE FROM public.log_export_delivery_schedules WHERE destination_id=$1',
        [configured.destinationId],
      );
      await new MigrationService(db).onModuleInit();
      expect(
        await store.getSchedule(tenant, configured.destinationId),
      ).toBeNull();
      const rebuilt = await store.saveSchedule(
        tenant,
        configured.destinationId,
        {
          enabled: true,
          cadence: 'near_real_time',
          filter: {},
          payloadPrivacy: configured.payloadPrivacy,
          expectedRevision: null,
          expectedDestinationRevision: configured.destinationRevision,
        },
      );
      clock = new Date(Date.parse(rebuilt.nextWindowAt) + 15000).toISOString();
      await store.produceNext(tenant, rebuilt.destinationId);
      const [{ caller, scheduled }] = await db.query(
        `SELECT COUNT(*) FILTER (WHERE NOT is_scheduled)::integer AS caller,
        COUNT(*) FILTER (WHERE is_scheduled AND schedule_id IS NULL)::integer AS scheduled FROM public.log_export_deliveries WHERE tenant_id=$1`,
        [tenant],
      );
      expect({ caller, scheduled }).toEqual({ caller: 1000, scheduled: 1000 });
      expect((await current(rebuilt.destinationId)).admittedRecords).toBe(0);
      expect(
        (await store.historyState(tenant, rebuilt.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('1');
    });
    it('backfills the scheduled marker and its index through repeated schema upgrades', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      await terminalHistory(configured, ids, 1000, true);
      await db.query(
        'UPDATE public.log_export_deliveries SET is_scheduled=false WHERE destination_id=$1',
        [configured.destinationId],
      );
      await new MigrationService(db).onModuleInit();
      await new MigrationService(db).onModuleInit();
      const [{ scheduled }] = await db.query(
        'SELECT COUNT(*)::integer AS scheduled FROM public.log_export_deliveries WHERE tenant_id=$1 AND is_scheduled',
        [tenant],
      );
      expect(scheduled).toBe(1000);
      const [{ indexdef }] = await db.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='log_export_scheduled_terminal_history'",
      );
      expect(indexdef).toContain('is_scheduled');
      await store.produceNext(tenant, configured.destinationId);
      expect((await current(configured.destinationId)).admittedRecords).toBe(1);
    });
    it('keeps exact BIGINT coverage and never returns another workspace totals', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      await terminalHistory(configured, ids, 1001);
      await store.produceNext(tenant, configured.destinationId);
      await db.query(
        'UPDATE public.log_export_delivery_history_totals SET delivered_batches=9007199254740993 WHERE tenant_id=$1',
        [tenant],
      );
      await terminalHistory(configured, ids, 1);
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('9007199254740994');
      const foreign = await store.historyState(other, configured.destinationId);
      expect(foreign.deliveries).toEqual([]);
      expect(foreign.coverage.prunedScheduledBatches).toEqual({
        delivered: '0',
        failed: '0',
        expired: '0',
      });
    });
    it('compacts oversized legacy scheduled history in at most 500 deletions per transaction', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      await terminalHistory(configured, ids, 2000);
      await store.produceNext(tenant, configured.destinationId);
      expect(await jobs(configured.destinationId)).toHaveLength(1500);
      expect((await current(configured.destinationId)).cursor).toBe(
        window.start,
      );
      expect((await current(configured.destinationId)).error).toBe(
        'history_busy',
      );
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('500');
      await store.produceNext(tenant, configured.destinationId);
      expect(await jobs(configured.destinationId)).toHaveLength(1001);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('1000');
      expect((await current(configured.destinationId)).admittedRecords).toBe(1);
    });
    it('preserves the hard automatic row budget when cleanup owns excess terminal history', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      await terminalHistory(configured, ids, 1200);
      const lock = db.createQueryRunner();
      await lock.connect();
      await lock.startTransaction();
      try {
        await lock.query(
          `SELECT id FROM public.log_export_deliveries WHERE destination_id=$1
          ORDER BY completed_at,id LIMIT 200 FOR UPDATE`,
          [configured.destinationId],
        );
        await store.produceNext(tenant, configured.destinationId);
        expect((await current(configured.destinationId)).error).toBe(
          'history_busy',
        );
        expect((await current(configured.destinationId)).cursor).toBe(
          window.start,
        );
        expect((await jobs(configured.destinationId)).length).toBe(1200);
      } finally {
        await lock.rollbackTransaction();
        await lock.release();
      }
      await store.produceNext(tenant, configured.destinationId);
      expect((await jobs(configured.destinationId)).length).toBe(1001);
      expect((await current(configured.destinationId)).admittedRecords).toBe(1);
      expect(
        (await store.historyState(tenant, configured.destinationId)).coverage
          .prunedScheduledBatches.delivered,
      ).toBe('200');
    });
    it('reports retention loss in seconds and still includes the exact inclusive floor', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const floor = await receiptAt(window.start, '10 seconds 1 microsecond');
      await db.query(
        'UPDATE public.tenants SET "logRetentionFloor"=$2::timestamptz WHERE id=$1',
        [tenant, floor],
      );
      const before = await insert(
        1,
        await receiptAt(window.start, '10 seconds'),
      );
      const at = await insert(1, floor);
      await store.produceNext(tenant, configured.destinationId);
      const state = await current(configured.destinationId);
      expect(state.retentionSkippedSeconds).toBeCloseTo(10.000001, 6);
      expect(state.admittedRecords).toBe(1);
      expect((await jobs(configured.destinationId))[0].source_ids).toEqual(at);
      expect(
        (await jobs(configured.destinationId))[0].source_ids,
      ).not.toContain(before[0]);
    });
    it('fast-forwards empty settled windows without passing the next retained receipt', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const next = await receiptAt(window.end, '1 minute 10 seconds');
      await insert(1, next);
      clock = new Date(Date.parse(window.end) + 195000).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(await jobs(configured.destinationId)).toHaveLength(0);
      expect((await current(configured.destinationId)).cursor).toBe(
        await receiptAt(window.end, '1 minute'),
      );
      await store.produceNext(tenant, configured.destinationId);
      expect((await current(configured.destinationId)).admittedRecords).toBe(1);
    });
    it('counts invalid and filtered records while keeping healthy records deliverable', async () => {
      let configured = await schedule();
      configured = await save(configured, {
        filter: { minStatusCode: 400, pathPrefix: '/selected' },
      });
      const window = await readyWindow(configured),
        receipt = await receiptAt(window.start);
      await insert(1, receipt, { method: 'bad' });
      await insert(1, receipt, { path: '/' + 'x'.repeat(1024 * 1024) });
      await insert(1, receipt, { statusCode: 200, path: '/selected' });
      await insert(1, receipt, { statusCode: 500, path: '/excluded' });
      const good = await insert(1, receipt, {
        statusCode: 500,
        path: '/selected/path',
      });
      await store.produceNext(tenant, configured.destinationId);
      expect(await current(configured.destinationId)).toMatchObject({
        invalidRecords: 2,
        filteredRecords: 2,
        admittedRecords: 1,
        error: 'invalid_records',
        cursor: window.end,
      });
      expect((await jobs(configured.destinationId))[0].source_ids).toEqual(
        good,
      );
    });
    it('stops a newly unavailable privacy filter without inspecting hidden source values', async () => {
      let configured = await schedule();
      configured = await save(configured, {
        filter: { pathPrefix: '/private' },
      });
      const window = await readyWindow(configured);
      await insert(1, await receiptAt(window.start), { path: '/private' });
      await db.query(
        `UPDATE public.tenants SET "logPrivacy"='{"clientIp":"omit","userAgent":"omit","redactedFields":["path"]}',"logPrivacyRevision"=gen_random_uuid() WHERE id=$1`,
        [tenant],
      );
      await store.produceNext(tenant, configured.destinationId);
      expect(await current(configured.destinationId)).toMatchObject({
        cursor: window.start,
        error: 'filter_unavailable',
        admittedRecords: 0,
      });
      expect(await jobs(configured.destinationId)).toHaveLength(0);
    });
    it('pauses admission while keeping queued attempts and resumes the saved cursor', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      await insert(1, await receiptAt(window.start));
      await store.produceNext(tenant, configured.destinationId);
      let state = await current(configured.destinationId);
      state = await save(state, { enabled: false });
      expect(await store.produceNext(tenant, configured.destinationId)).toBe(
        false,
      );
      expect((await store.reserveDeliveryTargets())[0]).toEqual({
        tenantId: tenant,
        destinationId: configured.destinationId,
      });
      const cursor = state.cursor;
      await insert(1, await receiptAt(window.end, '1 microsecond'));
      clock = new Date(Date.parse(window.end) + 75000).toISOString();
      state = await save(state, { enabled: true, cadence: 'near_real_time' });
      expect(state.cursor).toBe(cursor);
      await store.produceNext(tenant, configured.destinationId);
      expect((await current(configured.destinationId)).admittedRecords).toBe(2);
    });
    it('changes a partial minute window to hourly without replaying or losing its UUID cursor', async () => {
      const configured = await schedule();
      const [{ start }] = await db.query(
        `SELECT to_char((date_bin(INTERVAL '1 hour',clock_timestamp(),'1970-01-01T00:00:00Z'::timestamptz)-INTERVAL '30 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start`,
      );
      const window = await readyWindow(configured, start);
      const ids = await insert(
        300,
        await receiptAt(window.start, '10 seconds 1 microsecond'),
      );
      await store.produceNext(tenant, configured.destinationId);
      const partial = await current(configured.destinationId);
      expect(partial.admittedRecords).toBe(256);
      const changed = await save(partial, { cadence: 'hourly' });
      expect(changed.cursor).toBe(partial.cursor);
      expect(changed.destinationRevision).toBe(partial.destinationRevision);
      const later = await insert(
        1,
        await receiptAt(window.end, '1 microsecond'),
      );
      clock = new Date(Date.parse(changed.nextWindowAt) + 15000).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId))
          .flatMap((job) => job.source_ids)
          .sort(),
      ).toEqual([...ids, ...later].sort());
      expect((await current(configured.destinationId)).admittedRecords).toBe(
        301,
      );
    });
    it('preserves both sides of an hourly cadence boundary across two settled windows', async () => {
      const configured = await schedule();
      const [{ start }] = await db.query(
        `SELECT to_char((date_bin(INTERVAL '1 hour',clock_timestamp(),'1970-01-01T00:00:00Z'::timestamptz)-INTERVAL '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start`,
      );
      const window = await readyWindow(configured, start);
      const ids = await insert(
        300,
        await receiptAt(window.start, '10 seconds 1 microsecond'),
      );
      await store.produceNext(tenant, configured.destinationId);
      const partial = await current(configured.destinationId);
      expect(partial.admittedRecords).toBe(256);
      const changed = await save(partial, { cadence: 'hourly' });
      expect(changed.cursor).toBe(partial.cursor);
      expect(Date.parse(changed.nextWindowAt)).toBe(Date.parse(window.end));
      const later = await insert(
        1,
        await receiptAt(window.end, '1 microsecond'),
      );
      clock = new Date(Date.parse(changed.nextWindowAt) + 15000).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId))
          .flatMap((job) => job.source_ids)
          .sort(),
      ).toEqual([...ids].sort());
      expect((await current(configured.destinationId)).admittedRecords).toBe(
        300,
      );
      const next = await current(configured.destinationId);
      clock = new Date(Date.parse(next.nextWindowAt) + 15000).toISOString();
      await store.produceNext(tenant, configured.destinationId);
      expect(
        (await jobs(configured.destinationId))
          .flatMap((job) => job.source_ids)
          .sort(),
      ).toEqual([...ids, ...later].sort());
      expect((await current(configured.destinationId)).admittedRecords).toBe(
        301,
      );
    });
    it('continues healthy destinations when a real admission transaction fails', async () => {
      const broken = await schedule(),
        healthy = await schedule();
      const window = await readyWindow(broken);
      await readyWindow(healthy);
      const ids = await insert(1, await receiptAt(window.start));
      await db.query(`CREATE FUNCTION fail_fixture_destination() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.destination_id='${broken.destinationId}'::uuid THEN RAISE EXCEPTION 'controlled admission failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_fixture_destination BEFORE INSERT ON public.log_export_deliveries
        FOR EACH ROW EXECUTE FUNCTION fail_fixture_destination()`);
      resourceCleanup.add(() =>
        db.query(
          'DROP TRIGGER IF EXISTS fail_fixture_destination ON public.log_export_deliveries; DROP FUNCTION IF EXISTS fail_fixture_destination()',
        ),
      );
      // Exercise production scheduling and real transactions while stopping at the
      // network boundary; separate receiver checks own transport behavior.
      const worker = {
        availableCapacity: 4,
        deliverNext: jest.fn().mockResolvedValue(undefined),
      } as unknown as ExportDeliveryWorkerService;
      const scheduler = new ExportDeliverySchedulerService(store, worker);
      schedulers.add(scheduler);
      await scheduler.tick();
      expect(await jobs(broken.destinationId)).toHaveLength(0);
      expect((await current(broken.destinationId)).cursor).toBe(window.start);
      expect((await jobs(healthy.destinationId))[0].source_ids).toEqual(ids);
      expect(worker.deliverNext).toHaveBeenCalledWith(
        tenant,
        healthy.destinationId,
        expect.any(AbortSignal),
        true,
      );
      await db.query(
        'DROP TRIGGER fail_fixture_destination ON public.log_export_deliveries; DROP FUNCTION fail_fixture_destination()',
      );
      await store.produceNext(tenant, broken.destinationId);
      expect((await jobs(broken.destinationId))[0].source_ids).toEqual(ids);
    });
    it('changes payload policy with destination revision fencing and immediate old-payload erasure', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      await insert(1, await receiptAt(window.start));
      await store.produceNext(tenant, configured.destinationId);
      const state = await current(configured.destinationId);
      const next = await save(state, {
        payloadPrivacy: {
          clientIp: 'omit',
          userAgent: 'omit',
          redactedFields: ['path'],
        },
      });
      expect(next.destinationRevision).not.toBe(state.destinationRevision);
      expect(next.cursor).toBe(state.cursor);
      expect((await jobs(configured.destinationId))[0]).toMatchObject({
        status: 'expired',
        payload: null,
        error: 'destination_changed',
      });
    });
    it('rejects stale settings/destination revisions and foreign schedule ownership', async () => {
      const configured = await schedule();
      await save(configured, { enabled: false });
      await expect(save(configured, { enabled: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
      const state = await current(configured.destinationId);
      await destinations.update(tenant, state.destinationId, {
        name: 'Changed',
        expectedRevision: state.destinationRevision,
      });
      await expect(save(state, { enabled: true })).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        store.getSchedule(other, state.destinationId),
      ).rejects.toThrow('not found');
      await expect(
        db.query(
          'UPDATE public.log_export_delivery_schedules SET tenant_id=$2 WHERE destination_id=$1',
          [state.destinationId, other],
        ),
      ).rejects.toThrow();
    });
    it('reserves at most four producers fairly across replicas without repeating busy targets', async () => {
      const schedules = [];
      for (let i = 0; i < 5; i++) schedules.push(await schedule());
      for (const configured of schedules) await readyWindow(configured);
      const reservations = await Promise.all([
        store.reserveProducerTargets(),
        replica.reserveProducerTargets(),
      ]);
      expect(reservations.every((rows) => rows.length <= 4)).toBe(true);
      const ids = reservations.flat().map((row) => row.destinationId);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      expect(await store.reserveProducerTargets()).toHaveLength(0);
    });
    it('splits Datadog envelopes before advancing past the first record that cannot fit', async () => {
      await db.query(
        `UPDATE public.tenants SET "logPrivacy"='{"clientIp":"retain","userAgent":"retain"}' WHERE id=$1`,
        [tenant],
      );
      let configured = await schedule('datadog');
      configured = await save(configured, {
        payloadPrivacy: { clientIp: 'retain', userAgent: 'retain' },
      });
      const window = await readyWindow(configured);
      const ids = await insert(321, await receiptAt(window.start), {
        path: '/' + '"'.repeat(4000),
        userAgent: '"'.repeat(2000),
      });
      for (
        let i = 0;
        i < 20 &&
        (await current(configured.destinationId)).admittedRecords < ids.length;
        i++
      )
        await store.produceNext(tenant, configured.destinationId);
      const batches = await jobs(configured.destinationId);
      expect(batches.length).toBeGreaterThan(3);
      expect(batches.flatMap((job) => job.source_ids).sort()).toEqual(
        ids.sort(),
      );
      expect((await current(configured.destinationId)).invalidRecords).toBe(0);
      for (const job of batches) {
        if (!job.payload) throw new Error('Queued delivery lost its payload');
        expect(
          exportDeliveryBody('datadog', job.payload).length,
        ).toBeLessThanOrEqual(1024 * 1024);
      }
    });
    it('waits for receipt ingestion to commit before moving a window cursor', async () => {
      const configured = await schedule(),
        window = await readyWindow(configured);
      const lock = db.createQueryRunner();
      await lock.connect();
      await lock.startTransaction();
      let work: Promise<unknown> | undefined;
      try {
        await lock.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`log-receipt:${tenant}`],
        );
        work = store.produceNext(tenant, configured.destinationId);
        work.catch(() => undefined);
        for (let i = 0; i < 50; i++) {
          const [{ waiting }] = await db.query(
            `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`,
          );
          if (waiting) break;
          if (i === 49)
            throw new Error('Producer did not reach the receipt lock');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const id = randomUUID();
        await lock.query(
          `INSERT INTO ${tenantSchema(tenant)}.request_logs
        (id,method,path,"statusCode","responseTimeMs","requestId","clientIp",timestamp,"receivedAt") VALUES ($1,'GET','/committing',200,2,$2,'203.0.113.1','2001-01-01',$3)`,
          [id, randomUUID(), await receiptAt(window.start)],
        );
        await lock.commitTransaction();
        await work;
        expect((await jobs(configured.destinationId))[0].source_ids).toEqual([
          id,
        ]);
      } finally {
        if (lock.isTransactionActive) await lock.rollbackTransaction();
        await Promise.allSettled(work ? [work] : []);
        await lock.release();
      }
    });
    it.each([
      'enabled',
      'cadence',
      'filter',
      'payloadPrivacy',
      'expectedRevision',
      'expectedDestinationRevision',
      'unknown',
    ])('validates %s before changing delivery state', async (field) => {
      const configured = await schedule();
      const bad = {
        enabled: 'true',
        cadence: 'daily',
        filter: { rawBody: true },
        payloadPrivacy: {
          clientIp: 'retain',
          userAgent: 'retain',
          headers: true,
        },
        expectedRevision: 'stale',
        expectedDestinationRevision: 'stale',
        unknown: true,
      }[field];
      await expect(save(configured, { [field]: bad })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect((await current(configured.destinationId)).revision).toBe(
        configured.revision,
      );
    });
    it('does not dispatch manually staged drafts or start a timer without encryption keys', async () => {
      const draft = await destinations.create(tenant, {
        name: 'Draft',
        credentials: {
          type: 'webhook',
          url: 'https://logs.example.com',
          signingSecret: 'fixture-signing-secret-more-than-32-bytes',
        },
      });
      const [{ receipt }] = await db.query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS receipt`,
      );
      const ids = await insert(1, receipt);
      await store.admit(tenant, draft.id, randomUUID(), ids);
      expect(await store.reserveDeliveryTargets()).toEqual([]);
      expect(await store.reserveProducerTargets()).toEqual([]);
      const disabled = new ExportDeliveryStoreService(
        clockDatabase(),
        new ConfigService({}),
      );
      const transport = new ExportTransportService(new ConfigService({}));
      const worker = new ExportDeliveryWorkerService(disabled, transport);
      const scheduler = new ExportDeliverySchedulerService(disabled, worker);
      try {
        scheduler.onApplicationBootstrap();
        await scheduler.tick();
        expect((await jobs(draft.id))[0].status).toBe('queued');
      } finally {
        await scheduler.onModuleDestroy();
        await worker.onModuleDestroy();
        await transport.onModuleDestroy();
        await disabled.onModuleDestroy();
      }
    });
    it('keeps healthy backlog moving while another receiver holds an attempt', async () => {
      const sockets = new Set<Socket>(),
        received = new Set<string>();
      const server = http.createServer((req, res) => {
        req.resume();
        received.add(req.url ?? '');
        if (req.url !== '/0') {
          res.writeHead(202);
          res.end();
        }
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      resourceCleanup.add(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done, fail) =>
          server.close((error) => (error ? fail(error) : done())),
        );
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const local = new ConfigService({
        ...keySettings,
        LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
      });
      const configured = [];
      const cipher = new ExportDestinationCredentialCipher(keySettings);
      try {
        for (let i = 0; i < 5; i++) {
          const entry = await schedule();
          configured.push(entry);
          await db.query(
            'UPDATE public.log_export_destinations SET credentials=$2 WHERE id=$1',
            [
              entry.destinationId,
              cipher.encrypt(tenant, entry.destinationId, 'webhook', {
                type: 'webhook',
                url: `${origin}/${i}`,
                signingSecret: 'fixture-signing-secret-more-than-32-bytes',
              }),
            ],
          );
          await readyWindow(entry);
        }
      } finally {
        cipher.destroy();
      }
      await insert(
        769,
        await receiptAt((await current(configured[0].destinationId)).cursor),
      );
      for (let i = 0; i < configured.length; i++) {
        await store.produceNext(tenant, configured[i].destinationId);
        await db.query(
          `UPDATE public.log_export_delivery_schedules SET next_due_at=clock_timestamp()+INTERVAL '1 hour',
          last_delivery_checked_at=CASE WHEN $2::integer=0 THEN NULL ELSE '2000-01-01'::timestamptz+make_interval(secs=>$2::integer) END WHERE destination_id=$1`,
          [configured[i].destinationId, i],
        );
      }
      // One destination has four immutable source batches; it must not occupy
      // the newly freed slots with additional stalled attempts.
      for (let i = 0; i < 3; i++)
        await store.produceNext(tenant, configured[0].destinationId);
      await db.query(
        `UPDATE public.log_export_delivery_schedules SET next_due_at=clock_timestamp()+INTERVAL '1 hour'`,
      );
      const runtimeStore = new ExportDeliveryStoreService(
          clockDatabase(),
          local,
        ),
        transport = new ExportTransportService(local);
      const worker = new ExportDeliveryWorkerService(runtimeStore, transport),
        scheduler = new ExportDeliverySchedulerService(runtimeStore, worker);
      schedulers.add(scheduler);
      resourceCleanup.add(() => worker.onModuleDestroy());
      resourceCleanup.add(() => transport.onModuleDestroy());
      resourceCleanup.add(() => runtimeStore.onModuleDestroy());
      const first = scheduler.tick();
      runtimes.add(first);
      let second: Promise<void> | undefined;
      try {
        for (let i = 0; i < 100; i++) {
          const completed = await db.query(
            `SELECT id FROM public.log_export_deliveries WHERE status='delivered'`,
          );
          if (received.has('/0') && completed.length === 3) break;
          if (i === 99)
            throw new Error('Initial bounded receiver attempts did not start');
          await new Promise((done) => setTimeout(done, 10));
        }
        second = scheduler.tick();
        runtimes.add(second);
        for (let i = 0; i < 80 && !received.has('/4'); i++)
          await new Promise((done) => setTimeout(done, 10));
        expect(received.has('/4')).toBe(true);
        expect((await jobs(configured[0].destinationId))[0]).toMatchObject({
          status: 'processing',
          attempts: 1,
        });
        const slowJobs = await jobs(configured[0].destinationId);
        expect(
          slowJobs.filter((job) => job.status === 'processing'),
        ).toHaveLength(1);
        expect(
          slowJobs.filter(
            (job) => job.status === 'queued' && job.attempts === 0,
          ),
        ).toHaveLength(3);
      } finally {
        await scheduler.onModuleDestroy();
        await Promise.allSettled(second ? [first, second] : [first]);
        runtimes.delete(first);
        if (second) runtimes.delete(second);
      }
      expect((await jobs(configured[0].destinationId))[0]).toMatchObject({
        status: 'queued',
        attempts: 1,
        error: 'cancelled',
      });
    });
    it('dispatches only scheduled batches when caller work shares an active destination', async () => {
      const sockets = new Set<Socket>();
      const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(202);
        res.end();
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      resourceCleanup.add(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done, fail) =>
          server.close((error) => (error ? fail(error) : done())),
        );
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const local = new ConfigService({
        ...keySettings,
        LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
      });
      const configured = await schedule();
      const window = await readyWindow(configured);
      const ids = await insert(1, await receiptAt(window.start));
      const cipher = new ExportDestinationCredentialCipher(keySettings);
      try {
        await db.query(
          'UPDATE public.log_export_destinations SET credentials=$2 WHERE id=$1',
          [
            configured.destinationId,
            cipher.encrypt(tenant, configured.destinationId, 'webhook', {
              type: 'webhook',
              url: `${origin}/scoped`,
              signingSecret: 'fixture-signing-secret-more-than-32-bytes',
            }),
          ],
        );
      } finally {
        cipher.destroy();
      }
      const caller = await store.admit(
        tenant,
        configured.destinationId,
        randomUUID(),
        ids,
        configured.payloadPrivacy,
      );
      await db.query(
        `UPDATE public.log_export_deliveries SET created_at=created_at-INTERVAL '1 minute',next_attempt_at=next_attempt_at-INTERVAL '1 minute' WHERE id=$1`,
        [caller.id],
      );
      await store.produceNext(tenant, configured.destinationId);
      const automatic = (await jobs(configured.destinationId)).find(
        (row) => row.schedule_id === configured.destinationId,
      );
      expect(automatic).toBeDefined();
      const runtimeStore = new ExportDeliveryStoreService(
          clockDatabase(),
          local,
        ),
        transport = new ExportTransportService(local);
      const worker = new ExportDeliveryWorkerService(runtimeStore, transport),
        scheduler = new ExportDeliverySchedulerService(runtimeStore, worker);
      schedulers.add(scheduler);
      resourceCleanup.add(() => worker.onModuleDestroy());
      resourceCleanup.add(() => transport.onModuleDestroy());
      resourceCleanup.add(() => runtimeStore.onModuleDestroy());
      const received = once(server, 'request', {
        signal: AbortSignal.timeout(1500),
      });
      await scheduler.tick();
      const [request] = await received;
      expect(
        (request as http.IncomingMessage).headers['x-novagate-delivery-id'],
      ).toBe(automatic?.id);
      for (let i = 0; i < 50; i++) {
        const rows = await jobs(configured.destinationId);
        if (
          rows.find((row) => row.id === automatic?.id)?.status === 'delivered'
        )
          break;
        if (i === 49)
          throw new Error('Scheduled acknowledgement was not persisted');
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(
        (await jobs(configured.destinationId)).find(
          (row) => row.id === caller.id,
        ),
      ).toMatchObject({ status: 'queued', attempts: 0 });
    });
    it('bootstraps automatic production classes, refuses overlapping ticks and drains a real stalled receiver', async () => {
      const sockets = new Set<Socket>();
      const server = http.createServer((req) => req.resume());
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      resourceCleanup.add(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        local = new ConfigService({
          ...keySettings,
          LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
        });
      // The draft API remains public-only; fixture setup uses an authenticated encrypted row.
      const configured = await schedule();
      const cipher = new ExportDestinationCredentialCipher(keySettings);
      try {
        await db.query(
          'UPDATE public.log_export_destinations SET credentials=$2 WHERE id=$1',
          [
            configured.destinationId,
            cipher.encrypt(tenant, configured.destinationId, 'webhook', {
              type: 'webhook',
              url: `${origin}/inbox`,
              signingSecret: 'fixture-signing-secret-more-than-32-bytes',
            }),
          ],
        );
      } finally {
        cipher.destroy();
      }
      const window = await readyWindow(configured);
      await insert(1, await receiptAt(window.start));
      const runtimeStore = new ExportDeliveryStoreService(
          clockDatabase(),
          local,
        ),
        transport = new ExportTransportService(local),
        worker = new ExportDeliveryWorkerService(runtimeStore, transport),
        scheduler = new ExportDeliverySchedulerService(runtimeStore, worker);
      schedulers.add(scheduler);
      resourceCleanup.add(() => worker.onModuleDestroy());
      resourceCleanup.add(() => transport.onModuleDestroy());
      resourceCleanup.add(() => runtimeStore.onModuleDestroy());
      const received = once(server, 'request', {
        signal: AbortSignal.timeout(1500),
      });
      const lock = db.createQueryRunner();
      await lock.connect();
      await lock.startTransaction();
      await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `log-receipt:${tenant}`,
      ]);
      scheduler.onApplicationBootstrap();
      const owned = (async () => {
        const first = scheduler.tick();
        let repeated: Promise<void> | undefined;
        try {
          for (let i = 0; i < 50; i++) {
            const [{ waiting }] = await db.query(
              `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`,
            );
            if (waiting) break;
            if (i === 49)
              throw new Error('Scheduler did not reach the receipt lock');
            await new Promise((done) => setTimeout(done, 10));
          }
          let duplicate = false;
          repeated = scheduler.tick().then(() => {
            duplicate = true;
          });
          await new Promise((done) => setTimeout(done, 50));
          expect(duplicate).toBe(false);
        } finally {
          if (lock.isTransactionActive) await lock.rollbackTransaction();
          await lock.release();
        }
        await first;
        await repeated;
        const [request] = await received;
        const closed = once((request as http.IncomingMessage).socket, 'close');
        await scheduler.onModuleDestroy();
        await closed;
        expect((await jobs(configured.destinationId))[0]).toMatchObject({
          status: 'queued',
          attempts: 1,
          error: 'cancelled',
        });
      })();
      runtimes.add(owned);
      try {
        await owned;
      } finally {
        runtimes.delete(owned);
      }
    });
  },
);
