import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { TracesService } from '../proxy-config/traces.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { MigrationService } from './migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { RoutesController } from '../proxy-config/routes.controller';
import { ServicesController } from '../proxy-config/services.controller';
import { ConsumersController } from '../proxy-config/consumers.controller';
import { ConfigPushService } from '../config-push/config-push.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Configuration upgrades and updates on PostgreSQL', () => {
  let root: DataSource;
  let ds: DataSource;
  let tenant: string;
  let schema: string;
  let legacy: string;
  let explicit: string;
  let service: string;
  const database = `novagate_upgrade_${randomUUID().replace(/-/g, '')}`;
  const publish = jest.fn().mockResolvedValue(undefined);
  const push = { triggerUpdate: publish } as unknown as ConfigPushService;

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
    tenant = randomUUID();
    schema = tenantSchema(tenant);
    await ds.query(
      `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'Upgrade tenant', $2, 'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(ds).provisionTenant(tenant);
    [{ id: service }] = await ds.query(
      `INSERT INTO ${schema}.services (name, targets) VALUES ('upstream', '[{"url":"http://upstream.test","weight":1}]') RETURNING id`,
    );
    await ds.query(
      `ALTER TABLE ${schema}.routes ADD COLUMN "maxBodyBytes" INTEGER, ADD COLUMN cors JSONB, ADD COLUMN "ipRestriction" JSONB`,
    );
    [{ id: legacy }] = await ds.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", "maxBodyBytes", cors, "ipRestriction", plugins)
      VALUES ('POST', '/legacy', $1, 1024, '{"origins":["https://app.example.test"]}', '{"deny":["203.0.113.0/24"]}', '[{"name":"request-transform","config":{}}]') RETURNING id`,
      [service],
    );
    [{ id: explicit }] = await ds.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", "maxBodyBytes", plugins)
      VALUES ('POST', '/explicit', $1, 1024, '[{"name":"request-size-limit","config":{"maxBodyBytes":99}}]') RETURNING id`,
      [service],
    );
    await new MigrationService(ds).onModuleInit();
  }, 30000);
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
  }, 30000);
  beforeEach(() => publish.mockClear());

  it('upgrades trace storage and log correlation idempotently without losing existing logs or spans', async () => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO ${schema}.request_logs (id, "responseTimeMs", timestamp) VALUES ($1, 2, NOW())`,
      [id],
    );
    await ds.query(
      `ALTER TABLE ${schema}.request_logs DROP COLUMN "traceId", DROP COLUMN "spanId"`,
    );
    await ds.query(`DROP TABLE ${schema}.trace_spans`);
    await new MigrationService(ds).onModuleInit();
    expect(
      (
        await ds.query(
          `SELECT "responseTimeMs", "traceId", "spanId" FROM ${schema}.request_logs WHERE id = $1`,
          [id],
        )
      )[0],
    ).toEqual({ responseTimeMs: 2, traceId: null, spanId: null });
    await ds.query(
      `INSERT INTO ${schema}.trace_spans ("traceId", "spanId", name, kind, timestamp, "durationMs", status, attributes) VALUES ('0123456789abcdef0123456789abcdef', '0123456789abcdef', 'Gateway request', 'server', NOW(), 1.25, 'ok', '{}')`,
    );
    await new MigrationService(ds).onModuleInit();
    expect(
      (await ds.query(`SELECT "durationMs" FROM ${schema}.trace_spans`))[0]
        .durationMs,
    ).toBe(1.25);
  });
  it('queries real trace waterfalls with tenant isolation, filtering and stable keyset pagination', async () => {
    await ds.query(`DELETE FROM ${schema}.trace_spans`);
    const first = '1123456789abcdef0123456789abcdef';
    const second = '2123456789abcdef0123456789abcdef';
    const requestId = randomUUID();
    const timestamp = new Date(Date.now() - 1000).toISOString();
    const attributes = JSON.stringify({
      'http.route': '/orders',
      'gateway.request.id': requestId,
    });
    for (const traceId of [first, second]) {
      await ds.query(
        `INSERT INTO ${schema}.trace_spans ("traceId", "spanId", "parentSpanId", name, kind, timestamp, "durationMs", status, attributes)
        VALUES ($1, '0123456789abcdef', NULL, 'Gateway request', 'server', $2, 2.125, 'ok', $3),
          ($1, '1123456789abcdef', '0123456789abcdef', 'upstream HTTP1', 'client', $2, 1.25, $4, $3)`,
        [traceId, timestamp, attributes, traceId === first ? 'error' : 'ok'],
      );
    }
    const queries = new TracesService(
      ds,
      new ConfigService({ traceQueries: { pageSize: 1 } }),
    );
    const page = await queries.list(tenant, { route: '/orders', requestId });
    expect(page.traces).toEqual([
      expect.objectContaining({
        traceId: second,
        spanCount: 2,
        durationMs: 2.125,
        status: 'ok',
        requestId,
        route: '/orders',
      }),
    ]);
    expect(page.nextCursor).not.toBeNull();
    const next = await queries.list(tenant, {
      route: '/orders',
      requestId,
      cursor: page.nextCursor,
    });
    expect(next.traces).toEqual([
      expect.objectContaining({ traceId: first, status: 'error' }),
    ]);
    expect(next.nextCursor).toBeNull();
    expect(
      (await queries.list(tenant, { errorsOnly: 'true' })).traces[0].traceId,
    ).toBe(first);
    expect((await queries.list(tenant, { route: '/missing' })).traces).toEqual(
      [],
    );
    const waterfall = await queries.detail(tenant, first);
    expect(waterfall.truncated).toBe(false);
    expect(waterfall.spans).toHaveLength(2);
    expect(waterfall.spans[0].parentSpanId).toBeUndefined();
    expect(waterfall.spans[1]).toMatchObject({
      parentSpanId: '0123456789abcdef',
      durationMs: 1.25,
      status: 'error',
    });
    await ds.query(
      `UPDATE ${schema}.trace_spans SET timestamp = NOW() - INTERVAL '8 days' WHERE "traceId" = $1`,
      [first],
    );
    await expect(queries.detail(tenant, first)).rejects.toThrow('not found');
    const wideQueries = new TracesService(
      ds,
      new ConfigService({ traceQueries: { maxRangeDays: 30 } }),
    );
    expect(
      (
        await wideQueries.list(tenant, {
          from: new Date(Date.now() - 10 * 86400000).toISOString(),
          to: new Date().toISOString(),
        })
      ).traces.map((trace) => trace.traceId),
    ).toEqual([second]);
    const other = randomUUID();
    await ds.query(`CREATE SCHEMA ${tenantSchema(other)}`);
    try {
      await ds.query(
        `CREATE TABLE ${tenantSchema(other)}.trace_spans (LIKE ${schema}.trace_spans INCLUDING ALL)`,
      );
      expect((await queries.list(other, {})).traces).toEqual([]);
      await expect(queries.detail(other, first)).rejects.toThrow('not found');
    } finally {
      await ds.query(`DROP SCHEMA ${tenantSchema(other)} CASCADE`);
    }
  });
  it('retains all legacy protections alongside configured plugins', async () => {
    const [row] = await ds.query(
      `SELECT plugins FROM ${schema}.routes WHERE id = $1`,
      [legacy],
    );
    expect(row.plugins).toEqual([
      { name: 'request-transform', config: {} },
      { name: 'request-size-limit', config: { maxBodyBytes: 1024 } },
      { name: 'cors', config: { origins: ['https://app.example.test'] } },
      { name: 'ip-restriction', config: { deny: ['203.0.113.0/24'] } },
    ]);
  });
  it('preserves explicit policies and remains idempotent after restart', async () => {
    await new MigrationService(ds).onModuleInit();
    const [row] = await ds.query(
      `SELECT plugins FROM ${schema}.routes WHERE id = $1`,
      [explicit],
    );
    expect(row.plugins).toEqual([
      { name: 'request-size-limit', config: { maxBodyBytes: 99 } },
    ]);
    const columns = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='routes'`,
      [schema],
    );
    expect(
      columns.map((c: { column_name: string }) => c.column_name),
    ).not.toEqual(
      expect.arrayContaining(['maxBodyBytes', 'cors', 'ipRestriction']),
    );
  });
  it('round trips route updates as an object and differentiates omitted policies from null', async () => {
    const controller = new RoutesController(ds, push);
    const policy = { attempts: 2, on: [502], methods: ['GET'] };
    const updated = await controller.update(tenant, legacy, {
      method: 'GET',
      retry: policy,
      rateLimitOverride: 5,
      graphql: { maxDepth: 3 },
    });
    expect(updated).toMatchObject({
      id: legacy,
      method: 'GET',
      retry: policy,
      rateLimitOverride: 5,
      graphql: { maxDepth: 3 },
    });
    const omitted = await controller.update(tenant, legacy, { enabled: false });
    expect(omitted).toMatchObject({
      enabled: false,
      retry: policy,
      rateLimitOverride: 5,
    });
    const cleared = await controller.update(tenant, legacy, {
      retry: null,
      rateLimitOverride: null,
      graphql: null,
      plugins: null,
    });
    expect(cleared).toMatchObject({
      retry: null,
      rateLimitOverride: null,
      graphql: null,
      plugins: null,
    });
    expect(publish).toHaveBeenCalledTimes(3);
  });
  it('round trips service flags including false without returning a driver tuple', async () => {
    const controller = new ServicesController(ds, push);
    expect(
      await controller.update(tenant, service, { name: 'renamed', h2: true }),
    ).toMatchObject({ id: service, name: 'renamed', h2: true });
    expect(
      await controller.update(tenant, service, { h2: false }),
    ).toMatchObject({ id: service, h2: false });
  });
  it('migrates health defaults and preserves omitted settings across updates', async () => {
    const controller = new ServicesController(ds, push);
    expect(await controller.update(tenant, service, {})).toMatchObject({
      healthCheckIntervalMs: 10000,
      unhealthyFallback: false,
    });
    expect(
      await controller.update(tenant, service, {
        healthCheckIntervalMs: 1500,
        unhealthyFallback: true,
      }),
    ).toMatchObject({ healthCheckIntervalMs: 1500, unhealthyFallback: true });
    expect(
      await controller.update(tenant, service, { name: 'preserved' }),
    ).toMatchObject({ healthCheckIntervalMs: 1500, unhealthyFallback: true });
    expect(
      await controller.update(tenant, service, { unhealthyFallback: false }),
    ).toMatchObject({ healthCheckIntervalMs: 1500, unhealthyFallback: false });
    expect(
      await controller.create(tenant, {
        name: 'fresh',
        targets: [{ url: 'http://fresh:8080', weight: 1 }],
      }),
    ).toMatchObject({ healthCheckIntervalMs: 10000, unhealthyFallback: false });
  });
  it('migrates and round trips native health settings and protocol flags', async () => {
    const controller = new ServicesController(ds, push);
    expect(await controller.update(tenant, service, {})).toMatchObject({
      healthCheckProtocol: 'http',
      healthCheckService: '',
    });
    expect(
      await controller.update(tenant, service, {
        healthCheckProtocol: 'grpc',
        healthCheckService: 'test.Echo',
        h2: true,
        supportsWebSocket: true,
      }),
    ).toMatchObject({
      healthCheckProtocol: 'grpc',
      healthCheckService: 'test.Echo',
      h2: true,
      supportsWebSocket: true,
    });
    expect(
      await controller.update(tenant, service, { name: 'preserved-protocol' }),
    ).toMatchObject({
      healthCheckProtocol: 'grpc',
      healthCheckService: 'test.Echo',
      h2: true,
    });
    expect(
      await controller.update(tenant, service, {
        healthCheckService: '',
        supportsWebSocket: false,
      }),
    ).toMatchObject({ healthCheckService: '', supportsWebSocket: false });
  });
  it('migrates and preserves a service balancing policy through partial updates', async () => {
    const controller = new ServicesController(ds, push);
    expect(await controller.update(tenant, service, {})).toMatchObject({
      loadBalancing: 'weighted-round-robin',
    });
    expect(
      await controller.update(tenant, service, {
        loadBalancing: 'least-connections',
      }),
    ).toMatchObject({ loadBalancing: 'least-connections' });
    expect(
      await controller.update(tenant, service, { timeoutMs: 2500 }),
    ).toMatchObject({ loadBalancing: 'least-connections', timeoutMs: 2500 });
    expect(
      await controller.update(tenant, service, {
        loadBalancing: 'weighted-round-robin',
      }),
    ).toMatchObject({ loadBalancing: 'weighted-round-robin' });
    expect(
      await controller.create(tenant, {
        name: 'least-busy',
        targets: [{ url: 'http://least:8080', weight: 1 }],
        loadBalancing: 'least-connections',
      }),
    ).toMatchObject({ loadBalancing: 'least-connections' });
  });
  it('keeps consumer groups when omitted and returns the updated consumer without its key hash', async () => {
    const controller = new ConsumersController(ds, push);
    const consumer = await controller.create(tenant, {
      name: 'app',
      groups: ['admins'],
    });
    const omitted = await controller.update(tenant, consumer.id, {});
    expect(omitted).toMatchObject({ id: consumer.id, groups: ['admins'] });
    expect(omitted).not.toHaveProperty('keyHash');
    expect(
      await controller.update(tenant, consumer.id, { groups: [] }),
    ).toMatchObject({ groups: [] });
  });
  it('returns not found without publishing a nonexistent configuration update', async () => {
    await expect(
      new RoutesController(ds, push).update(tenant, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new ServicesController(ds, push).update(tenant, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new ConsumersController(ds, push).update(tenant, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(publish).not.toHaveBeenCalled();
  });
  it('rolls back a failed migration without removing original policies', async () => {
    await ds.query(
      `ALTER TABLE ${schema}.routes ADD COLUMN "maxBodyBytes" INTEGER, ADD COLUMN cors JSONB`,
    );
    await ds.query(
      `UPDATE ${schema}.routes SET "maxBodyBytes"=7, cors='{}', plugins='[]' WHERE id=$1`,
      [legacy],
    );
    await ds.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", cors, plugins) VALUES ('GET', '/malformed', $1, '{}', '{}')`,
      [service],
    );
    await expect(new MigrationService(ds).onModuleInit()).rejects.toThrow();
    const [row] = await ds.query(
      `SELECT "maxBodyBytes", cors, plugins FROM ${schema}.routes WHERE id=$1`,
      [legacy],
    );
    expect(row).toEqual({ maxBodyBytes: 7, cors: {}, plugins: [] });
  });
});
