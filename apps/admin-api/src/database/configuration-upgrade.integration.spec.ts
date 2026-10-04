import { randomUUID } from 'crypto';
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
  });
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
  });
  beforeEach(() => publish.mockClear());

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
