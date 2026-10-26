import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { AlertDeliveryService } from './alert-delivery.service';
import { AlertRulesService } from './alert-rules.service';
import { AlertTransportService } from './alert-transport.service';
import { ALERT_SCHEDULE_SCHEMA } from './alert-schema';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { METRIC_LATENCY_BUCKETS } from '@api-gateway/shared-types';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration(
  'durable alert delivery (PostgreSQL replicas and real HTTP)',
  () => {
    const database = `novagate_alert_delivery_${randomUUID().replace(/-/g, '')}`;
    let root: DataSource;
    let ds: DataSource;
    let tenant: string;
    let schema: string;
    let server: Server;
    let origin: string;
    let rules: AlertRulesService;
    let transport: AlertTransportService;
    let worker: AlertDeliveryService;
    let replica: AlertDeliveryService;
    let mode: 'ok' | 'retry' | 'permanent' | 'stall';
    let requests: string[];
    let received: (() => void) | undefined;

    beforeAll(async () => {
      root = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await root.initialize();
      await root.query(`CREATE DATABASE ${database}`);
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      url.pathname = `/${database}`;
      ds = new DataSource({ type: 'postgres', url: url.toString() });
      await ds.initialize();
      await ds.query(
        readFileSync(
          resolve(__dirname, '../../../../docker/postgres-init.sql'),
          'utf8',
        ),
      );
      await ds.query(ALERT_SCHEDULE_SCHEMA);
    }, 30000);
    beforeEach(async () => {
      mode = 'ok';
      requests = [];
      received = undefined;
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requests.push(
            body.deliveryId ?? req.headers['x-novagate-delivery-id'],
          );
          if (mode === 'stall') {
            res.writeHead(200);
            res.write('pending');
            received?.();
          } else if (mode === 'retry') {
            res.writeHead(503);
            res.end('secret-upstream-response');
          } else if (mode === 'permanent') {
            res.writeHead(400);
            res.end('secret-upstream-response');
          } else {
            res.writeHead(202);
            res.end('ok');
          }
        });
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const config = new ConfigService({
        ALERT_CHANNEL_KEYS: JSON.stringify({
          fixture: Buffer.alloc(32, 7).toString('base64'),
        }),
        ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
        ALERT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
        SMTP_API_KEY: 'fixture-only-mail-key',
        SMTP_API_BASE_URL: origin,
        SMTP_FROM: 'support@novagate.dev',
      });
      rules = new AlertRulesService(ds, config);
      transport = new AlertTransportService(config);
      worker = new AlertDeliveryService(ds, rules, transport);
      replica = new AlertDeliveryService(ds, rules, transport);
      tenant = randomUUID();
      schema = tenantSchema(tenant);
      await ds.query(
        `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Alert fixture',$2,'free')`,
        [tenant, `${tenant}@example.test`],
      );
      await new TenantProvisioningService(ds).provisionTenant(tenant);
    });
    afterEach(async () => {
      await Promise.allSettled([
        worker?.onModuleDestroy(),
        replica?.onModuleDestroy(),
      ]);
      await transport?.onModuleDestroy();
      await rules?.onModuleDestroy();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
      if (tenant) {
        await ds.query('DELETE FROM public.api_keys WHERE "tenantId"=$1', [
          tenant,
        ]);
        await ds.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
        await ds.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
    afterAll(async () => {
      if (ds?.isInitialized) await ds.destroy();
      if (root?.isInitialized) {
        await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await root.destroy();
      }
    }, 30000);
    async function job(type: 'webhook' | 'slack' | 'email' = 'webhook') {
      const credentials =
        type === 'webhook'
          ? {
              type,
              url: `${origin}/private-fixture-path`,
              secret: 'fixture-only-signing-secret-at-least-32-bytes',
            }
          : type === 'slack'
            ? { type, webhookUrl: `${origin}/fixture-slack` }
            : { type, address: 'fixture@example.com' };
      const channel = await rules.createChannel(tenant, {
        name: 'Fixture channel',
        ...credentials,
      });
      const rule = await rules.createRule(tenant, {
        name: 'Fixture rule',
        metric: 'error_rate',
        operator: '>',
        threshold: 0.1,
        windowMinutes: 1,
        channelIds: [channel.id],
      });
      const [{ id: eventId }] = await ds.query(
        `INSERT INTO ${schema}.alert_events("ruleId","ruleName",metric,operator,threshold,"windowMinutes",state,value)
      VALUES($1,'Fixture rule','error_rate','>',0.1,1,'firing',0.5) RETURNING id`,
        [rule.id],
      );
      const [{ id }] = await ds.query(
        `INSERT INTO ${schema}.alert_deliveries("eventId","channelId","channelName",type,"channelRevision","nextAttemptAt")
      VALUES($1,$2,$3,$4,$5,NOW()) RETURNING id`,
        [eventId, channel.id, channel.name, type, channel.revision],
      );
      await ds.query(
        'INSERT INTO public.alert_delivery_schedule("tenantId","deliveryId") VALUES($1,$2)',
        [tenant, id],
      );
      return { id, channel, rule, eventId };
    }
    async function forceDue(id: string) {
      await ds.query(
        `UPDATE public.alert_delivery_schedule SET "dueAt"=NOW()-INTERVAL '1 second' WHERE "deliveryId"=$1`,
        [id],
      );
    }
    async function summary(id: string) {
      return (
        await ds.query(
          `SELECT status,attempts,"lastError","nextAttemptAt","completedAt" FROM ${schema}.alert_deliveries WHERE id=$1`,
          [id],
        )
      )[0];
    }
    async function schedule(id: string) {
      return (
        await ds.query(
          'SELECT * FROM public.alert_delivery_schedule WHERE "deliveryId"=$1',
          [id],
        )
      )[0];
    }

    it.each(['webhook', 'slack', 'email'] as const)(
      'delivers actual %s and removes due work with safe persisted history',
      async (type) => {
        const { id } = await job(type);
        const [lease] = await worker.claimDue();
        expect(lease.deliveryId).toBe(id);
        expect(await worker.deliverLease(lease)).toBe(true);
        expect(await summary(id)).toMatchObject({
          status: 'delivered',
          attempts: 1,
          lastError: null,
          nextAttemptAt: null,
        });
        expect((await summary(id)).completedAt).toBeInstanceOf(Date);
        expect(await schedule(id)).toBeUndefined();
        expect(requests).toEqual([id]);
        const history = await rules.history(tenant);
        expect(history[0].deliveries[0].status).toBe('delivered');
        expect(JSON.stringify(history)).not.toContain('fixture-only');
      },
    );
    it('claims once across replicas and fences duplicate processing of the same token', async () => {
      const { id } = await job();
      const claims = await Promise.all([worker.claimDue(), replica.claimDue()]);
      expect(claims.flat()).toHaveLength(1);
      const lease = claims.flat()[0];
      const outcomes = await Promise.all([
        worker.deliverLease(lease),
        replica.deliverLease(lease),
      ]);
      expect(outcomes.sort()).toEqual([false, true]);
      expect(requests).toEqual([id]);
      expect((await summary(id)).attempts).toBe(1);
    });
    it('retries transient failures with 5/20-second backoff and never exceeds three attempts', async () => {
      mode = 'retry';
      const { id } = await job();
      for (let attempt = 1; attempt <= 3; attempt++) {
        const [lease] = await worker.claimDue();
        expect(await worker.deliverLease(lease)).toBe(true);
        const row = await summary(id);
        expect(row.attempts).toBe(attempt);
        expect(row.lastError).not.toContain('secret');
        if (attempt < 3) {
          expect(row.status).toBe('queued');
          const queued = await schedule(id);
          expect(queued.leaseToken).toBeNull();
          expect(queued.leaseStarted).toBe(false);
          expect(queued.dueAt.getTime() - Date.now()).toBeGreaterThan(
            attempt === 1 ? 4000 : 19000,
          );
          await forceDue(id);
        } else {
          expect(row.status).toBe('failed');
          expect(await schedule(id)).toBeUndefined();
        }
      }
      expect(requests).toEqual([id, id, id]);
      expect(await worker.claimDue()).toEqual([]);
    });
    it('recovers on the second request with the same deduplication ID', async () => {
      mode = 'retry';
      const { id } = await job();
      await worker.deliverLease((await worker.claimDue())[0]);
      mode = 'ok';
      await forceDue(id);
      await replica.deliverLease((await replica.claimDue())[0]);
      expect(await summary(id)).toMatchObject({
        status: 'delivered',
        attempts: 2,
        lastError: null,
      });
      expect(requests).toEqual([id, id]);
    });
    it('does not retry a permanent destination rejection', async () => {
      mode = 'permanent';
      const { id } = await job();
      await worker.deliverLease((await worker.claimDue())[0]);
      expect(await summary(id)).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
      expect(await schedule(id)).toBeUndefined();
    });
    it('does not deliver expired history before the next idle retention sweep', async () => {
      const { id, eventId } = await job();
      await ds.query(
        `UPDATE ${schema}.alert_events SET "createdAt"=NOW()-INTERVAL '31 days' WHERE id=$1`,
        [eventId],
      );
      expect(await worker.deliverLease((await worker.claimDue())[0])).toBe(
        false,
      );
      expect(await summary(id)).toMatchObject({
        status: 'cancelled',
        attempts: 0,
      });
      expect(requests).toEqual([]);
      expect(await schedule(id)).toBeUndefined();
    });
    it('rejects a stale lease before network work and accepts its fresh replacement', async () => {
      const { id } = await job();
      const [stale] = await worker.claimDue();
      await ds.query(
        'UPDATE public.alert_delivery_schedule SET "leaseUntil"=NOW()-INTERVAL \'1 second\' WHERE "deliveryId"=$1',
        [id],
      );
      const [fresh] = await replica.claimDue();
      expect(fresh.leaseToken).not.toBe(stale.leaseToken);
      expect(await worker.deliverLease(stale)).toBe(false);
      expect(requests).toEqual([]);
      expect(await replica.deliverLease(fresh)).toBe(true);
      expect(requests).toEqual([id]);
    });
    it('recovers processing work after a crash without resetting the attempt count', async () => {
      const { id } = await job();
      await worker.claimDue();
      await ds.query(
        `UPDATE ${schema}.alert_deliveries SET status='processing',attempts=1 WHERE id=$1`,
        [id],
      );
      await ds.query(
        'UPDATE public.alert_delivery_schedule SET "leaseStarted"=true,"leaseUntil"=NOW()-INTERVAL \'1 second\' WHERE "deliveryId"=$1',
        [id],
      );
      const [lease] = await replica.claimDue();
      expect(await replica.deliverLease(lease)).toBe(true);
      expect(await summary(id)).toMatchObject({
        status: 'delivered',
        attempts: 2,
      });
      expect(requests).toEqual([id]);
    });
    it('terminates a crash-recovered third attempt without sending a fourth request', async () => {
      const { id } = await job();
      await ds.query(
        `UPDATE ${schema}.alert_deliveries SET status='processing',attempts=3 WHERE id=$1`,
        [id],
      );
      expect(await worker.deliverLease((await worker.claimDue())[0])).toBe(
        false,
      );
      expect(await summary(id)).toMatchObject({
        status: 'failed',
        attempts: 3,
      });
      expect(requests).toEqual([]);
      expect(await schedule(id)).toBeUndefined();
    });
    it('refuses tampered stored credentials without persisting decryption details', async () => {
      const { id, channel } = await job();
      await ds.query(
        `UPDATE ${schema}.alert_channels SET credentials='{}' WHERE id=$1`,
        [channel.id],
      );
      expect(await worker.deliverLease((await worker.claimDue())[0])).toBe(
        false,
      );
      expect(await summary(id)).toMatchObject({
        status: 'failed',
        attempts: 0,
        lastError: 'Alert channel credentials are unavailable.',
      });
      expect(requests).toEqual([]);
    });
    it('bounds saturated pool admission and leaves the lease recoverable without a send', async () => {
      const { id } = await job();
      const [lease] = await worker.claimDue();
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      url.pathname = `/${database}`;
      const limited = new DataSource({
        type: 'postgres',
        url: url.toString(),
        extra: { max: 1, connectionTimeoutMillis: 100 },
      });
      await limited.initialize();
      const occupied = limited.createQueryRunner();
      await occupied.connect();
      const limitedRules = new AlertRulesService(
        limited,
        new ConfigService({
          ALERT_CHANNEL_KEYS: JSON.stringify({
            fixture: Buffer.alloc(32, 7).toString('base64'),
          }),
          ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
          ALERT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
        }),
      );
      const limitedWorker = new AlertDeliveryService(
        limited,
        limitedRules,
        transport,
      );
      try {
        const start = performance.now();
        await expect(limitedWorker.deliverLease(lease)).rejects.toThrow(
          'timeout',
        );
        expect(performance.now() - start).toBeLessThan(2000);
        expect(requests).toEqual([]);
        expect(await summary(id)).toMatchObject({
          status: 'queued',
          attempts: 0,
        });
        expect((await schedule(id)).leaseToken).toBe(lease.leaseToken);
      } finally {
        await occupied.release();
        await limitedWorker.onModuleDestroy();
        await limitedRules.onModuleDestroy();
        await limited.destroy();
      }
    });
    it('cancels a live socket on channel revision change and cannot overwrite cancelled history', async () => {
      mode = 'stall';
      const { id, channel } = await job();
      const [lease] = await worker.claimDue();
      const ready = new Promise<void>((done) => {
        received = done;
      });
      const work = worker.deliverLease(lease);
      await ready;
      const start = performance.now();
      await rules.updateChannel(tenant, channel.id, {
        name: 'Paused fixture',
        enabled: false,
        revision: channel.revision,
      });
      expect(await work).toBe(false);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(await summary(id)).toMatchObject({
        status: 'cancelled',
        attempts: 1,
      });
      expect(await schedule(id)).toBeUndefined();
    });
    it('cancels a live delivery after a rule edit', async () => {
      mode = 'stall';
      const { id, rule } = await job();
      const ready = new Promise<void>((done) => {
        received = done;
      });
      const work = worker.deliverLease((await worker.claimDue())[0]);
      await ready;
      await rules.updateRule(tenant, rule.id, {
        enabled: false,
        revision: rule.revision,
        name: rule.name,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        windowMinutes: rule.windowMinutes,
        minRequests: rule.minRequests,
        channelIds: rule.channelIds,
      });
      expect(await work).toBe(false);
      expect(await summary(id)).toMatchObject({ status: 'cancelled' });
    });
    it('cancels on lease expiry, fences completion and recovers on another replica', async () => {
      mode = 'stall';
      const { id } = await job();
      const ready = new Promise<void>((done) => {
        received = done;
      });
      const old = worker.deliverLease((await worker.claimDue())[0]);
      await ready;
      await ds.query(
        'UPDATE public.alert_delivery_schedule SET "leaseUntil"=NOW()-INTERVAL \'1 second\' WHERE "deliveryId"=$1',
        [id],
      );
      expect(await old).toBe(false);
      expect((await summary(id)).status).toBe('processing');
      mode = 'ok';
      expect(await replica.deliverLease((await replica.claimDue())[0])).toBe(
        true,
      );
      expect(await summary(id)).toMatchObject({
        status: 'delivered',
        attempts: 2,
      });
      expect(requests).toEqual([id, id]);
    });
    it('shutdown drains actual network work and preserves a finite recoverable retry', async () => {
      mode = 'stall';
      const { id } = await job();
      const ready = new Promise<void>((done) => {
        received = done;
      });
      const work = worker.deliverLease((await worker.claimDue())[0]);
      await ready;
      await worker.onModuleDestroy();
      expect(await work).toBe(true);
      expect(await summary(id)).toMatchObject({
        status: 'queued',
        attempts: 1,
      });
      expect((await schedule(id)).leaseToken).toBeNull();
      mode = 'ok';
      await forceDue(id);
      expect(await replica.deliverLease((await replica.claimDue())[0])).toBe(
        true,
      );
      expect((await summary(id)).status).toBe('delivered');
    });
    it('rolls back event completion if queue removal fails, then recovers the same ID', async () => {
      const { id } = await job();
      const [lease] = await worker.claimDue();
      await ds.query(
        `CREATE FUNCTION public.fail_delivery_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture-failure'; END; $$ LANGUAGE plpgsql`,
      );
      await ds.query(
        `CREATE TRIGGER fixture_fail_delivery_delete BEFORE DELETE ON public.alert_delivery_schedule FOR EACH ROW EXECUTE FUNCTION public.fail_delivery_delete()`,
      );
      try {
        await expect(worker.deliverLease(lease)).rejects.toThrow(
          'fixture-failure',
        );
        expect(await summary(id)).toMatchObject({
          status: 'processing',
          attempts: 1,
        });
        expect((await schedule(id)).leaseToken).toBe(lease.leaseToken);
      } finally {
        await ds.query(
          'DROP TRIGGER fixture_fail_delivery_delete ON public.alert_delivery_schedule',
        );
        await ds.query('DROP FUNCTION public.fail_delivery_delete()');
      }
      await ds.query(
        'UPDATE public.alert_delivery_schedule SET "leaseUntil"=NOW()-INTERVAL \'1 second\' WHERE "deliveryId"=$1',
        [id],
      );
      expect(await replica.deliverLease((await replica.claimDue())[0])).toBe(
        true,
      );
      expect(requests).toEqual([id, id]);
    });
    it('evaluates actual intervals, creates durable work and delivers through the timer batch path', async () => {
      const channel = await rules.createChannel(tenant, {
        name: 'Real pipeline',
        type: 'webhook',
        url: origin,
        secret: 'fixture-only-signing-secret-at-least-32-bytes',
      });
      await rules.createRule(tenant, {
        name: 'Measured errors',
        metric: 'error_rate',
        operator: '>',
        threshold: 0.1,
        windowMinutes: 1,
        minRequests: 1,
        channelIds: [channel.id],
      });
      const [{ now }] = await ds.query('SELECT clock_timestamp() AS now');
      for (let i = 0; i < 12; i++) {
        const histogram = METRIC_LATENCY_BUCKETS.map(() => 0);
        histogram[3] = 10;
        const window = {
          windowMs: 5000,
          requestCount: 10,
          errorCount: 5,
          timeoutCount: 0,
          latencyCounts: histogram,
        };
        await ds.query(
          `INSERT INTO ${schema}.metrics_snapshots(rps,"p50Ms","p95Ms","p99Ms","errorRate",timestamp,"aggregateWindow") VALUES(2,5,5,5,0.5,$1,$2)`,
          [new Date(now.getTime() - i * 5000), JSON.stringify(window)],
        );
      }
      const evaluator = new AlertEvaluatorService(ds, rules);
      try {
        await evaluator.tick();
        await worker.tick();
        const history = await rules.history(tenant);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ state: 'firing', value: 0.5 });
        expect(history[0].deliveries[0]).toMatchObject({
          status: 'delivered',
          attempts: 1,
        });
        expect(requests).toHaveLength(1);
      } finally {
        await evaluator.onModuleDestroy();
      }
    });
  },
);

describe('delivery scheduler lifecycle', () => {
  it('does not overlap timer ticks and awaits the actual batch on shutdown', async () => {
    jest.useFakeTimers();
    let release!: (leases: []) => void;
    const query = jest.fn().mockReturnValue(
      new Promise<[]>((done) => {
        release = done;
      }),
    );
    const manager = {
      query: jest
        .fn()
        .mockImplementation((sql: string) =>
          sql.startsWith('WITH') ? query() : Promise.resolve([]),
        ),
    };
    const ds = {
      transaction: jest
        .fn()
        .mockImplementation((fn: (manager: unknown) => unknown) => fn(manager)),
    } as unknown as DataSource;
    const rules = {
      credentialCipher: { enabled: true },
    } as unknown as AlertRulesService;
    const transport = {} as AlertTransportService;
    const worker = new AlertDeliveryService(ds, rules, transport);
    try {
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(3000);
      expect(query).toHaveBeenCalledTimes(1);
      let stopped = false;
      const shutdown = worker.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release([]);
      await shutdown;
      await jest.advanceTimersByTimeAsync(3000);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      await worker.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});
