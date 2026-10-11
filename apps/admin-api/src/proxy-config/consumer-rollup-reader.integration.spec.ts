import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { sign } from 'jsonwebtoken';
import type {
  ConsumerUsageStats,
  MetricHistorySnapshot,
} from '@api-gateway/shared-types';
import { CONSUMER_ROLLUP_QUERY_CELL_LIMIT } from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { ConsumerAnalyticsService } from './consumer-analytics.service';
import { ConsumerRollupService } from './consumer-rollup.service';
import { readConsumerRollup } from './consumer-rollup-reader';
import { AnalyticsController } from './analytics.controller';
import { MetricsStreamService } from './metrics-stream.service';
import { LogPrivacyService } from '../log-privacy/log-privacy.service';
import { RetentionCaseWork } from '../database/retention-case-work.fixture';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const SECRET = 'rollup-reader-verification-secret-more-than-32-characters';
integration(
  'Consumer rollup queries on actual PostgreSQL and authenticated HTTP',
  () => {
    let root: DataSource, db: DataSource, app: INestApplication, url: string;
    const database = `novagate_usage_read_${randomUUID().replace(/-/g, '')}`;
    const tenants: string[] = [];
    const cases = new RetentionCaseWork();
    const request = (target: string, options?: RequestInit) =>
      fetch(target, { ...options, signal: AbortSignal.timeout(5000) });
    const previousSecret = process.env.PLATFORM_JWT_SECRET;
    async function workspace() {
      const id = randomUUID(),
        consumer = randomUUID();
      tenants.push(id);
      await db.query(
        `INSERT INTO public.tenants (id,name,email,"planId") VALUES ($1,'Usage reader',$2,'free')`,
        [id, `${id}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(id);
      const schema = tenantSchema(id);
      await db.query(
        `INSERT INTO ${schema}.consumers (id,name,"keyHash") VALUES ($1,'Large consumer','never-return-private-key')`,
        [consumer],
      );
      return { id, consumer, schema };
    }
    beforeAll(async () => {
      process.env.PLATFORM_JWT_SECRET = SECRET;
      root = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await root.initialize();
      await root.query(`CREATE DATABASE ${database}`);
      const databaseUrl = new URL(process.env.TEST_DATABASE_URL as string);
      databaseUrl.pathname = `/${database}`;
      db = new DataSource({
        type: 'postgres',
        url: databaseUrl.toString(),
        extra: {
          max: 8,
          connectionTimeoutMillis: 3000,
          options:
            '-c timezone=Asia/Kolkata -c statement_timeout=15000 -c lock_timeout=3000',
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
      const module = await Test.createTestingModule({
        controllers: [AnalyticsController],
        providers: [
          ConsumerAnalyticsService,
          { provide: DataSource, useValue: db },
          { provide: APP_GUARD, useClass: TenantAuthGuard },
          { provide: ConfigPushService, useValue: {} },
          { provide: MetricsStreamService, useValue: {} },
        ],
      }).compile();
      app = module.createNestApplication({ forceCloseConnections: true });
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    }, 30000);
    afterEach(
      () =>
        cases.finish(async () => {
          for (const id of tenants.splice(0)) {
            await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(id)} CASCADE`);
            await db.query('DELETE FROM public.api_keys WHERE "tenantId"=$1', [
              id,
            ]);
            await db.query(
              'DELETE FROM public.pending_config_updates WHERE "tenantId"=$1',
              [id],
            );
            await db.query('DELETE FROM public.tenants WHERE id=$1', [id]);
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
    }, 30000);
    async function read(
      id: string,
      consumer: string,
      from: string,
      to: string,
      receiptCutoff: string,
      bucketSeconds = 60,
    ) {
      return db.transaction('REPEATABLE READ', async (manager) => {
        await manager.query(
          "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'; SET LOCAL work_mem='4MB'",
        );
        return readConsumerRollup(manager, {
          tenantId: id,
          consumerId: consumer,
          from,
          to,
          receiptCutoff,
          bucketSeconds,
        });
      });
    }

    it(
      'serves 200,001 real stored records over the existing authenticated usage route without raw percentile scans',
      () =>
        cases.run(async () => {
          const deadline = performance.now() + 60000;
          const checkpoint = (phase: string) => {
            if (performance.now() > deadline)
              throw new Error(
                `Consumer rollup reader fixture exceeded its owned 60-second budget during ${phase}`,
              );
          };
          const { id, schema, consumer } = await workspace();
          await db.query(
            `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"statusCode","responseTimeMs",method,path)
      SELECT gen_random_uuid(),$1,date_trunc('minute',statement_timestamp())-INTERVAL '2 hours',
        CASE WHEN i%10=0 THEN 503 ELSE 200 END,CASE WHEN i%20=0 THEN NULL WHEN i%20=1 THEN -1 ELSE 3 END,'GET','/large?secret=never-return'
      FROM generate_series(1,200001) i`,
            [consumer],
          );
          checkpoint('bulk insertion');
          const worker = new ConsumerRollupService(db);
          try {
            for (let round = 0; round < 52; round++) {
              checkpoint('bounded backfill');
              await worker.sweep();
              const [state] = await db.query(
                `SELECT backfill_complete FROM ${schema}.consumer_usage_rollup_state`,
              );
              if (state.backfill_complete) break;
            }
          } finally {
            await worker.onModuleDestroy();
          }
          checkpoint('authenticated reads');
          const headers = {
            authorization: `Bearer ${sign({ sub: id }, SECRET, { expiresIn: '10m' })}`,
          };
          const path = `${url}/tenants/${id}/consumers/${consumer}/stats?period=24h`;
          expect((await request(path)).status).toBe(401);
          expect(
            (
              await request(path, {
                headers: {
                  authorization: `Bearer ${sign({ sub: randomUUID() }, SECRET, { expiresIn: '10m' })}`,
                },
              })
            ).status,
          ).toBe(403);
          const response = await request(path, { headers });
          expect(response.status).toBe(200);
          expect(response.headers.get('cache-control')).toBe('no-store');
          const stats = (await response.json()) as ConsumerUsageStats;
          expect(stats.source).toBe('consumer_rollups');
          expect(stats.requests).toBe(200001);
          expect(stats.serverErrors).toBe(20000);
          expect(stats.latencySamples).toBe(180000);
          expect(stats.p50Ms).toBe(4);
          expect(stats.p95Ms).toBe(4);
          expect(stats.p99Ms).toBe(4);
          expect(stats.errorRate).toBe(20000 / 200001);
          expect(stats.rps).toBe(200001 / 86400);
          expect(stats.series.reduce((sum, b) => sum + b.requests, 0)).toBe(
            200001,
          );
          expect(stats.series).toHaveLength(
            Math.ceil(
              (Date.parse(stats.to) -
                Math.floor(Date.parse(stats.from) / 900000) * 900000) /
                900000,
            ),
          );
          expect(
            stats.series.reduce((sum, b) => sum + (b.observedSeconds ?? 0), 0),
          ).toBeCloseTo(86400, 5);
          expect(stats.rollup).toMatchObject({
            counts: 'complete_for_retained_records',
            materialization: 'complete',
            paths: 'complete_for_retained_records',
            pathAggregation: {
              materialization: 'complete',
              rawRecords: 0,
              pendingRecords: 0,
              groups: 1,
            },
            rawRecords: 0,
            pendingRecords: 0,
            lateRecords: 200001,
          });
          expect(stats.topPaths).toEqual([
            {
              method: 'GET',
              path: '/large',
              requests: 200001,
              serverErrors: 20000,
              latencySamples: 180000,
              errorRate: 20000 / 200001,
              rps: 200001 / 86400,
              p50Ms: 4,
              p95Ms: 4,
              p99Ms: 4,
            },
          ]);
          expect(JSON.stringify(stats)).not.toMatch(
            /never-return|histogram"|usageRollupVersion|pathRollupVersion|requestId|clientIp/,
          );
          const metricsResponse = await request(
            `${url}/tenants/${id}/metrics?period=24h&consumerId=${consumer}`,
            { headers },
          );
          expect(metricsResponse.status).toBe(200);
          const metrics =
            (await metricsResponse.json()) as MetricHistorySnapshot[];
          const active = metrics.find((bucket) => bucket.rps > 0);
          expect(active).toMatchObject({
            p95Ms: 4,
            consumerUsage: {
              source: 'consumer_rollups',
              latencySamples: 180000,
              observedSeconds: 900,
              rollup: {
                counts: 'complete_for_retained_records',
                latencyMethod: 'histogram_bucket_upper_bound',
                seriesAlignment: 'utc',
                paths: 'complete_for_retained_records',
                pathAggregation: { groups: 1 },
              },
            },
          });
          expect(metrics[0].consumerUsage?.observedSeconds).toBeGreaterThan(0);
          expect(
            metrics.reduce(
              (sum, bucket) =>
                sum + (bucket.consumerUsage?.latencySamples ?? 0),
              0,
            ),
          ).toBe(180000);

          // Change real policy revisions after a rollup snapshot commits, before the
          // service's current-policy validation. The result must never escape.
          const actual = db.transaction.bind(db);
          for (const revision of [
            'logRetentionRevision',
            'logPrivacyRevision',
          ]) {
            const source = {
              transaction: async (levelOrFn: unknown, body?: unknown) => {
                if (levelOrFn === 'REPEATABLE READ') {
                  const result = await actual(
                    'REPEATABLE READ',
                    body as (
                      manager: EntityManager,
                    ) => Promise<ConsumerUsageStats>,
                  );
                  expect(result.source).toBe('consumer_rollups');
                  await db.query(
                    `UPDATE public.tenants SET "${revision}"=gen_random_uuid() WHERE id=$1`,
                    [id],
                  );
                  return result;
                }
                return actual(
                  levelOrFn as (manager: EntityManager) => Promise<unknown>,
                );
              },
            } as unknown as DataSource;
            const service = new ConsumerAnalyticsService(source);
            try {
              await expect(service.get(id, consumer, '24h')).rejects.toThrow(
                'Log privacy or retention changed',
              );
            } finally {
              await service.onModuleDestroy();
            }
          }
          expect((await request(path, { headers })).status).toBe(200);

          const privacy = new LogPrivacyService(db, {
            persistUpdate: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn(),
          } as unknown as ConfigPushService);
          try {
            const current = await privacy.get(id);
            const pathOmitted = await privacy.save(id, {
              expectedRevision: current.revision,
              policy: {
                clientIp: 'omit',
                userAgent: 'omit',
                redactedFields: ['path'],
              },
            });
            expect(
              await db.query(
                `SELECT path FROM ${schema}.consumer_path_rollups WHERE path='/large' LIMIT 1`,
              ),
            ).toEqual([{ path: '/large' }]);
            const redactedResponse = await request(path, { headers });
            expect(redactedResponse.status).toBe(200);
            const redacted =
              (await redactedResponse.json()) as ConsumerUsageStats;
            expect(redacted.requests).toBe(200001);
            expect(redacted.topPaths).toEqual([
              { ...stats.topPaths[0], path: '[redacted]' },
            ]);
            expect(JSON.stringify(redacted)).not.toContain('/large');
            await privacy.save(id, {
              expectedRevision: pathOmitted.revision,
              policy: {
                clientIp: 'omit',
                userAgent: 'omit',
                redactedFields: ['path', 'consumerId'],
              },
            });
            // Cleanup has not run: the query must suppress existing identities now.
            const [stored] = await db.query(
              `SELECT COUNT(*)::integer AS cells FROM ${schema}.consumer_usage_rollups`,
            );
            expect(stored.cells).toBeGreaterThan(0);
            const hiddenResponse = await request(path, { headers });
            expect(hiddenResponse.status).toBe(200);
            const hidden = (await hiddenResponse.json()) as ConsumerUsageStats;
            expect(hidden).toMatchObject({
              source: 'persisted_request_logs',
              requests: 0,
              latencySamples: 0,
              p95Ms: null,
              privacy: { redactedFields: ['path', 'consumerId'] },
            });
            expect(hidden.rollup).toBeUndefined();
            expect(hidden.series.every((bucket) => bucket.requests === 0)).toBe(
              true,
            );
          } finally {
            await privacy.onModuleDestroy();
          }
        }),
      90000,
    );

    it('reconciles both request edges, pending records and mixed microsecond receipt cells exactly once', () =>
      cases.run(async () => {
        const { id, schema, consumer } = await workspace();
        const from = '2026-10-10T12:00:30.125Z',
          to = '2026-10-10T13:00:30.125Z',
          cutoff = '2026-10-01T12:34:56.123456Z';
        await db.query(
          `UPDATE public.tenants SET "logRetentionDays"=90,"logRetentionFloor"='2026-07-01' WHERE id=$1`,
          [id],
        );
        const records = [
          ['2026-10-10T12:00:30.124999Z', cutoff, 200, 3],
          [from, cutoff, 200, 0],
          [
            '2026-10-10T12:00:30.125001Z',
            '2026-10-01T12:34:56.123455Z',
            503,
            100,
          ],
          ['2026-10-10T12:15:00Z', '2026-10-01T12:34:56.123455Z', 503, 100],
          ['2026-10-10T12:15:01Z', cutoff, 503, 3],
          ['2026-10-10T12:15:02Z', '2026-10-01T12:34:56.123457Z', 200, -1],
          ['2026-10-10T12:16:00Z', '2026-10-01T12:35:00Z', 200, 1],
          ['2026-10-10T13:00:30.124999Z', '2026-10-11T12:00:00Z', 503, 9],
          [to, '2026-10-11T12:00:00Z', 200, 1000],
        ];
        for (const [
          timestamp,
          receivedAt,
          statusCode,
          responseTimeMs,
        ] of records)
          await db.query(
            `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"receivedAt","statusCode","responseTimeMs") VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
            [consumer, timestamp, receivedAt, statusCode, responseTimeMs],
          );
        await db.query(
          `DROP TRIGGER consumer_usage_inserted ON ${schema}.request_logs`,
        );
        await db.query(
          `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"receivedAt","statusCode","responseTimeMs") VALUES (gen_random_uuid(),$1,'2026-10-10T12:17:00Z',$2,200,NULL)`,
          [consumer, cutoff],
        );
        const result = await read(id, consumer, from, to, cutoff);
        expect(result.totals.requests).toBe(6);
        expect(result.totals.serverErrors).toBe(2);
        expect(result.totals.latencySamples).toBe(4);
        expect(result.rollup).toMatchObject({
          rollupCells: 1,
          rawRecords: 5,
          pendingRecords: 1,
          materialization: 'backfilling',
          lateRecords: 1,
        });
        expect(result.series).toHaveLength(61);
        expect(result.series[0]).toMatchObject({
          timestamp: '2026-10-10T12:00:00.000Z',
          observedSeconds: 29.875,
          requests: 1,
          rps: 1 / 29.875,
        });
        expect(result.series[60]).toMatchObject({
          timestamp: '2026-10-10T13:00:00.000Z',
          observedSeconds: 30.125,
          requests: 1,
          rps: 1 / 30.125,
        });
        expect(result.totals.p95Ms).toBe(16);
        expect(result.rollup.pathAggregation).toMatchObject({
          rawRecords: 5,
          pendingRecords: 1,
          rollupCells: 1,
          groups: 1,
          materialization: 'backfilling',
        });
        expect(result.topPaths).toEqual([
          { ...result.totals, method: 'UNKNOWN', path: '/' },
        ]);
        // Advancing the floor and physically pruning old rows cannot reintroduce
        // expired counts from a mixed receipt minute.
        await db.query(
          `DELETE FROM ${schema}.request_logs WHERE "receivedAt"<$1::timestamptz`,
          [cutoff],
        );
        expect((await read(id, consumer, from, to, cutoff)).totals).toEqual(
          result.totals,
        );
        expect((await read(id, consumer, from, to, cutoff)).topPaths).toEqual(
          result.topPaths,
        );
      }));

    it(
      'rejects excess raw reconciliation and cell cardinality without publishing partial totals',
      () =>
        cases.run(async () => {
          const { id, schema, consumer } = await workspace();
          const to = new Date().toISOString(),
            from = new Date(Date.parse(to) - 3600000).toISOString();
          await db.query(
            `DROP TRIGGER consumer_usage_inserted ON ${schema}.request_logs`,
          );
          await db.query(
            `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp) SELECT gen_random_uuid(),$1,$2::timestamptz+INTERVAL '30 minutes' FROM generate_series(1,100001)`,
            [consumer, from],
          );
          await expect(
            read(id, consumer, from, to, '2026-01-01'),
          ).rejects.toThrow(/boundary limit/);
          await db.query(`TRUNCATE ${schema}.request_logs`);
          const weekFrom = new Date(
            Date.parse(to) - 7 * 86400000,
          ).toISOString();
          await db.query(
            `INSERT INTO ${schema}.consumer_usage_rollups
      SELECT $1,date_trunc('minute',$2::timestamptz)+make_interval(secs=>((i-1)/3+1)*60),
        date_trunc('minute',$3::timestamptz)-make_interval(secs=>(i%3)*60),clock_timestamp(),clock_timestamp(),1,0,0,0,array_fill(0::bigint,ARRAY[33])
      FROM generate_series(1,$4::integer) i`,
            [consumer, weekFrom, to, CONSUMER_ROLLUP_QUERY_CELL_LIMIT + 1],
          );
          await expect(
            read(id, consumer, weekFrom, to, '2026-01-01', 3600),
          ).rejects.toThrow(/rollup or boundary limit/);
        }),
      30000,
    );

    it('refuses integer rounding and corrupt histogram coherence', () =>
      cases.run(async () => {
        const { id, schema, consumer } = await workspace();
        const to = new Date().toISOString(),
          from = new Date(Date.parse(to) - 3600000).toISOString();
        await db.query(
          `INSERT INTO ${schema}.consumer_usage_rollups VALUES ($1,date_trunc('minute',clock_timestamp())-INTERVAL '30 minutes',date_trunc('minute',clock_timestamp()),clock_timestamp(),clock_timestamp(),9007199254740993,0,0,0,array_fill(0::bigint,ARRAY[33]))`,
          [consumer],
        );
        await expect(
          read(id, consumer, from, to, '2026-01-01'),
        ).rejects.toThrow(/represented safely/);
        await db.query(
          `UPDATE ${schema}.consumer_usage_rollups SET requests=1,latency_samples=1`,
        );
        await expect(
          read(id, consumer, from, to, '2026-01-01'),
        ).rejects.toThrow(/sample mismatch/);
      }));

    it(
      'selects global top paths across all cells, including a winner below every cell-local top ten',
      () =>
        cases.run(async () => {
          const deadline = performance.now() + 45000;
          const checkpoint = () => {
            if (performance.now() > deadline)
              throw new Error(
                'Global path reader fixture work deadline exceeded',
              );
          };
          const { id, schema, consumer } = await workspace();
          await db.query(
            `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"statusCode","responseTimeMs")
        SELECT gen_random_uuid(),$1,date_trunc('minute',statement_timestamp())-INTERVAL '20 minutes'+make_interval(secs=>CASE WHEN i<=92400 THEN ((i-1)/15400)*60 ELSE ((i-92401)%6)*60 END),
          statement_timestamp(),'GET',CASE WHEN i<=92400 THEN '/cell/'||((i-1)/15400)||'/'||(((i-1)%15400)/1400) ELSE '/winner?private=never-return' END,
          CASE WHEN i%10=0 THEN 503 ELSE 200 END,CASE WHEN i<=92400 THEN 3 ELSE 9 END FROM generate_series(1,100001) i`,
            [consumer],
          );
          checkpoint();
          const worker = new ConsumerRollupService(db);
          try {
            for (let i = 0; i < 26; i++) {
              checkpoint();
              await worker.sweep();
              const [state] = await db.query(
                `SELECT backfill_complete FROM ${schema}.consumer_path_rollup_state`,
              );
              if (state.backfill_complete) break;
            }
          } finally {
            await worker.onModuleDestroy();
          }
          const response = await request(
            `${url}/tenants/${id}/consumers/${consumer}/stats?period=1h`,
            {
              headers: {
                authorization: `Bearer ${sign({ sub: id }, SECRET, { expiresIn: '10m' })}`,
              },
            },
          );
          expect(response.status).toBe(200);
          const stats = (await response.json()) as ConsumerUsageStats;
          expect(stats.requests).toBe(100001);
          expect(stats.rollup?.pathAggregation).toMatchObject({
            groups: 67,
            materialization: 'complete',
            pendingRecords: 0,
          });
          expect(stats.topPaths).toHaveLength(10);
          expect(
            await db.query(`SELECT COUNT(*)::integer AS cells,MIN(position)::integer AS "minRank",MAX(position)::integer AS "maxRank" FROM (
          SELECT path,row_number() OVER(PARTITION BY consumer_id,request_minute,receipt_minute ORDER BY requests DESC,method,path) AS position FROM ${schema}.consumer_path_rollups
        ) ranked WHERE path='/winner'`),
          ).toEqual([{ cells: 6, minRank: 12, maxRank: 12 }]);
          expect(stats.topPaths[0]).toMatchObject({
            method: 'GET',
            path: '/winner',
            requests: 7601,
            latencySamples: 7601,
            p50Ms: 16,
            p95Ms: 16,
            p99Ms: 16,
          });
          const expected = await db.query(
            `SELECT method,LEFT(split_part(path,'?',1),512) COLLATE "C" AS path,COUNT(*)::integer AS requests,COUNT(*) FILTER(WHERE "statusCode">=500)::integer AS "serverErrors" FROM ${schema}.request_logs GROUP BY 1,2 ORDER BY requests DESC,method COLLATE "C",path LIMIT 10`,
          );
          expect(
            stats.topPaths.map(({ method, path, requests, serverErrors }) => ({
              method,
              path,
              requests,
              serverErrors,
            })),
          ).toEqual(expected);
          expect(
            stats.topPaths
              .slice(1)
              .every((group) => group.requests === 1400 && group.p95Ms === 4),
          ).toBe(true);
          expect(JSON.stringify(stats)).not.toMatch(
            /never-return|histogram"|RollupVersion/,
          );
        }),
      60000,
    );

    it('reconciles a window within one minute without overlapping its two edges and projects every group before cleanup', () =>
      cases.run(async () => {
        const { id, schema, consumer } = await workspace();
        const from = '2026-10-10T12:00:30.125Z',
          to = '2026-10-10T12:00:50.125Z',
          cutoff = '2026-10-01T12:34:56.123456Z';
        await db.query(
          'UPDATE public.tenants SET "logRetentionDays"=90 WHERE id=$1',
          [id],
        );
        const records = [
          ['2026-10-10T12:00:30.124999Z', 'GET', '/excluded', 200, 100],
          [from, 'GET', '/one?token=private', 503, 9],
          ['2026-10-10T12:00:40Z', 'GET', '/one?different=private', 200, 0],
          ['2026-10-10T12:00:50.124999Z', 'POST', '/two?private=yes', 200, -1],
          [to, 'GET', '/excluded', 503, 100],
        ];
        for (const [timestamp, method, path, status, duration] of records)
          await db.query(
            `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"statusCode","responseTimeMs") VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
            [consumer, timestamp, cutoff, method, path, status, duration],
          );
        await db.query(
          `DROP TRIGGER consumer_usage_inserted ON ${schema}.request_logs`,
        );
        await db.query(
          `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path) VALUES(gen_random_uuid(),$1,'2026-10-10T12:00:45Z',$2,'POST','/two?private=pending')`,
          [consumer, cutoff],
        );
        const result = await read(id, consumer, from, to, cutoff);
        expect(result.totals).toMatchObject({
          requests: 4,
          serverErrors: 1,
          latencySamples: 2,
          rps: 0.2,
        });
        expect(result.rollup.pathAggregation).toMatchObject({
          groups: 2,
          rawRecords: 4,
          pendingRecords: 1,
          rollupCells: 0,
        });
        expect(result.topPaths).toEqual([
          {
            method: 'GET',
            path: '/one',
            requests: 2,
            serverErrors: 1,
            errorRate: 0.5,
            rps: 0.1,
            latencySamples: 2,
            p50Ms: 0,
            p95Ms: 16,
            p99Ms: 16,
          },
          {
            method: 'POST',
            path: '/two',
            requests: 2,
            serverErrors: 0,
            errorRate: 0,
            rps: 0.1,
            latencySamples: 0,
            p50Ms: null,
            p95Ms: null,
            p99Ms: null,
          },
        ]);
        const hidden = await db.transaction('REPEATABLE READ', (manager) =>
          readConsumerRollup(manager, {
            tenantId: id,
            consumerId: consumer,
            from,
            to,
            receiptCutoff: cutoff,
            bucketSeconds: 60,
            pathHidden: true,
          }),
        );
        expect(hidden.topPaths.map((path) => path.path)).toEqual([
          '[redacted]',
          '[redacted]',
        ]);
        expect(hidden.topPaths.map((path) => path.requests)).toEqual([2, 2]);
        expect(hidden.totals).toEqual(result.totals);
        expect(JSON.stringify(hidden)).not.toMatch(/\/one|\/two|private/);
      }));

    it(
      'tracks path-only pending and capacity state independently and rejects excess path work without partial results',
      () =>
        cases.run(async () => {
          const { id, schema, consumer } = await workspace();
          const from = new Date(Date.now() - 3600000).toISOString(),
            to = new Date().toISOString();
          await db.query(
            `DROP TRIGGER consumer_usage_inserted ON ${schema}.request_logs`,
          );
          await db.query(
            `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"usageRollupVersion") SELECT gen_random_uuid(),$1,date_trunc('minute',statement_timestamp())-INTERVAL '30 minutes',date_trunc('minute',statement_timestamp()),'GET','/pending?secret=private',1 FROM generate_series(1,100001)`,
            [consumer],
          );
          await db.query(
            `INSERT INTO ${schema}.consumer_usage_rollups SELECT $1::uuid,date_trunc('minute',timestamp),date_trunc('minute',"receivedAt"),MIN("receivedAt"),MAX("receivedAt"),COUNT(*),0,0,COUNT(*),array_fill(0::bigint,ARRAY[33]) FROM ${schema}.request_logs GROUP BY 1,2,3`,
            [consumer],
          );
          await db.query(
            `UPDATE ${schema}.consumer_usage_rollup_state SET cells=1,backfill_complete=true`,
          );
          await expect(
            read(id, consumer, from, to, '2026-01-01'),
          ).rejects.toThrow(/path or boundary limit/);
          // A finite independent path backlog is fully reconciled, even while its store is pressured.
          await db.query(
            `DELETE FROM ${schema}.request_logs WHERE id IN(SELECT id FROM ${schema}.request_logs LIMIT 2)`,
          );
          await db.query(
            `UPDATE ${schema}.consumer_usage_rollups SET requests=99999,late_records=99999`,
          );
          await db.query(
            `UPDATE ${schema}.consumer_path_rollup_state SET capacity_blocked=true`,
          );
          const result = await read(id, consumer, from, to, '2026-01-01');
          expect(result.rollup.materialization).toBe('complete');
          expect(result.rollup.pathAggregation).toMatchObject({
            materialization: 'capacity_limited',
            pendingRecords: 99999,
            rawRecords: 99999,
            rollupCells: 0,
            groups: 1,
          });
          expect(result.topPaths).toEqual([
            { ...result.totals, method: 'GET', path: '/pending' },
          ]);
          await db.query(`TRUNCATE ${schema}.request_logs`);
          await db.query(
            `UPDATE ${schema}.consumer_usage_rollups SET requests=20001,late_records=20001`,
          );
          await db.query(
            `INSERT INTO ${schema}.consumer_path_rollups SELECT $1,date_trunc('minute',clock_timestamp())-INTERVAL '30 minutes',date_trunc('minute',clock_timestamp()),'GET','/group/'||i,clock_timestamp(),clock_timestamp(),1,0,0,array_fill(0::bigint,ARRAY[33]) FROM generate_series(1,20001) i`,
            [consumer],
          );
          await expect(
            read(id, consumer, from, to, '2026-01-01'),
          ).rejects.toThrow(/path or boundary limit/);
        }),
      30000,
    );

    it('refuses path/count and histogram disagreement instead of publishing incomplete groups', () =>
      cases.run(async () => {
        const { id, schema, consumer } = await workspace();
        const from = new Date(Date.now() - 3600000).toISOString(),
          to = new Date().toISOString();
        await db.query(
          `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"responseTimeMs",method,path) VALUES(gen_random_uuid(),$1,date_trunc('minute',clock_timestamp())-INTERVAL '30 minutes',3,'GET','/coherence')`,
          [consumer],
        );
        await db.query(`UPDATE ${schema}.consumer_path_rollups SET requests=2`);
        await expect(
          read(id, consumer, from, to, '2026-01-01'),
        ).rejects.toThrow(/does not match retained counts/);
        await db.query(
          `UPDATE ${schema}.consumer_path_rollups SET requests=1,histogram=ARRAY[0,0,1]::bigint[]||array_fill(0::bigint,ARRAY[30])`,
        );
        await expect(
          read(id, consumer, from, to, '2026-01-01'),
        ).rejects.toThrow(/does not match retained counts/);
        await db.query(
          `UPDATE ${schema}.consumer_path_rollups SET histogram=array_fill(0::bigint,ARRAY[33])`,
        );
        await expect(
          read(id, consumer, from, to, '2026-01-01'),
        ).rejects.toThrow(/sample mismatch/);
        await db.query(
          `UPDATE ${schema}.consumer_path_rollups SET requests=9007199254740993,latency_samples=0`,
        );
        await expect(
          read(id, consumer, from, to, '2026-01-01'),
        ).rejects.toThrow(/represented safely/);
      }));
  },
);
