import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type {
  FederatedGraphSummary,
  FederationCompositionResult,
  TenantConfig,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { RoutesController } from '../proxy-config/routes.controller';
import { ServicesController } from '../proxy-config/services.controller';
import { GraphqlFederationController } from './graphql-federation.controller';
import { GraphqlFederationService } from './graphql-federation.service';
import { configureFederationParser } from './graphql-federation.body-parser';

const USERS_SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
type Query { users: [User!]! }
type User @key(fields: "id") { id: ID! name: String! }
`;
const REVIEWS_SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
type Review { id: ID! body: String! }
type User @key(fields: "id") { id: ID! reviews: [Review!]! }
`;

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
integration('GraphQL federation on actual PostgreSQL, Redis and HTTP', () => {
  const secret = 'federation-fixture-secret-longer-than-32-chars';
  const previous = {
    secret: process.env.PLATFORM_JWT_SECRET,
    redis: process.env.REDIS_URL,
  };
  const database = `novagate_federation_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let push: ConfigPushService, subscriber: Redis;
  const published: Array<{
    tenantId: string;
    config: TenantConfig;
    version: number;
  }> = [];
  const tenants: string[] = [];

  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = secret;
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${database}`;
    db = new DataSource({ type: 'postgres', url: url.toString() });
    await db.initialize();
    await db.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    await new MigrationService(db).onModuleInit();
    subscriber = new Redis(process.env.TEST_REDIS_URL as string);
    await subscriber.subscribe('config.update');
    subscriber.on('message', (_channel, message) => {
      const payload = JSON.parse(message);
      if (tenants.includes(payload.tenantId)) published.push(payload);
    });
    push = new ConfigPushService(db);
    push.onModuleInit();
    const module = await Test.createTestingModule({
      controllers: [
        GraphqlFederationController,
        RoutesController,
        ServicesController,
      ],
      providers: [
        GraphqlFederationService,
        { provide: DataSource, useValue: db },
        { provide: ConfigPushService, useValue: push },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication({
      logger: ['error'],
      forceCloseConnections: true,
    });
    configureFederationParser(app);
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await push?.onModuleDestroy();
    subscriber?.disconnect();
    for (const tenant of tenants) {
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      for (const table of [
        'api_keys',
        'pending_config_updates',
        'gateway_instances',
      ])
        await db.query(`DELETE FROM public.${table} WHERE "tenantId"=$1`, [
          tenant,
        ]);
      await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
    }
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
    for (const [key, value] of [
      ['PLATFORM_JWT_SECRET', previous.secret],
      ['REDIS_URL', previous.redis],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  async function workspace() {
    const tenant = randomUUID();
    tenants.push(tenant);
    await db.query(
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Federation fixture',$2,'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    return tenant;
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  async function call<T>(
    path: string,
    tenant: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    const response = await fetch(`${base}/tenants/${tenant}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: session(tenant),
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  const waitPublished = async (tenant: string, count: number) => {
    const deadline = Date.now() + 5000;
    while (
      published.filter((p) => p.tenantId === tenant).length < count &&
      Date.now() < deadline
    )
      await new Promise((done) => setTimeout(done, 20));
    return published.filter((p) => p.tenantId === tenant);
  };
  async function services(tenant: string) {
    const ids: string[] = [];
    for (const name of ['users', 'reviews']) {
      const created = await call<{ id: string }>('/services', tenant, {
        method: 'POST',
        body: {
          name,
          targets: [{ url: `http://${name}.internal:4000`, weight: 100 }],
          healthCheckPath: '/health',
          timeoutMs: 2000,
        },
      });
      expect(created.status).toBe(201);
      ids.push(created.body.id);
    }
    return ids;
  }

  it('composes two subgraphs, publishes the supergraph and keeps SDL in the admin API', async () => {
    const tenant = await workspace();
    const [users, reviews] = await services(tenant);
    const before = (await waitPublished(tenant, 2)).length;
    const subgraphs = [
      { name: 'users', serviceId: users, path: '/graphql', sdl: USERS_SDL },
      { name: 'reviews', serviceId: reviews, path: '/query', sdl: REVIEWS_SDL },
    ];
    const dryRun = await call<FederationCompositionResult>(
      '/graphql-federation/compose',
      tenant,
      {
        method: 'POST',
        body: { subgraphs },
      },
    );
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.ok).toBe(true);
    expect(dryRun.body.publicSdl).toContain('reviews: [Review!]!');
    // A dry run publishes nothing.
    expect((await waitPublished(tenant, before)).length).toBe(before);

    const saved = await call<{ name: string; subgraphs: unknown[] }>(
      '/graphql-federation/graphs/storefront',
      tenant,
      { method: 'PUT', body: { subgraphs } },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.subgraphs).toEqual(subgraphs);
    const after = await waitPublished(tenant, before + 1);
    const graphs = after[after.length - 1].config.federatedGraphs ?? [];
    expect(graphs).toHaveLength(1);
    expect(graphs[0]).toMatchObject({
      name: 'storefront',
      subgraphs: [
        { name: 'users', serviceId: users, path: '/graphql' },
        { name: 'reviews', serviceId: reviews, path: '/query' },
      ],
    });
    expect(graphs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(graphs[0].supergraphSdl).toContain(
      'url: "novagate://subgraph/reviews"',
    );
    // Gateways receive the composed supergraph, never the uploaded SDL.
    expect(JSON.stringify(graphs[0].subgraphs)).not.toContain('extend schema');

    const listed = await call<{ graphs: FederatedGraphSummary[] }>(
      '/graphql-federation/graphs',
      tenant,
    );
    expect(listed.body.graphs).toHaveLength(1);
    expect(listed.body.graphs[0]).toMatchObject({
      name: 'storefront',
      supergraphSha256: graphs[0].sha256,
      routes: [],
    });
    expect(listed.body.graphs[0].subgraphs[0]).toMatchObject({
      name: 'users',
      serviceName: 'users',
      sdlBytes: Buffer.byteLength(USERS_SDL),
    });
    expect(listed.body.graphs[0].publicSdl).not.toContain('@join__');
  });

  it('refuses graphs that do not compose, with the composition errors', async () => {
    const tenant = await workspace();
    const [users, reviews] = await services(tenant);
    const conflicting = REVIEWS_SDL.replace(
      'id: ID! reviews',
      'id: Int! reviews',
    );
    const subgraphs = [
      { name: 'users', serviceId: users, sdl: USERS_SDL },
      { name: 'reviews', serviceId: reviews, sdl: conflicting },
    ];
    const dryRun = await call<FederationCompositionResult>(
      '/graphql-federation/compose',
      tenant,
      {
        method: 'POST',
        body: { subgraphs },
      },
    );
    expect(dryRun.body.ok).toBe(false);
    expect(dryRun.body.errors.map((error) => error.code)).toContain(
      'FIELD_TYPE_MISMATCH',
    );
    const refused = await call<{ error: string; errors: unknown[] }>(
      '/graphql-federation/graphs/storefront',
      tenant,
      { method: 'PUT', body: { subgraphs } },
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('COMPOSITION_FAILED');
    expect(refused.body.errors.length).toBeGreaterThan(0);
    const unparsable = await call<FederationCompositionResult>(
      '/graphql-federation/compose',
      tenant,
      {
        method: 'POST',
        body: {
          subgraphs: [{ name: 'users', serviceId: users, sdl: 'type {' }],
        },
      },
    );
    expect(unparsable.body.errors[0]).toMatchObject({
      code: 'SDL_PARSE_ERROR',
    });
    expect(unparsable.body.errors[0].message).toMatch(/^users: Syntax Error/);
    const rows = await db.query(
      `SELECT 1 FROM ${tenantSchema(tenant)}.federated_graphs`,
    );
    expect(rows).toHaveLength(0);
  });

  it('validates names, services, paths and SDL size', async () => {
    const tenant = await workspace();
    const [users] = await services(tenant);
    const put = (name: string, subgraphs: unknown) =>
      call<{ message: string }>(`/graphql-federation/graphs/${name}`, tenant, {
        method: 'PUT',
        body: { subgraphs },
      });
    const valid = { name: 'users', serviceId: users, sdl: USERS_SDL };
    for (const [name, subgraphs, message] of [
      ['Bad_Name', [valid], /Graph names/],
      ['ok', [], /between 1 and 16/],
      ['ok', [valid, valid], /must be unique/],
      ['ok', [{ ...valid, serviceId: randomUUID() }], /does not exist/],
      ['ok', [{ ...valid, path: '/../admin' }], /path must start with/],
      ['ok', [{ ...valid, extra: true }], /send name, serviceId/],
      [
        'ok',
        [{ ...valid, sdl: `${USERS_SDL}#${'x'.repeat(262144)}` }],
        /at most 256 KiB/,
      ],
    ] as const) {
      const response = await put(name, subgraphs);
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(message);
    }
    // A subgraph near the SDL limit fits through the request parser.
    const large = `${USERS_SDL}\n${Array.from(
      { length: 2000 },
      (_, i) =>
        `"""Field ${i} of a large schema, documented."""\ntype T${i} { id: ID! value: String }`,
    ).join('\n')}`;
    expect(Buffer.byteLength(large)).toBeGreaterThan(102400);
    const accepted = await put('large', [{ ...valid, sdl: large }]);
    expect(accepted.status).toBe(200);
  });

  it('accepts the plugin on routes only last and with a valid configuration, and protects used graphs', async () => {
    const tenant = await workspace();
    const [users, reviews] = await services(tenant);
    expect(
      (
        await call('/graphql-federation/graphs/storefront', tenant, {
          method: 'PUT',
          body: {
            subgraphs: [
              { name: 'users', serviceId: users, sdl: USERS_SDL },
              { name: 'reviews', serviceId: reviews, sdl: REVIEWS_SDL },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const route = (plugins: unknown) =>
      call<{ id: string; message: string }>('/routes', tenant, {
        method: 'POST',
        body: {
          method: 'POST',
          pathPattern: '/graphql',
          serviceId: users,
          plugins,
        },
      });
    for (const [plugins, message] of [
      [[{ name: 'graphql-federation', config: {} }], /graph must name/],
      [
        [
          {
            name: 'graphql-federation',
            config: { graph: 'storefront', forwardHeaders: ['Host'] },
          },
        ],
        /forwardHeaders/,
      ],
      [
        [
          {
            name: 'graphql-federation',
            config: { graph: 'storefront', forwardHeaders: ['x-request-id'] },
          },
        ],
        /forwardHeaders/,
      ],
      [
        [
          { name: 'graphql-federation', config: { graph: 'storefront' } },
          { name: 'cors', config: {} },
        ],
        /must be the last plugin/,
      ],
    ] as const) {
      const refused = await route(plugins);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(message);
    }
    const created = await route([
      { name: 'cors', config: {} },
      {
        name: 'graphql-federation',
        config: { graph: 'storefront', forwardHeaders: ['authorization'] },
      },
    ]);
    expect(created.status).toBe(201);
    const listed = await call<{ graphs: FederatedGraphSummary[] }>(
      '/graphql-federation/graphs',
      tenant,
    );
    expect(listed.body.graphs[0].routes).toEqual(['POST /graphql']);
    const blocked = await call<{ message: string }>(
      '/graphql-federation/graphs/storefront',
      tenant,
      { method: 'DELETE' },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain('POST /graphql');
    await call(`/routes/${created.body.id}`, tenant, { method: 'DELETE' });
    const removed = await call(
      '/graphql-federation/graphs/storefront',
      tenant,
      {
        method: 'DELETE',
      },
    );
    expect(removed.status).toBe(200);
    // Soft delete: the row stays, and the graph leaves gateway configuration.
    const rows = await db.query(
      `SELECT "deletedAt" IS NOT NULL AS deleted FROM ${tenantSchema(tenant)}.federated_graphs`,
    );
    expect(rows).toEqual([{ deleted: true }]);
    const config = await push.assembleConfig(tenant);
    expect(config.federatedGraphs).toEqual([]);
    expect(
      (await call('/graphql-federation/graphs/storefront', tenant)).status,
    ).toBe(404);
  });
});
