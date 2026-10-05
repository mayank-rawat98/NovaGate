import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { tenantSchema } from '../tenants/tenant-schema';
import { ConfigPushService } from '../config-push/config-push.service';
import { AnalyticsController } from './analytics.controller';
import { MetricsStreamService } from './metrics-stream.service';
const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
const SECRET = 'metrics-live-fixture-secret-at-least-32-characters';
integration(
  'Authenticated live metrics over PostgreSQL, Redis and real HTTP SSE',
  () => {
    let ds: DataSource;
    let redis: Redis;
    let app: INestApplication;
    let url: string;
    const tenants = [randomUUID(), randomUUID()];
    const controllers: AbortController[] = [];
    const previousSecret = process.env.PLATFORM_JWT_SECRET;
    const snapshot = (rps: number) => ({
      rps,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      errorRate: 0,
      timestamp: new Date().toISOString(),
    });
    function auth(tenant = tenants[0]) {
      return {
        authorization: `Bearer ${sign({ sub: tenant }, SECRET, { expiresIn: 60 })}`,
      };
    }
    async function open(tenant = tenants[0]) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${url}/tenants/${tenant}/metrics/stream`, {
        headers: auth(tenant),
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      if (!response.body) throw new Error('Missing live metric response body');
      return { response, controller, reader: response.body.getReader() };
    }
    async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
      let buffer = '';
      const decoder = new TextDecoder();
      const read = async () => {
        while (true) {
          const result = await reader.read();
          if (result.done)
            throw new Error('Stream ended before a metric sample');
          buffer += decoder.decode(result.value, { stream: true });
          const match = /event: metrics\ndata: ([^\n]+)\n\n/.exec(buffer);
          if (match) return JSON.parse(match[1]);
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Live sample exceeded two seconds')),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    beforeAll(async () => {
      process.env.PLATFORM_JWT_SECRET = SECRET;
      ds = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await ds.initialize();
      redis = new Redis(process.env.TEST_REDIS_URL as string);
      await redis.ping();
      for (const tenant of tenants) {
        const schema = tenantSchema(tenant);
        await ds.query(`CREATE SCHEMA ${schema}`);
        await ds.query(
          `CREATE TABLE ${schema}.metrics_snapshots (rps DOUBLE PRECISION, "p50Ms" INTEGER, "p95Ms" INTEGER, "p99Ms" INTEGER, "errorRate" DOUBLE PRECISION, timestamp TIMESTAMPTZ)`,
        );
        await ds.query(
          `INSERT INTO ${schema}.metrics_snapshots VALUES ($1, 1, 2, 3, 0, NOW())`,
          [tenant === tenants[0] ? 10 : 20],
        );
      }
      const module = await Test.createTestingModule({
        controllers: [AnalyticsController],
        providers: [
          MetricsStreamService,
          { provide: APP_GUARD, useClass: TenantAuthGuard },
          { provide: DataSource, useValue: ds },
          {
            provide: ConfigService,
            useValue: new ConfigService({
              REDIS_URL: process.env.TEST_REDIS_URL,
              metricStream: {
                maxPerTenant: 1,
                heartbeatMs: 1000,
                historyLimit: 2,
              },
            }),
          },
          { provide: ConfigPushService, useValue: {} },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    }, 30000);
    afterAll(async () => {
      controllers.forEach((controller) => controller.abort());
      await app?.close();
      redis?.disconnect();
      if (ds?.isInitialized) {
        for (const tenant of tenants)
          await ds.query(
            `DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`,
          );
        await ds.destroy();
      }
      if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previousSecret;
    });
    it('rejects missing sessions, query-token authentication and cross-workspace sessions', async () => {
      expect(
        (await fetch(`${url}/tenants/${tenants[0]}/metrics/stream`)).status,
      ).toBe(401);
      expect(
        (
          await fetch(
            `${url}/tenants/${tenants[0]}/metrics/stream?token=${sign({ sub: tenants[0] }, SECRET)}`,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${url}/tenants/${tenants[1]}/metrics/stream`, {
            headers: auth(),
          })
        ).status,
      ).toBe(403);
    });
    it('delivers only the admitted tenant within two seconds, enforces capacity and recovers a fresh persisted snapshot after reconnect', async () => {
      const first = await open();
      try {
        expect((await next(first.reader)).rps).toBe(10);
        expect(
          (
            await fetch(`${url}/tenants/${tenants[0]}/metrics/stream`, {
              headers: auth(),
            })
          ).status,
        ).toBe(503);
        await redis.publish(
          `metrics:${tenants[1]}`,
          JSON.stringify(snapshot(999)),
        );
        await redis.publish(
          `metrics:${tenants[0]}`,
          JSON.stringify(snapshot(7.25)),
        );
        expect((await next(first.reader)).rps).toBe(7.25);
        await redis.publish(
          `metrics:${tenants[0]}`,
          JSON.stringify({ ...snapshot(1), errorRate: 2 }),
        );
        await redis.publish(
          `metrics:${tenants[0]}`,
          JSON.stringify(snapshot(8.75)),
        );
        expect((await next(first.reader)).rps).toBe(8.75);
      } finally {
        first.controller.abort();
        await first.reader.cancel().catch(() => undefined);
      }
      await ds.query(
        `INSERT INTO ${tenantSchema(tenants[0])}.metrics_snapshots VALUES (9.125, 1, 2, 3, 0, NOW())`,
      );
      // Ensure actual close cleanup has released admission, not merely the browser abort call.
      const service = app.get(MetricsStreamService);
      for (
        let i = 0;
        i < 100 && (service as unknown as { total: number }).total;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await open();
      try {
        expect((await next(second.reader)).rps).toBe(9.125);
      } finally {
        second.controller.abort();
        await second.reader.cancel().catch(() => undefined);
      }
      const history = await fetch(
        `${url}/tenants/${tenants[0]}/metrics?period=7d`,
        { headers: auth() },
      );
      expect(await history.json()).toHaveLength(2);
    });
  },
);
