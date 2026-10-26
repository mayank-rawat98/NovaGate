import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { once } from 'events';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthOkMessage } from '@api-gateway/shared-types';
import {
  Tenant,
  ApiKey,
  PendingConfigUpdate,
} from '../database/entities/public.entities';
import { LogIngestionService } from '../ingestion/log-ingestion.service';
import { TenantConnectionManager } from './tenant-connection.manager';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;

/** Two regions on one (replicated) database, each with its own Redis. */
integration('Multi-region control planes on real PostgreSQL and Redis', () => {
  let ds: DataSource;
  const managers: Record<string, TenantConnectionManager> = {};
  const urls: Record<string, string> = {};
  const redis: Record<string, Redis> = {};
  const tenantId = randomUUID();
  const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
  const apiKey = randomUUID();
  const sockets: WebSocket[] = [];
  const previous = { redis: process.env.REDIS_URL, port: process.env.WS_PORT };

  type Frame = {
    type: string;
    id?: string;
    version?: number;
    payload: { routes: unknown[] } & Record<string, unknown>;
  };
  type Gateway = { ws: WebSocket; frames: Frame[] };
  async function connect(region: string, instanceId = randomUUID()) {
    const ws = new WebSocket(urls[region]);
    sockets.push(ws);
    const frames: Gateway['frames'] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        type: 'auth',
        payload: {
          apiKey,
          instanceId,
          instanceName: 'edge-a',
          configVersion: 4,
        },
      }),
    );
    await until(async () => frames.some((f) => f.type === 'auth_ok'));
    return { ws, frames, instanceId };
  }
  async function until(
    check: () => Promise<boolean> | boolean,
    timeout = 8000,
  ) {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > timeout) throw new Error('Timed out');
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  const presence = () =>
    ds.query(
      `SELECT "instanceId",name,region,"disconnectedAt" IS NOT NULL AS disconnected,"configVersion"::int AS "configVersion"
         FROM public.gateway_instances WHERE "tenantId"=$1 ORDER BY region,"instanceId"`,
      [tenantId],
    );

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
      `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS "caCertPem" TEXT, ADD COLUMN IF NOT EXISTS "logPrivacy" JSONB NOT NULL DEFAULT '{"clientIp":"omit","userAgent":"omit"}'::jsonb`,
    );
    await ds.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS pending_config_updates_tenant_unique ON public.pending_config_updates ("tenantId")',
    );
    // Admin migrations own this table; the minimal shape for the collector.
    await ds.query(`CREATE TABLE IF NOT EXISTS public.gateway_instances (
      "tenantId" UUID NOT NULL, "instanceId" UUID NOT NULL, name VARCHAR(64) NOT NULL,
      region VARCHAR(32), "connectedAt" TIMESTAMPTZ NOT NULL, "lastSeenAt" TIMESTAMPTZ NOT NULL,
      "disconnectedAt" TIMESTAMPTZ, "configVersion" BIGINT, PRIMARY KEY ("tenantId","instanceId"))`);
    await ds.getRepository(Tenant).save({
      id: tenantId,
      name: 'Regions',
      email: `${tenantId}@example.test`,
      planId: 'free',
      gatewayConfigVersion: 4,
    });
    await ds.query(`CREATE SCHEMA ${schema}`);
    await ds.query(
      `CREATE TABLE ${schema}.routes (id UUID, enabled BOOLEAN, "deletedAt" TIMESTAMP)`,
    );
    await ds.query(
      `CREATE TABLE ${schema}.services (id UUID, "deletedAt" TIMESTAMP)`,
    );
    await ds.query(
      `CREATE TABLE ${schema}.consumers (id UUID, "revokedAt" TIMESTAMP)`,
    );
    await ds.query(
      `CREATE TABLE ${schema}.error_events (id UUID PRIMARY KEY, "requestId" TEXT, "errorCode" TEXT, message TEXT, "serviceId" UUID, path TEXT, "statusCode" INTEGER, timestamp TIMESTAMP)`,
    );
    await ds.getRepository(ApiKey).save({
      tenantId,
      keyHash: createHash('sha256').update(apiKey).digest('hex'),
      label: 'regions',
    });
    process.env.WS_PORT = '0';
    for (const [region, db] of [
      ['us-east', 13],
      ['eu-west', 14],
    ] as const) {
      process.env.REDIS_URL = `${process.env.TEST_REDIS_URL}/${db}`;
      redis[region] = new Redis(process.env.REDIS_URL);
      const manager = new TenantConnectionManager(
        ds.getRepository(Tenant),
        ds.getRepository(ApiKey),
        ds.getRepository(PendingConfigUpdate),
        new LogIngestionService(ds),
        ds,
        undefined,
        new ConfigService({ region: { region, configSyncIntervalMs: 1000 } }),
      );
      manager.onModuleInit();
      managers[region] = manager;
      const wss = (manager as unknown as { wss: WebSocketServer }).wss;
      if (!wss.address()) await once(wss, 'listening');
      const address = wss.address();
      if (!address || typeof address === 'string') throw new Error('TCP');
      urls[region] = `ws://127.0.0.1:${address.port}`;
      await until(async () => {
        const [, count] = (await redis[region].pubsub(
          'NUMSUB',
          'config.update',
        )) as [string, number];
        return Number(count) > 0;
      });
    }
  }, 30000);

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    for (const manager of Object.values(managers))
      await manager.onModuleDestroy();
    for (const client of Object.values(redis)) {
      await client.flushdb();
      client.disconnect();
    }
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const table of [
        'gateway_instances',
        'pending_config_updates',
        'api_keys',
      ])
        await ds.query(`DELETE FROM public.${table} WHERE "tenantId"=$1`, [
          tenantId,
        ]);
      await ds.query('DELETE FROM public.tenants WHERE id=$1', [tenantId]);
      await ds.destroy();
    }
    process.env.REDIS_URL = previous.redis;
    process.env.WS_PORT = previous.port;
    if (previous.redis === undefined) delete process.env.REDIS_URL;
    if (previous.port === undefined) delete process.env.WS_PORT;
  });

  it('serves several gateways of one workspace, each with its own presence and ACKs', async () => {
    const a = await connect('us-east');
    const b = await connect('us-east');
    for (const gateway of [a, b])
      expect(
        (
          gateway.frames.find(
            (f) => f.type === 'auth_ok',
          ) as unknown as AuthOkMessage
        ).payload.controlPlaneRegion,
      ).toBe('us-east');
    await until(async () => (await presence()).length === 2);
    expect(await presence()).toEqual(
      [a, b]
        .map(({ instanceId }) => ({
          instanceId,
          name: 'edge-a',
          region: 'us-east',
          disconnected: false,
          configVersion: 4,
        }))
        .sort((x, y) => x.instanceId.localeCompare(y.instanceId)),
    );
    // A publication reaches both gateways, not only the latest one.
    await redis['us-east'].publish(
      'config.update',
      JSON.stringify({
        tenantId,
        version: 4,
        config: {
          routes: [],
          services: [],
          consumers: [],
          rateLimit: { windowMs: 1, unauthMax: 1, authMax: 1 },
        },
      }),
    );
    await until(() =>
      [a, b].every((g) => g.frames.some((f) => f.type === 'config.update')),
    );
    // Error ACKs go back to the gateway that sent the errors.
    b.ws.send(
      JSON.stringify({
        type: 'errors',
        id: 'batch-b',
        payload: [
          {
            id: randomUUID(),
            requestId: 'r',
            errorCode: 'X',
            message: 'm',
            path: '/',
            statusCode: 500,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    );
    await until(() =>
      b.frames.some((f) => f.type === 'ack' && f.id === 'batch-b'),
    );
    expect(a.frames.some((f) => f.type === 'ack')).toBe(false);
    // One gateway leaving keeps the workspace online.
    a.ws.close();
    await until(async () =>
      (await presence()).some(
        (row: { disconnected: boolean }) => row.disconnected,
      ),
    );
    expect(managers['us-east'].isOnline(tenantId)).toBe(true);
    expect(await redis['us-east'].get(`gw:online:${tenantId}`)).toBe('1');
    b.ws.close();
    await until(async () => !managers['us-east'].isOnline(tenantId));
  });

  it('delivers configuration published in another region from the database', async () => {
    const gateway = await connect('eu-west');
    expect(
      (
        gateway.frames.find(
          (f) => f.type === 'auth_ok',
        ) as unknown as AuthOkMessage
      ).payload,
    ).toMatchObject({ controlPlaneRegion: 'eu-west', configVersion: 4 });
    gateway.ws.send(JSON.stringify({ type: 'config.ack', version: 4 }));
    // The admin API persists version 5 and publishes in another region.
    await ds.query(
      `UPDATE public.tenants SET "gatewayConfigVersion"=5 WHERE id=$1`,
      [tenantId],
    );
    await ds.query(
      `INSERT INTO ${schema}.routes (id, enabled) VALUES ($1, true)`,
      [randomUUID()],
    );
    // Pub/sub ignores Redis database numbers, so "another region's Redis" is
    // simulated by not publishing at all: only the database knows version 5.
    await until(() =>
      gateway.frames.some((f) => f.type === 'config.update' && f.version === 5),
    );
    const update = gateway.frames.find(
      (f) => f.type === 'config.update' && f.version === 5,
    );
    expect(update?.payload.routes).toHaveLength(1);
    gateway.ws.send(JSON.stringify({ type: 'config.ack', version: 5 }));
    await until(async () =>
      (await presence()).some(
        (row: { region: string; configVersion: number }) =>
          row.region === 'eu-west' && row.configVersion === 5,
      ),
    );
    // Acknowledged: no further resends.
    const sent = gateway.frames.filter(
      (f) => f.type === 'config.update',
    ).length;
    await new Promise((done) => setTimeout(done, 2500));
    expect(
      gateway.frames.filter((f) => f.type === 'config.update'),
    ).toHaveLength(sent);
    gateway.ws.close();
  });
});
