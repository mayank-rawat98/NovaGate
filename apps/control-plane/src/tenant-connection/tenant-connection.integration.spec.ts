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
        `CREATE TABLE ${schema}.services (id UUID, name TEXT, "healthCheckIntervalMs" INTEGER DEFAULT 1500, "unhealthyFallback" BOOLEAN DEFAULT true, "deletedAt" TIMESTAMP)`,
      );
      await ds.query(
        `CREATE TABLE ${schema}.consumers (id UUID, "revokedAt" TIMESTAMP)`,
      );
      await ds.query(
        `CREATE TABLE ${schema}.metrics_snapshots (rps FLOAT, "p50Ms" INTEGER, "p95Ms" INTEGER, "p99Ms" INTEGER, "errorRate" FLOAT, timestamp TIMESTAMP)`,
      );
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
    manager = new TenantConnectionManager(
      ds.getRepository(Tenant),
      ds.getRepository(ApiKey),
      ds.getRepository(PendingConfigUpdate),
      new LogIngestionService(ds),
      ds,
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

  it('loads persisted services and the database version at authentication', async () => {
    const { message } = await connect(apiKey);
    expect(message.payload.config.services[0]).toMatchObject({
      name: 'persisted-service',
      healthCheckIntervalMs: 1500,
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
