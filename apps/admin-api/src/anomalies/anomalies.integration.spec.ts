import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import type { Anomaly, AnomalySettings } from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { AlertRulesService } from '../alerts/alert-rules.service';
import { AnomaliesController } from './anomalies.controller';
import { AnomaliesService } from './anomalies.service';
import {
  AnomalyDetectorService,
  anomalyIntervalMs,
} from './anomaly-detector.service';
import { windowStart } from './anomaly-scoring';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Anomaly detection on actual PostgreSQL', () => {
  const secret = 'anomaly-fixture-secret-longer-than-32-characters';
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const database = `novagate_anomaly_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let detector: AnomalyDetectorService;
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
      extra: { max: 16, connectionTimeoutMillis: 3000 },
    });
    await db.initialize();
    await db.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    await new MigrationService(db).onModuleInit();
    const config = new ConfigService({});
    // The detector is driven directly; its background timer never starts.
    detector = new AnomalyDetectorService(db, config);
    const module = await Test.createTestingModule({
      controllers: [AnomaliesController],
      providers: [
        AnomaliesService,
        AlertRulesService,
        { provide: ConfigService, useValue: config },
        { provide: DataSource, useValue: db },
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

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) {
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      for (const statement of [
        'DELETE FROM public.alert_delivery_schedule WHERE "tenantId"=$1',
        'DELETE FROM public.api_keys WHERE "tenantId"=$1',
        'DELETE FROM public.tenants WHERE id=$1',
      ])
        await db.query(statement, [tenant]);
    }
  });

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
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Anomaly fixture',$2,'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    const schema = tenantSchema(tenant);
    const [service] = await db.query(
      `INSERT INTO ${schema}.services (name, targets) VALUES ('orders', '[]') RETURNING id`,
    );
    await db.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId") VALUES ('GET', '/orders', $1)`,
      [service.id],
    );
    return { tenant, schema };
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  async function call<T>(
    tenant: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    const response = await fetch(`${base}/tenants/${tenant}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: session(tenant),
        ...(init.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  /** Writes request logs with explicit receipt times. */
  async function logs(
    schema: string,
    at: (index: number) => Date,
    count: number,
    shape: (index: number) => { status?: number; ms: number; path?: string },
  ) {
    const rows = Array.from({ length: count }, (_, index) => {
      const { status = 200, ms, path = '/orders' } = shape(index);
      return [randomUUID(), 'GET', path, status, ms, randomUUID(), at(index)];
    });
    await db.query(
      `INSERT INTO ${schema}.request_logs (id, method, path, "statusCode", "responseTimeMs", "requestId", timestamp, "receivedAt")
        SELECT x.id, x.method, x.path, x.status, x.ms, x."requestId", x.at, x.at
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, method text, path text, status int, ms int, "requestId" text, at timestamptz)`,
      [
        JSON.stringify(
          rows.map(([id, method, path, status, ms, requestId, at]) => ({
            id,
            method,
            path,
            status,
            ms,
            requestId,
            at,
          })),
        ),
      ],
    );
  }
  /** Eight completed windows of normal traffic: 120 requests at 15-25 ms. */
  async function baseline(schema: string, path = '/orders') {
    const [{ now }] = await db.query(`SELECT clock_timestamp() AS now`);
    const first = new Date(windowStart(new Date(now)).getTime() - 9 * 900000);
    for (let window = 0; window < 8; window++)
      await logs(
        schema,
        (i) => new Date(first.getTime() + window * 900000 + i * 7000),
        120,
        (i) => ({
          ms: 15 + ((i * 7 + window) % 11),
          status: i === 0 && window % 3 === 0 ? 500 : 200,
          path,
        }),
      );
    // Start materializing at the seeded windows rather than 24 hours back.
    await db.query(`UPDATE ${schema}.anomaly_settings SET next_window = $1`, [
      first,
    ]);
    return new Date(now);
  }
  async function evaluate(tenant: string) {
    await db.query(
      `UPDATE public.anomaly_schedule SET "dueAt" = NOW() - INTERVAL '1 second', "leaseToken" = NULL, "leaseUntil" = NULL WHERE "tenantId" = $1`,
      [tenant],
    );
    const leases = (await detector.claimDue()).filter(
      (lease) => lease.tenantId === tenant,
    );
    expect(leases).toHaveLength(1);
    expect(await detector.evaluate(leases[0])).toBe(true);
  }
  const recent = (schema: string, count: number, ms: number, status = 200) =>
    logs(
      schema,
      (i) => new Date(Date.now() - 60000 + i * 100),
      count,
      () => ({ ms, status }),
    );

  it('materializes completed windows from received logs and stays quiet for normal traffic', async () => {
    const { tenant, schema } = await workspace();
    await baseline(schema);
    await recent(schema, 40, 20);
    await evaluate(tenant);
    const windows = await db.query(
      `SELECT requests, server_errors, p95_ms FROM ${schema}.route_traffic_windows ORDER BY window_start`,
    );
    expect(windows).toHaveLength(8);
    expect(
      windows.every((w: { requests: string }) => Number(w.requests) === 120),
    ).toBe(true);
    expect(
      windows.map((w: { server_errors: string }) => Number(w.server_errors)),
    ).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
    expect(windows[0].p95_ms).toBeGreaterThan(20);
    expect((await call<Anomaly[]>(tenant, '/anomalies')).body).toEqual([]);
    expect(await db.query(`SELECT * FROM ${schema}.alert_events`)).toEqual([]);
    // Each window is materialized once.
    await evaluate(tenant);
    expect(
      await db.query(`SELECT 1 FROM ${schema}.route_traffic_windows`),
    ).toHaveLength(8);
  });

  it('opens an anomaly with an alert event and deliveries, then resolves it', async () => {
    const { tenant, schema } = await workspace();
    const [channel] = await db.query(
      `INSERT INTO ${schema}.alert_channels (name, type, destination, credentials)
        VALUES ('On-call', 'webhook', 'https://hooks.example.test', '{}') RETURNING id`,
    );
    const settings = (await call<AnomalySettings>(tenant, '/anomaly-settings'))
      .body;
    expect(settings).toEqual({
      enabled: true,
      zThreshold: 3,
      minRequests: 20,
      channelIds: [],
      revision: 1,
    });
    const saved = await call<AnomalySettings>(tenant, '/anomaly-settings', {
      method: 'PUT',
      body: {
        enabled: true,
        zThreshold: 4,
        minRequests: 20,
        channelIds: [channel.id],
        expectedRevision: 1,
      },
    });
    expect(saved.body).toMatchObject({
      zThreshold: 4,
      channelIds: [channel.id],
      revision: 2,
    });
    await baseline(schema);
    // A latency spike at normal volume.
    await recent(schema, 40, 380);
    await evaluate(tenant);
    const [anomaly] = (await call<Anomaly[]>(tenant, '/anomalies?state=active'))
      .body;
    expect(anomaly).toMatchObject({
      method: 'GET',
      path: '/orders',
      metric: 'p95_latency_ms',
      direction: 'up',
      state: 'active',
      current: 380,
      requests: 40,
      resolvedAt: null,
    });
    expect(anomaly.baseline.windows).toBe(8);
    expect(anomaly.baseline.mean).toBeGreaterThan(20);
    expect(anomaly.zScore).toBeGreaterThan(4);
    expect(anomaly.summary).toMatch(
      /^Unusual \d+% rise in p95 latency on GET \/orders: baseline \d+ ms, current 380 ms$/,
    );
    const [event] = await db.query(`SELECT * FROM ${schema}.alert_events`);
    expect(event).toMatchObject({
      ruleId: null,
      ruleName: 'Anomaly: p95_latency_ms GET /orders',
      metric: 'p95_latency_ms',
      operator: '>',
      state: 'firing',
      value: 380,
      windowMinutes: 5,
      anomalyId: anomaly.id,
    });
    expect(event.anomaly).toMatchObject({
      id: anomaly.id,
      summary: anomaly.summary,
      direction: 'up',
    });
    const deliveries = await db.query(
      `SELECT d."channelId", d.status, q."tenantId" FROM ${schema}.alert_deliveries d
        JOIN public.alert_delivery_schedule q ON q."deliveryId" = d.id`,
    );
    expect(deliveries).toEqual([
      { channelId: channel.id, status: 'queued', tenantId: tenant },
    ]);
    // Still anomalous: updated in place, no second event.
    await evaluate(tenant);
    expect(await db.query(`SELECT 1 FROM ${schema}.alert_events`)).toHaveLength(
      1,
    );
    // Recovery: the slow requests age out of the 5-minute window.
    await db.query(
      `DELETE FROM ${schema}.request_logs WHERE "responseTimeMs" = 380`,
    );
    await recent(schema, 40, 20);
    for (let tick = 0; tick < 2; tick++) {
      await evaluate(tenant);
      expect(
        (await call<Anomaly[]>(tenant, '/anomalies?state=active')).body,
      ).toHaveLength(1);
    }
    await evaluate(tenant);
    expect(
      (await call<Anomaly[]>(tenant, '/anomalies?state=active')).body,
    ).toEqual([]);
    const [resolved] = (await call<Anomaly[]>(tenant, '/anomalies')).body;
    expect(resolved).toMatchObject({ id: anomaly.id, state: 'resolved' });
    expect(resolved.resolvedAt).not.toBeNull();
    const events = await db.query(
      `SELECT state, "anomalyId" FROM ${schema}.alert_events ORDER BY "createdAt"`,
    );
    expect(events).toEqual([
      { state: 'firing', anomalyId: anomaly.id },
      { state: 'resolved', anomalyId: anomaly.id },
    ]);
    expect(
      await db.query(`SELECT 1 FROM ${schema}.alert_deliveries`),
    ).toHaveLength(2);
  });

  it('detects error spikes and traffic drops on configured routes only', async () => {
    const { tenant, schema } = await workspace();
    await baseline(schema);
    await baseline(schema, '/legacy');
    await recent(schema, 40, 20, 500);
    await evaluate(tenant);
    const found = (await call<Anomaly[]>(tenant, '/anomalies')).body
      .map((a) => [a.path, a.metric, a.direction])
      .sort();
    // /legacy has no route any more: its silence is not reported.
    expect(found).toEqual([['/orders', 'error_rate', 'up']]);
  });

  it('honours disabled detection, sensitivity and missing baselines', async () => {
    const { tenant, schema } = await workspace();
    await recent(schema, 40, 900);
    await evaluate(tenant);
    expect((await call<Anomaly[]>(tenant, '/anomalies')).body).toEqual([]);
    await baseline(schema);
    expect(
      (
        await call(tenant, '/anomaly-settings', {
          method: 'PUT',
          body: {
            enabled: false,
            zThreshold: 3,
            minRequests: 20,
            channelIds: [],
            expectedRevision: 1,
          },
        })
      ).status,
    ).toBe(200);
    await evaluate(tenant);
    expect((await call<Anomaly[]>(tenant, '/anomalies')).body).toEqual([]);
    expect(
      await db.query(`SELECT 1 FROM ${schema}.route_traffic_windows`),
    ).toEqual([]);
  });

  it('validates settings and keeps channels within the workspace', async () => {
    const { tenant } = await workspace();
    const other = await workspace();
    const [foreign] = await db.query(
      `INSERT INTO ${other.schema}.alert_channels (name, type, destination, credentials)
        VALUES ('Other', 'webhook', 'https://hooks.example.test', '{}') RETURNING id`,
    );
    const save = (body: Record<string, unknown>) =>
      call<{ message: string }>(tenant, '/anomaly-settings', {
        method: 'PUT',
        body: {
          enabled: true,
          zThreshold: 3,
          minRequests: 20,
          channelIds: [],
          expectedRevision: 1,
          ...body,
        },
      });
    for (const invalid of [
      { zThreshold: 1 },
      { zThreshold: 3.25 },
      { minRequests: 4 },
      { channelIds: ['not-a-uuid'] },
      { channelIds: [foreign.id] },
      { enabled: 'yes' },
      { extra: true },
    ])
      expect((await save(invalid)).status).toBe(400);
    expect((await save({ expectedRevision: 7 })).status).toBe(409);
    expect((await call(tenant, '/anomalies?state=open')).status).toBe(400);
    expect(
      (await call(other.tenant, `/../${tenant}/anomalies`)).status,
    ).not.toBe(200);
  });

  it('validates the evaluation interval setting', () => {
    expect(anomalyIntervalMs(undefined)).toBe(60000);
    expect(anomalyIntervalMs('5000')).toBe(5000);
    for (const invalid of ['999', '3600001', 'often', '1.5'])
      expect(() => anomalyIntervalMs(invalid)).toThrow(
        'ANOMALY_EVALUATION_INTERVAL_MS',
      );
  });
});
