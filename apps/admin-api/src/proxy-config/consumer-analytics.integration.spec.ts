import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { DataSource, QueryRunner } from 'typeorm';
import {
  ConsumerUsageStats,
  MetricsSnapshot,
  RequestLog,
} from '@api-gateway/shared-types';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { tenantSchema } from '../tenants/tenant-schema';
import { ConfigPushService } from '../config-push/config-push.service';
import { MetricsStreamService } from './metrics-stream.service';
import { AnalyticsController } from './analytics.controller';
import {
  ConsumerAnalyticsService,
  CONSUMER_ANALYTICS_ROW_LIMIT,
} from './consumer-analytics.service';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const SECRET = 'consumer-usage-local-fixture-secret-more-than-32-chars';
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
integration(
  'Consumer analytics over actual PostgreSQL and authenticated HTTP',
  () => {
    let db: DataSource;
    let app: INestApplication;
    let url: string;
    const tenants = [randomUUID(), randomUUID()];
    const consumer = randomUUID(),
      other = randomUUID(),
      empty = randomUUID(),
      highVolume = randomUUID();
    const previousSecret = process.env.PLATFORM_JWT_SECRET;
    const schema = tenantSchema(tenants[0]);
    const history = jest.fn().mockResolvedValue([{ rps: 123 }]);
    let clock: jest.SpyInstance;
    function headers(tenant: string = tenants[0]) {
      return {
        authorization: `Bearer ${sign({ sub: tenant }, SECRET, { expiresIn: '10m' })}`,
      };
    }
    async function get(
      id: string = consumer,
      period = '1h',
      tenant: string = tenants[0],
    ) {
      return fetch(
        `${url}/tenants/${tenant}/consumers/${id}/stats?period=${period}`,
        { headers: headers(tenant) },
      );
    }
    beforeAll(async () => {
      process.env.PLATFORM_JWT_SECRET = SECRET;
      db = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
        extra: {
          max: 8,
          connectionTimeoutMillis: 3000,
          options: '-c timezone=Asia/Kolkata',
        },
      });
      await db.initialize();
      for (const tenant of tenants) {
        const s = tenantSchema(tenant);
        await db.query(`CREATE SCHEMA ${s}`);
        await db.query(
          `CREATE TABLE ${s}.consumers (id UUID PRIMARY KEY,name TEXT,"revokedAt" TIMESTAMP,"keyHash" TEXT)`,
        );
        await db.query(
          `CREATE TABLE ${s}.request_logs (id UUID PRIMARY KEY,"consumerId" UUID,method TEXT,path TEXT,"statusCode" INTEGER,"responseTimeMs" INTEGER,timestamp TIMESTAMPTZ)`,
        );
        await db.query(
          `CREATE INDEX request_logs_consumer_time ON ${s}.request_logs ("consumerId",timestamp DESC,id DESC) WHERE "consumerId" IS NOT NULL`,
        );
      }
      await db.query(
        `INSERT INTO ${schema}.consumers (id,name,"keyHash") VALUES ($1,'Storefront','private-never-return'),($2,'Other','secret'),($3,'Unused','secret'),($4,'Large','secret')`,
        [consumer, other, empty, highVolume],
      );
      const module = await Test.createTestingModule({
        controllers: [AnalyticsController],
        providers: [
          ConsumerAnalyticsService,
          { provide: APP_GUARD, useClass: TenantAuthGuard },
          { provide: DataSource, useValue: db },
          { provide: ConfigPushService, useValue: {} },
          { provide: MetricsStreamService, useValue: { history } },
        ],
      }).compile();
      app = module.createNestApplication({ forceCloseConnections: true });
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
      clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    }, 30000);
    afterAll(async () => {
      clock?.mockRestore();
      await app?.close();
      if (db?.isInitialized) {
        for (const tenant of tenants)
          await db.query(
            `DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`,
          );
        await db.destroy();
      }
      if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previousSecret;
    });
    it('requires a session and rejects foreign workspaces/consumers', async () => {
      const path = `/tenants/${tenants[0]}/consumers/${consumer}/stats`;
      expect((await fetch(url + path)).status).toBe(401);
      expect(
        (await fetch(url + path, { headers: headers(tenants[1]) })).status,
      ).toBe(403);
      expect((await get(consumer, '1h', tenants[1])).status).toBe(404);
      expect((await get(randomUUID())).status).toBe(404);
      expect((await get('bad')).status).toBe(400);
      expect((await get(consumer, '30d')).status).toBe(400);
    });
    it('returns exact half-open UTC counts, percentiles, top paths and gap-filled rates', async () => {
      const rows = [
        [
          consumer,
          '/orders?token=private',
          200,
          10,
          '2026-10-06T11:00:00.000Z',
        ],
        [consumer, '/orders', 500, 20, '2026-10-06T11:00:00.001Z'],
        [consumer, '/users', 404, 30, '2026-10-06T11:01:00.000Z'],
        [consumer, '/users', 503, 40, '2026-10-06T11:59:59.999999Z'],
        [consumer, '/missing-latency', 200, -1, '2026-10-06T11:02:00.000Z'],
        [consumer, '/missing-latency', 200, null, '2026-10-06T11:02:00.001Z'],
        [consumer, '/excluded-before', 500, 999, '2026-10-06T10:59:59.999999Z'],
        [consumer, '/excluded-end', 500, 999, '2026-10-06T12:00:00.000Z'],
        [other, '/foreign-consumer', 500, 999, '2026-10-06T11:00:00.000Z'],
        [null, '/anonymous', 500, 999, '2026-10-06T11:00:00.000Z'],
      ];
      for (const [id, path, status, latency, timestamp] of rows)
        await db.query(
          `INSERT INTO ${schema}.request_logs VALUES ($1,$2,'GET',$3,$4,$5,$6)`,
          [randomUUID(), id, path, status, latency, timestamp],
        );
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const result = (await response.json()) as ConsumerUsageStats;
      expect(result).toMatchObject({
        consumer: { id: consumer, name: 'Storefront', revokedAt: null },
        source: 'persisted_request_logs',
        from: '2026-10-06T11:00:00.000Z',
        to: '2026-10-06T12:00:00.000Z',
        requests: 6,
        serverErrors: 2,
        latencySamples: 4,
        p50Ms: 25,
        p95Ms: 38.5,
        p99Ms: 39.7,
        bucketSeconds: 60,
      });
      expect(result.rps).toBeCloseTo(6 / 3600);
      expect(result.errorRate).toBeCloseTo(2 / 6);
      expect(result.series).toHaveLength(60);
      expect(result.series.reduce((sum, b) => sum + b.requests, 0)).toBe(6);
      expect(result.series[0]).toMatchObject({
        timestamp: '2026-10-06T11:00:00.000Z',
        requests: 2,
        rps: 2 / 60,
        errorRate: 0.5,
      });
      expect(result.series[3]).toMatchObject({
        requests: 0,
        rps: 0,
        errorRate: 0,
        p95Ms: null,
      });
      expect(result.series[2]).toMatchObject({
        requests: 2,
        latencySamples: 0,
        p95Ms: null,
      });
      expect(result.topPaths.map((p) => p.path)).toEqual([
        '/missing-latency',
        '/orders',
        '/users',
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /private|keyHash|anonymous|foreign-consumer|excluded/,
      );
    });
    it('preserves revoked history and returns explicit empty windows', async () => {
      await db.query(
        `UPDATE ${schema}.consumers SET "revokedAt"='2026-10-06 11:59:00' WHERE id=$1`,
        [consumer],
      );
      const result = (await (await get()).json()) as ConsumerUsageStats;
      expect(result.consumer.revokedAt).toBe('2026-10-06T11:59:00.000Z');
      expect(result.requests).toBe(6);
      const unused = (await (await get(empty)).json()) as ConsumerUsageStats;
      expect(unused).toMatchObject({
        requests: 0,
        rps: 0,
        errorRate: 0,
        latencySamples: 0,
        p95Ms: null,
        topPaths: [],
      });
      expect(unused.series).toHaveLength(60);
      expect(
        ((await (await get(empty, '24h')).json()) as ConsumerUsageStats).series,
      ).toHaveLength(96);
      expect(
        ((await (await get(empty, '7d')).json()) as ConsumerUsageStats).series,
      ).toHaveLength(168);
    });
    it('filters existing metrics/logs by consumer without replacing global history', async () => {
      let response = await fetch(
        `${url}/tenants/${tenants[0]}/metrics?period=1h&consumerId=${consumer}`,
        { headers: headers() },
      );
      const metrics = (await response.json()) as MetricsSnapshot[];
      expect(metrics).toHaveLength(60);
      expect(metrics[0]).toMatchObject({
        rps: 2 / 60,
        errorRate: 0.5,
        p95Ms: 19.5,
      });
      expect(metrics[3]).toMatchObject({ rps: 0, p95Ms: 0 });
      expect(history).not.toHaveBeenCalled();
      response = await fetch(`${url}/tenants/${tenants[0]}/metrics?period=1h`, {
        headers: headers(),
      });
      expect(await response.json()).toEqual([{ rps: 123 }]);
      response = await fetch(
        `${url}/tenants/${tenants[0]}/logs?consumerId=${consumer}`,
        { headers: headers() },
      );
      const logs = (await response.json()) as RequestLog[];
      expect(logs).toHaveLength(8);
      expect(logs.every((log) => log.consumerId === consumer)).toBe(true);
      expect(
        (
          await fetch(`${url}/tenants/${tenants[0]}/logs?consumerId=invalid`, {
            headers: headers(),
          })
        ).status,
      ).toBe(400);
    });
    it('rejects an actual over-limit window without reporting partial totals and recovers a smaller period', async () => {
      await db.query(
        `INSERT INTO ${schema}.request_logs SELECT gen_random_uuid(),$1,'GET','/large',200,1,'2026-10-06T10:00:00Z'::timestamptz FROM generate_series(1,$2)`,
        [highVolume, CONSUMER_ANALYTICS_ROW_LIMIT + 1],
      );
      const response = await get(highVolume, '24h');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        message: expect.stringContaining('shorter period'),
      });
      expect(await (await get(highVolume, '1h')).json()).toMatchObject({
        requests: 0,
      });
    }, 10000);
    it('accepts the exact row limit and bounds top-path cardinality/labels', async () => {
      await db.query(
        `DELETE FROM ${schema}.request_logs WHERE id=(SELECT id FROM ${schema}.request_logs WHERE "consumerId"=$1 LIMIT 1)`,
        [highVolume],
      );
      const response = await get(highVolume, '24h');
      expect(response.status).toBe(200);
      const large = (await response.json()) as ConsumerUsageStats;
      expect(large.requests).toBe(CONSUMER_ANALYTICS_ROW_LIMIT);
      expect(large.p95Ms).toBe(1);
      expect(large.series.reduce((sum, b) => sum + b.requests, 0)).toBe(
        CONSUMER_ANALYTICS_ROW_LIMIT,
      );
      await db.query(
        `INSERT INTO ${schema}.request_logs SELECT gen_random_uuid(),$1,'GET','/bounded-'||i,200,1,'2026-10-06T11:30:00Z'::timestamptz FROM generate_series(1,20) i`,
        [empty],
      );
      await db.query(
        `INSERT INTO ${schema}.request_logs SELECT gen_random_uuid(),$1,'GET',$2,200,1,'2026-10-06T11:30:00Z'::timestamptz FROM generate_series(1,30)`,
        [empty, '/' + 'x'.repeat(1024)],
      );
      const paths = ((await (await get(empty)).json()) as ConsumerUsageStats)
        .topPaths;
      expect(paths).toHaveLength(10);
      expect(paths.every((p) => p.path.length <= 512)).toBe(true);
      expect(paths[0]).toMatchObject({
        path: '/' + 'x'.repeat(511),
        requests: 30,
      });
    }, 10000);
    it('cancels an actual slow SQL statement and recovers cleanly', async () => {
      await db.query(
        `ALTER TABLE ${schema}.request_logs RENAME TO slow_source`,
      );
      try {
        await db.query(
          `CREATE FUNCTION ${schema}.slow_log(UUID) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_sleep(1); RETURN true; END $$`,
        );
        await db.query(
          `CREATE VIEW ${schema}.request_logs AS SELECT * FROM ${schema}.slow_source WHERE ${schema}.slow_log(id)`,
        );
        const started = performance.now();
        const response = await get();
        expect(response.status).toBe(503);
        expect(performance.now() - started).toBeLessThan(4500);
        expect(JSON.stringify(await response.json())).not.toMatch(
          /slow_log|statement timeout/,
        );
      } finally {
        await db.query(`DROP VIEW IF EXISTS ${schema}.request_logs`);
        await db.query(
          `ALTER TABLE ${schema}.slow_source RENAME TO request_logs`,
        );
        await db.query(`DROP FUNCTION IF EXISTS ${schema}.slow_log(UUID)`);
      }
      expect((await get()).status).toBe(200);
    }, 10000);
    it('bounds blocked reads with a real database lock and releases admission for recovery', async () => {
      const locker: QueryRunner = db.createQueryRunner();
      await locker.connect();
      await locker.startTransaction();
      try {
        await locker.query(
          `LOCK TABLE ${schema}.request_logs IN ACCESS EXCLUSIVE MODE`,
        );
        const started = performance.now();
        const response = await get();
        expect(response.status).toBe(503);
        expect(performance.now() - started).toBeLessThan(2500);
        expect(JSON.stringify(await response.json())).not.toContain(
          'request_logs',
        );
      } finally {
        await locker.rollbackTransaction();
        await locker.release();
      }
      expect((await get()).status).toBe(200);
    }, 10000);
  },
);
