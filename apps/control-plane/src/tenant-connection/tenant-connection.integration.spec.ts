import { ConfigService } from '@nestjs/config';
import { TraceIngestionService } from '../ingestion/trace-ingestion.service';
import {
  GatewayCloseCode,
  METRIC_LATENCY_BUCKETS,
  type TraceSpan,
} from '@api-gateway/shared-types';
import { randomUUID, createHash } from 'crypto';
import { once } from 'events';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import {
  Tenant,
  ApiKey,
  PendingConfigUpdate,
} from '../database/entities/public.entities';
import { LogIngestionService } from '../ingestion/log-ingestion.service';
import { TenantConnectionManager } from './tenant-connection.manager';
import type {
  AuthOkMessage,
  ConfigUpdateMessage,
} from '@api-gateway/shared-types';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;

integration('Control plane with real PostgreSQL, Redis and WebSockets', () => {
  let ds: DataSource;
  let manager: TenantConnectionManager;
  let redis: Redis;
  let url: string;
  let tenantId: string;
  let secondId: string;
  let apiKey: string;
  let traceIngestion: TraceIngestionService;
  const sockets: WebSocket[] = [];
  const previousRedis = process.env.REDIS_URL;
  const previousPort = process.env.WS_PORT;

  async function connect(key: string) {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await once(ws, 'open');
    const message = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'auth', payload: { apiKey: key } }));
    const [data] = await message;
    return { ws, message: JSON.parse(data.toString()) as AuthOkMessage };
  }

  it('expires idle-tenant traces without a new gateway batch and preserves recent data', async () => {
    const schema = `tenant_${secondId.replace(/-/g, '_')}`;
    await ds.query(`INSERT INTO ${schema}.trace_spans ("traceId", "spanId", name, kind, timestamp, "durationMs", status, attributes)
      VALUES ('3123456789abcdef0123456789abcdef', '0123456789abcdef', 'old', 'server', NOW() - INTERVAL '8 days', 1.25, 'ok', '{}'),
      ('4123456789abcdef0123456789abcdef', '0123456789abcdef', 'recent', 'server', NOW(), 1.25, 'ok', '{}')`);
    await traceIngestion.cleanupExpired();
    expect(
      await ds.query(
        `SELECT "traceId" FROM ${schema}.trace_spans WHERE "traceId" IN ('3123456789abcdef0123456789abcdef', '4123456789abcdef0123456789abcdef') ORDER BY "traceId"`,
      ),
    ).toEqual([{ traceId: '4123456789abcdef0123456789abcdef' }]);
    await ds.query(
      `DELETE FROM ${schema}.trace_spans WHERE "traceId" = '4123456789abcdef0123456789abcdef'`,
    );
  });

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      entities: [Tenant, ApiKey, PendingConfigUpdate],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    await ds.query(
      'ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS "caCertPem" TEXT',
    );
    await ds.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS pending_config_updates_tenant_unique ON public.pending_config_updates ("tenantId")',
    );
    tenantId = randomUUID();
    secondId = randomUUID();
    apiKey = randomUUID();
    for (const id of [tenantId, secondId]) {
      await ds.getRepository(Tenant).save({
        id,
        name: 'Test tenant',
        email: `${id}@example.test`,
        planId: 'free',
        gatewayConfigVersion: 8,
      });
      const schema = `tenant_${id.replace(/-/g, '_')}`;
      await ds.query(`CREATE SCHEMA ${schema}`);
      await ds.query(
        `CREATE TABLE ${schema}.routes (id UUID, enabled BOOLEAN, "deletedAt" TIMESTAMP)`,
      );
      await ds.query(
        `CREATE TABLE ${schema}.services (id UUID, name TEXT, "healthCheckIntervalMs" INTEGER DEFAULT 1500, "unhealthyFallback" BOOLEAN DEFAULT true, "healthCheckProtocol" TEXT DEFAULT 'grpc', "healthCheckService" TEXT DEFAULT 'test.Echo', "deletedAt" TIMESTAMP)`,
      );
      await ds.query(
        `CREATE TABLE ${schema}.consumers (id UUID, "revokedAt" TIMESTAMP)`,
      );
      await ds.query(
        `CREATE TABLE ${schema}.metrics_snapshots (rps FLOAT, "p50Ms" INTEGER, "p95Ms" INTEGER, "p99Ms" INTEGER, "errorRate" FLOAT, timestamp TIMESTAMPTZ, "aggregateWindow" JSONB)`,
      );
      await ds.query(`CREATE TABLE ${schema}.trace_spans (
        "traceId" VARCHAR(32), "spanId" VARCHAR(16), "parentSpanId" VARCHAR(16), name VARCHAR(128), kind VARCHAR,
        timestamp TIMESTAMPTZ, "durationMs" DOUBLE PRECISION, status VARCHAR, attributes JSONB,
        PRIMARY KEY ("traceId", "spanId"))`);
      await ds.query(
        `CREATE INDEX trace_time_cursor ON ${schema}.trace_spans (timestamp DESC, "traceId", "spanId")`,
      );
      await ds.query(`CREATE TABLE ${schema}.request_logs (
        id UUID PRIMARY KEY, "consumerId" UUID, method VARCHAR, path VARCHAR, "statusCode" INTEGER,
        "responseTimeMs" INTEGER, "requestId" VARCHAR, "downstreamService" VARCHAR, "downstreamLatencyMs" INTEGER,
        "clientIp" VARCHAR, "userAgent" VARCHAR, "errorCode" VARCHAR, timestamp TIMESTAMP
        ${id === tenantId ? ', "traceId" VARCHAR(32), "spanId" VARCHAR(16), "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()' : ''})`);
      await ds.query(
        `CREATE TABLE ${schema}.error_events (id UUID PRIMARY KEY, "requestId" TEXT, "errorCode" TEXT, message TEXT, "serviceId" UUID, path TEXT, "statusCode" INTEGER, timestamp TIMESTAMP)`,
      );
    }
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
    await ds.query(
      `INSERT INTO ${schema}.services (id, name) VALUES ($1, 'persisted-service')`,
      [randomUUID()],
    );
    await ds.getRepository(ApiKey).save({
      tenantId,
      keyHash: createHash('sha256').update(apiKey).digest('hex'),
      label: 'test',
    });
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    process.env.WS_PORT = '0';
    redis = new Redis(process.env.TEST_REDIS_URL as string);
    traceIngestion = new TraceIngestionService(
      ds,
      new ConfigService({ traceIngestion: { maxRowsPerTenant: 128 } }),
    );
    manager = new TenantConnectionManager(
      ds.getRepository(Tenant),
      ds.getRepository(ApiKey),
      ds.getRepository(PendingConfigUpdate),
      new LogIngestionService(ds),
      ds,
      traceIngestion,
      new ConfigService({ socketAdmission: { maxQueuedMessages: 2 } }),
    );
    manager.onModuleInit();
    const wss = (manager as unknown as { wss: WebSocketServer }).wss;
    if (!wss.address()) await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP socket');
    url = `ws://127.0.0.1:${address.port}`;
    // Wait until the Redis subscriber is subscribed before publishing test updates.
    for (let i = 0; i < 100; i++) {
      const result = (await redis.pubsub('NUMSUB', 'config.update')) as [
        string,
        number,
      ];
      if (Number(result[1]) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, 30000);

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await manager?.onModuleDestroy();
    redis?.disconnect();
    if (ds?.isInitialized) {
      for (const id of [tenantId, secondId]) {
        await ds.query(
          `DROP SCHEMA IF EXISTS tenant_${id.replace(/-/g, '_')} CASCADE`,
        );
        await ds.query(
          'DELETE FROM public.pending_config_updates WHERE "tenantId" = $1',
          [id],
        );
        await ds.query('DELETE FROM public.api_keys WHERE "tenantId" = $1', [
          id,
        ]);
        await ds.query('DELETE FROM public.tenants WHERE id = $1', [id]);
      }
      await ds.destroy();
    }
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
    if (previousPort === undefined) delete process.env.WS_PORT;
    else process.env.WS_PORT = previousPort;
  });

  it('stores legacy principal batches on modern and legacy schemas without UUID conversion loss', async () => {
    const ingestion = new LogIngestionService(ds);
    const consumer = randomUUID();
    const logs = [
      'external-user-fixture',
      consumer.toUpperCase(),
      '',
      undefined,
    ].map((subject) => ({
      id: randomUUID(),
      consumerId: subject,
      method: 'GET',
      path: '/legacy-consumer-fixture',
      statusCode: 200,
      responseTimeMs: 5,
      requestId: randomUUID(),
      clientIp: '127.0.0.1',
      timestamp: new Date().toISOString(),
    }));
    for (const tenant of [tenantId, secondId]) {
      await expect(ingestion.ingestLogs(tenant, logs)).resolves.toBeUndefined();
      const stored = await ds.query(
        `SELECT id,"consumerId" FROM tenant_${tenant.replace(/-/g, '_')}.request_logs WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [logs.map((log) => log.id)],
      );
      expect(stored).toHaveLength(4);
      expect(
        stored.find((row: { id: string }) => row.id === logs[1].id).consumerId,
      ).toBe(consumer);
      expect(
        stored.filter(
          (row: { consumerId: string | null }) => row.consumerId === null,
        ),
      ).toHaveLength(3);
      await ds.query(
        `DELETE FROM tenant_${tenant.replace(/-/g, '_')}.request_logs WHERE id=ANY($1::uuid[])`,
        [logs.map((log) => log.id)],
      );
    }
    await ingestion.onModuleDestroy();
  });
  it('loads persisted services and the database version at authentication', async () => {
    const { message } = await connect(apiKey);
    expect(message.payload.config.services[0]).toMatchObject({
      name: 'persisted-service',
      healthCheckIntervalMs: 1500,
      healthCheckProtocol: 'grpc',
      healthCheckService: 'test.Echo',
      unhealthyFallback: true,
    });
    expect(message.payload.configVersion).toBe(8);
    expect(message.payload.tenantId).toBe(tenantId);
  });

  it('keeps concurrent tenant metrics separate on pooled connections', async () => {
    const ingestion = new LogIngestionService(ds);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ingestion.ingestMetrics(i % 2 ? tenantId : secondId, {
          rps: i % 2 ? 11 : 22,
          p50: 1,
          p95: 2,
          p99: 3,
          errorRate: 0,
        }),
      ),
    );
    for (const [id, rps] of [
      [tenantId, 11],
      [secondId, 22],
    ] as const) {
      const rows = await ds.query(
        `SELECT rps FROM tenant_${id.replace(/-/g, '_')}.metrics_snapshots`,
      );
      expect(rows).toHaveLength(10);
      expect(rows.every((row: { rps: number }) => row.rps === rps)).toBe(true);
    }
  });

  it('publishes canonical metrics only on the authenticated tenant channel after persistence', async () => {
    const subscriber = new Redis(process.env.TEST_REDIS_URL as string);
    await subscriber.subscribe(`metrics:${tenantId}`, `metrics:${secondId}`);
    const seen: Array<{ channel: string; payload: Record<string, unknown> }> =
      [];
    subscriber.on('message', (channel, bytes) =>
      seen.push({ channel, payload: JSON.parse(bytes) }),
    );
    try {
      const { ws } = await connect(apiKey);
      ws.send(
        JSON.stringify({
          type: 'metrics',
          tenantId: secondId,
          payload: { rps: 3.125, p50: 1, p95: 2, p99: 3, errorRate: 0.5 },
        }),
      );
      await until(async () => seen.length === 1);
      expect(seen[0].channel).toBe(`metrics:${tenantId}`);
      expect(seen[0].payload).toMatchObject({
        rps: 3.125,
        p50Ms: 1,
        p95Ms: 2,
        p99Ms: 3,
        errorRate: 0.5,
      });
      expect(
        (
          await ds.query(
            `SELECT rps FROM tenant_${tenantId.replace(/-/g, '_')}.metrics_snapshots ORDER BY timestamp DESC LIMIT 1`,
          )
        )[0].rps,
      ).toBe(3.125);
      ws.send(
        JSON.stringify({
          type: 'metrics',
          payload: { rps: -1, p50: 1, p95: 2, p99: 3, errorRate: 0 },
        }),
      );
      // A valid marker after the malformed message proves serialized validation completed.
      ws.send(
        JSON.stringify({
          type: 'metrics',
          payload: { rps: 4.25, p50: 1, p95: 2, p99: 3, errorRate: 0 },
        }),
      );
      await until(async () => seen.length === 2);
      expect(seen[1].payload.rps).toBe(4.25);
    } finally {
      subscriber.disconnect();
    }
  });
  it('persists validated histogram evidence on the authenticated tenant and preserves legacy null metadata', async () => {
    const subscriber = new Redis(process.env.TEST_REDIS_URL as string);
    await subscriber.subscribe(`metrics:${tenantId}`);
    const seen: Array<Record<string, unknown>> = [];
    subscriber.on('message', (_channel, bytes) => seen.push(JSON.parse(bytes)));
    const window = {
      windowMs: 2000,
      requestCount: 5,
      errorCount: 2,
      timeoutCount: 1,
      latencyCounts: METRIC_LATENCY_BUCKETS.map((bucket) =>
        bucket === 10 ? 5 : 0,
      ),
    };
    try {
      const { ws } = await connect(apiKey);
      ws.send(
        JSON.stringify({
          type: 'metrics',
          tenantId: secondId,
          payload: {
            rps: 2.5,
            p50: 10,
            p95: 10,
            p99: 10,
            errorRate: 0.4,
            window,
          },
        }),
      );
      await until(async () => seen.length === 1);
      expect(seen[0]).not.toHaveProperty('window');
      expect(seen[0]).not.toHaveProperty('aggregateWindow');
      const [stored] = await ds.query(
        `SELECT "aggregateWindow" FROM tenant_${tenantId.replace(/-/g, '_')}.metrics_snapshots WHERE rps = 2.5 ORDER BY timestamp DESC LIMIT 1`,
      );
      expect(stored.aggregateWindow).toEqual(window);
      const other = await ds.query(
        `SELECT "aggregateWindow" FROM tenant_${secondId.replace(/-/g, '_')}.metrics_snapshots WHERE "aggregateWindow" IS NOT NULL`,
      );
      expect(other).toEqual([]);
      ws.send(
        JSON.stringify({
          type: 'metrics',
          payload: { rps: 6.5, p50: 1, p95: 2, p99: 3, errorRate: 0 },
        }),
      );
      await until(async () => seen.length === 2);
      const [legacy] = await ds.query(
        `SELECT "aggregateWindow" FROM tenant_${tenantId.replace(/-/g, '_')}.metrics_snapshots WHERE rps = 6.5 ORDER BY timestamp DESC LIMIT 1`,
      );
      expect(legacy.aggregateWindow).toBeNull();
    } finally {
      subscriber.disconnect();
    }
  });
  it('bounds metric storage across independent concurrent writers and removes expired snapshots', async () => {
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
    await ds.query(`TRUNCATE ${schema}.metrics_snapshots`);
    await ds.query(
      `INSERT INTO ${schema}.metrics_snapshots (rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp) SELECT 1, 1, 2, 3, 0, NOW() - INTERVAL '1 minute' FROM generate_series(1, 200)`,
    );
    await ds.query(
      `INSERT INTO ${schema}.metrics_snapshots (rps, timestamp) VALUES (999, NOW() - INTERVAL '8 days')`,
    );
    const settings = new ConfigService({
      metricIngestion: { maxRowsPerTenant: 128 },
    });
    const writers = [
      new LogIngestionService(ds, settings),
      new LogIngestionService(ds, settings),
    ];
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        writers[i % 2].ingestMetrics(
          i % 2 ? tenantId.toUpperCase() : tenantId,
          { rps: 1.125, p50: 1, p95: 2, p99: 3, errorRate: 0 },
        ),
      ),
    );
    expect(
      Number(
        (await ds.query(`SELECT COUNT(*) FROM ${schema}.metrics_snapshots`))[0]
          .count,
      ),
    ).toBe(128);
    expect(
      Number(
        (
          await ds.query(
            `SELECT COUNT(*) FROM ${schema}.metrics_snapshots WHERE rps = 999`,
          )
        )[0].count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await ds.query(
            `SELECT COUNT(*) FROM ${schema}.metrics_snapshots WHERE rps = 1.125`,
          )
        )[0].count,
      ),
    ).toBe(24);
  });
  it('expires metrics for idle tenants without another report', async () => {
    const schema = `tenant_${secondId.replace(/-/g, '_')}`;
    await ds.query(
      `INSERT INTO ${schema}.metrics_snapshots (rps, timestamp) VALUES (9999, NOW() - INTERVAL '8 days'), (8888, NOW())`,
    );
    const service = new LogIngestionService(ds);
    await service.cleanupExpired();
    expect(
      (
        await ds.query(
          `SELECT rps FROM ${schema}.metrics_snapshots WHERE rps IN (9999, 8888)`,
        )
      ).map((row: { rps: number }) => row.rps),
    ).toEqual([8888]);
    await service.onModuleDestroy();
    await expect(
      service.ingestMetrics(secondId, {
        rps: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        errorRate: 0,
      }),
    ).rejects.toThrow('stopping');
  });
  it('preserves publication versions and retains pending config until ACK', async () => {
    const { ws, message } = await connect(apiKey);
    const config = message.payload.config;
    await ds
      .getRepository(PendingConfigUpdate)
      .save({ tenantId, config: { config, version: 9 } });
    const next = once(ws, 'message');
    await redis.publish(
      'config.update',
      JSON.stringify({ tenantId, config, version: 9 }),
    );
    const [data] = await next;
    const update = JSON.parse(data.toString()) as ConfigUpdateMessage;
    expect(update.version).toBe(9);
    expect(update.payload.services[0]).toMatchObject({
      name: 'persisted-service',
      healthCheckIntervalMs: 1500,
      healthCheckProtocol: 'grpc',
      healthCheckService: 'test.Echo',
      unhealthyFallback: true,
    });
    expect(
      await ds.getRepository(PendingConfigUpdate).countBy({ tenantId }),
    ).toBe(1);
    ws.send(JSON.stringify({ type: 'config.ack', version: 9 }));
    for (let i = 0; i < 100; i++) {
      if (
        (await ds.getRepository(PendingConfigUpdate).countBy({ tenantId })) ===
        0
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      await ds.getRepository(PendingConfigUpdate).countBy({ tenantId }),
    ).toBe(0);
  });

  it('rejects revoked gateway keys', async () => {
    await ds
      .getRepository(ApiKey)
      .update({ tenantId }, { revokedAt: new Date() });
    const ws = new WebSocket(url);
    sockets.push(ws);
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'auth', payload: { apiKey } }));
    const [code] = await closed;
    expect(code).toBe(4001);
  });

  async function connectTraceGateway() {
    const key = randomUUID();
    await ds.getRepository(ApiKey).save({
      tenantId,
      keyHash: createHash('sha256').update(key).digest('hex'),
      label: 'trace-verification',
    });
    return connect(key);
  }
  function trace(index = 1): TraceSpan {
    return {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: index.toString(16).padStart(16, '0'),
      name: 'Gateway request',
      kind: 'server',
      timestamp: new Date().toISOString(),
      durationMs: 2.125,
      status: 'ok',
      attributes: { 'http.route': '/users/:id' },
    };
  }
  async function until(predicate: () => Promise<boolean>) {
    const end = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error('Trace condition did not converge');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  it('attributes trace batches to the authenticated tenant and deduplicates replays', async () => {
    const { ws } = await connectTraceGateway();
    const message = { type: 'traces', tenantId: secondId, payload: [trace()] };
    ws.send(JSON.stringify(message));
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
    await until(
      async () =>
        Number(
          (await ds.query(`SELECT COUNT(*) FROM ${schema}.trace_spans`))[0]
            .count,
        ) === 1,
    );
    ws.send(JSON.stringify(message));
    // A second valid span proves the serialized replay has been processed.
    ws.send(JSON.stringify({ type: 'traces', payload: [trace(2)] }));
    await until(
      async () =>
        Number(
          (await ds.query(`SELECT COUNT(*) FROM ${schema}.trace_spans`))[0]
            .count,
        ) === 2,
    );
    const rows = await ds.query(
      `SELECT * FROM ${schema}.trace_spans ORDER BY "spanId"`,
    );
    expect(rows[0].durationMs).toBe(2.125);
    expect(
      Number(
        (
          await ds.query(
            `SELECT COUNT(*) FROM tenant_${secondId.replace(/-/g, '_')}.trace_spans`,
          )
        )[0].count,
      ),
    ).toBe(0);
  });
  it('enforces expiry and a hard tenant row bound across concurrent writers', async () => {
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
    await ds.query(`TRUNCATE ${schema}.trace_spans`);
    const expired = trace(1000);
    await ds.query(
      `INSERT INTO ${schema}.trace_spans ("traceId", "spanId", name, kind, timestamp, "durationMs", status, attributes) VALUES ($1, $2, $3, $4, NOW() - INTERVAL '8 days', $5, $6, $7)`,
      [
        expired.traceId,
        expired.spanId,
        expired.name,
        expired.kind,
        expired.durationMs,
        expired.status,
        JSON.stringify(expired.attributes),
      ],
    );
    await Promise.all([
      traceIngestion.ingest(
        tenantId,
        Array.from({ length: 100 }, (_, i) => trace(i + 1)),
      ),
      traceIngestion.ingest(
        tenantId.toUpperCase(),
        Array.from({ length: 100 }, (_, i) => trace(i + 101)),
      ),
    ]);
    expect(
      Number(
        (await ds.query(`SELECT COUNT(*) FROM ${schema}.trace_spans`))[0].count,
      ),
    ).toBe(128);
    expect(
      await ds.query(
        `SELECT * FROM ${schema}.trace_spans WHERE "spanId" = $1`,
        [expired.spanId],
      ),
    ).toHaveLength(0);
  });
  it('stores correlated integer-duration logs in both upgraded and legacy schemas', async () => {
    const ingestion = new LogIngestionService(ds);
    for (const id of [tenantId, secondId]) {
      const log = {
        id: randomUUID(),
        method: 'GET',
        path: '/users/:id',
        statusCode: 200,
        responseTimeMs: 2,
        requestId: randomUUID(),
        clientIp: '127.0.0.1',
        timestamp: new Date().toISOString(),
        traceId: trace().traceId,
        spanId: trace().spanId,
        receivedAt: '2000-01-01T00:00:00Z',
      };
      await ingestion.ingestLogs(id, [log]);
      const rows = await ds.query(
        `SELECT * FROM tenant_${id.replace(/-/g, '_')}.request_logs WHERE id = $1`,
        [log.id],
      );
      expect(rows[0].responseTimeMs).toBe(2);
      if (id === tenantId) {
        expect(rows[0].traceId).toBe(log.traceId);
        expect(rows[0].receivedAt.getTime()).toBeGreaterThan(
          Date.now() - 10000,
        );
        const receipt = rows[0].receivedAt;
        await ingestion.ingestLogs(id, [log]);
        expect(
          (
            await ds.query(
              `SELECT "receivedAt" FROM tenant_${id.replace(/-/g, '_')}.request_logs WHERE id=$1`,
              [log.id],
            )
          )[0].receivedAt,
        ).toEqual(receipt);
      }
    }
  });
  it('bounds receipt-lock waits and recovers a rejected log batch after the competing transaction ends', async () => {
    const ingestion = new LogIngestionService(ds);
    const runner = ds.createQueryRunner();
    const log = {
      id: randomUUID(),
      method: 'GET',
      path: '/receipt-deadline',
      statusCode: 200,
      responseTimeMs: 1,
      requestId: randomUUID(),
      clientIp: '',
      timestamp: '2000-01-01T00:00:00Z',
    };
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`log-receipt:${tenantId}`],
      );
      await expect(ingestion.ingestLogs(tenantId, [log])).rejects.toThrow(
        'lock timeout',
      );
      expect(
        await ds.query(
          `SELECT id FROM tenant_${tenantId.replace(/-/g, '_')}.request_logs WHERE id=$1`,
          [log.id],
        ),
      ).toHaveLength(0);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await ingestion.ingestLogs(tenantId, [log]);
    const [stored] = await ds.query(
      `SELECT "receivedAt" FROM tenant_${tenantId.replace(/-/g, '_')}.request_logs WHERE id=$1`,
      [log.id],
    );
    expect(stored.receivedAt.getTime()).toBeGreaterThan(Date.now() - 10000);
    await ingestion.onModuleDestroy();
  });
  it('closes oversized frames and bounded queues instead of accumulating pending trace writes', async () => {
    const large = await connectTraceGateway();
    const oversizedClosed = once(large.ws, 'close');
    large.ws.send(' '.repeat(131073));
    expect((await oversizedClosed)[0]).toBe(GatewayCloseCode.MESSAGE_TOO_LARGE);
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`trace-ingestion:${tenantId}`],
      );
      const { ws } = await connectTraceGateway();
      ws.send(JSON.stringify({ type: 'traces', payload: [trace(999)] }));
      await until(async () => traceIngestion.activeIngestions === 1);
      const closed = once(ws, 'close');
      for (let i = 0; i < 10; i++)
        ws.send(JSON.stringify({ type: 'traces', payload: [trace(1001 + i)] }));
      expect((await closed)[0]).toBe(GatewayCloseCode.RESOURCE_LIMIT);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await until(async () => traceIngestion.activeIngestions === 0);
  });
  it('stores replayed error batches only once', async () => {
    const ingestion = new LogIngestionService(ds);
    const errors = [
      {
        id: randomUUID(),
        requestId: randomUUID(),
        errorCode: 'TEST',
        message: 'test',
        timestamp: new Date().toISOString(),
      },
    ];
    await ingestion.ingestErrors(tenantId, errors);
    await ingestion.ingestErrors(tenantId, errors);
    const [{ count }] = await ds.query(
      `SELECT COUNT(*) FROM tenant_${tenantId.replace(/-/g, '_')}.error_events`,
    );
    expect(Number(count)).toBe(1);
  });
});
