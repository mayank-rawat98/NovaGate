import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { parse, stringify } from 'yaml';
import type {
  ConfigPreview,
  ConsumerUsageStats,
  CreatedPortalKey,
  PortalCatalog,
  PortalDeveloper,
  PortalDeveloperSession,
  PortalKey,
  PortalSettings,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { RoutesController } from '../proxy-config/routes.controller';
import { ConsumerAnalyticsService } from '../proxy-config/consumer-analytics.service';
import { ConfigImportController } from '../config-import/config-import.controller';
import { ConfigImportService } from '../config-import/config-import.service';
import { configureConfigImportParser } from '../config-import/config-import.body-parser';
import { EmailService } from '../email/email.service';
import { PortalService, INITIAL_PORTAL_REVISION } from './portal.service';
import { PortalDevelopersService } from './portal-developers.service';
import { PortalDeveloperGuard } from './portal-developer.guard';
import { PortalPublicController } from './portal-public.controller';
import { PortalDeveloperController } from './portal-developer.controller';
import { PortalAdminController } from './portal-admin.controller';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Developer portal on actual PostgreSQL and HTTP', () => {
  const secret = 'portal-fixture-platform-secret-longer-than-32-chars';
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const database = `novagate_portal_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let push: ConfigPushService;
  const tenants: string[] = [];
  const sent: Array<{ to: string; url: string; title: string }> = [];
  const email = {
    sendPortalVerification: jest.fn(
      async (to: string, url: string, title: string) => {
        sent.push({ to, url, title });
      },
    ),
  };
  const publish = jest.fn().mockResolvedValue(true);

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
    push = new ConfigPushService(db);
    const module = await Test.createTestingModule({
      controllers: [
        PortalPublicController,
        PortalDeveloperController,
        PortalAdminController,
        RoutesController,
        ConfigImportController,
      ],
      providers: [
        PortalService,
        PortalDevelopersService,
        PortalDeveloperGuard,
        ConsumerAnalyticsService,
        ConfigImportService,
        { provide: DataSource, useValue: db },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigPushService,
          useValue: {
            persistUpdate: push.persistUpdate.bind(push),
            publish,
            triggerUpdate: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication({
      logger: false,
      forceCloseConnections: true,
    });
    configureConfigImportParser(app);
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  }, 30000);

  afterEach(async () => {
    sent.length = 0;
    email.sendPortalVerification.mockClear();
    publish.mockClear();
    for (const tenant of tenants.splice(0)) {
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      for (const table of ['api_keys', 'pending_config_updates'])
        await db.query(`DELETE FROM public.${table} WHERE "tenantId"=$1`, [
          tenant,
        ]);
      await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
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

  async function workspace(name = 'Acme') {
    const tenant = randomUUID();
    tenants.push(tenant);
    await db.query(
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,$2,$3,'free')`,
      [tenant, name, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    return tenant;
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  async function call<T = unknown>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      auth?: string;
      type?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.auth ? { authorization: init.auth } : {}),
        ...(init.body === undefined
          ? {}
          : { 'content-type': init.type ?? 'application/json' }),
        ...init.headers,
      },
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* YAML and empty bodies stay text */
    }
    return {
      status: response.status,
      body: body as T,
      headers: response.headers,
    };
  }
  async function enable(
    tenant: string,
    overrides: Partial<PortalSettings> = {},
  ) {
    const current = await call<PortalSettings>(
      `/tenants/${tenant}/portal-settings`,
      { auth: session(tenant) },
    );
    const saved = await call<PortalSettings>(
      `/tenants/${tenant}/portal-settings`,
      {
        method: 'PUT',
        auth: session(tenant),
        body: {
          enabled: true,
          title: 'Acme API',
          customDomain: null,
          apiBaseUrl: 'https://api.acme.test',
          signup: 'open',
          defaultGroups: ['partners'],
          maxKeysPerDeveloper: 2,
          ...Object.fromEntries(
            Object.entries(overrides).filter(
              ([key]) => !['revision', 'updatedAt'].includes(key),
            ),
          ),
          expectedRevision: current.body.revision,
        },
      },
    );
    expect(saved.status).toBe(200);
    return saved.body;
  }
  async function service(tenant: string) {
    const [row] = await db.query(
      `INSERT INTO ${tenantSchema(tenant)}.services (name,targets) VALUES ('users-api','[{"url":"https://users.internal.test","weight":100}]') RETURNING id`,
    );
    return row.id as string;
  }
  async function route(tenant: string, serviceId: string, body: object) {
    const created = await call<{ id: string }>(`/tenants/${tenant}/routes`, {
      method: 'POST',
      auth: session(tenant),
      body: { method: 'GET', serviceId, authRequired: true, ...body },
    });
    expect(created.status).toBe(201);
    return created.body.id;
  }
  async function developer(tenant: string, address = 'dev@example.test') {
    const registered = await call(`/portal/${tenant}/developers/register`, {
      method: 'POST',
      body: {
        email: address,
        name: 'Dana Dev',
        password: 'correct horse battery',
      },
    });
    expect(registered.status).toBe(202);
    const link = sent.at(-1)?.url ?? '';
    const token = new URL(link).searchParams.get('token');
    const verified = await call<PortalDeveloperSession>(
      `/portal/${tenant}/developers/verify`,
      { method: 'POST', body: { token } },
    );
    expect(verified.status).toBe(200);
    return verified.body;
  }

  it('saves settings with revisions, validation and unique custom domains', async () => {
    const tenant = await workspace('Bluebird');
    const other = await workspace('Other');
    const initial = await call<PortalSettings>(
      `/tenants/${tenant}/portal-settings`,
      { auth: session(tenant) },
    );
    expect(initial.body).toEqual({
      enabled: false,
      title: 'Bluebird API',
      customDomain: null,
      apiBaseUrl: null,
      signup: 'open',
      defaultGroups: [],
      maxKeysPerDeveloper: 5,
      revision: INITIAL_PORTAL_REVISION,
      updatedAt: null,
    });
    const saved = await enable(tenant, {
      customDomain: 'Portal.Example.TEST.',
    });
    expect(saved.customDomain).toBe('portal.example.test');
    expect(saved.revision).not.toBe(INITIAL_PORTAL_REVISION);
    const stale = await call(`/tenants/${tenant}/portal-settings`, {
      method: 'PUT',
      auth: session(tenant),
      body: {
        enabled: false,
        title: 'x',
        customDomain: null,
        apiBaseUrl: null,
        signup: 'open',
        defaultGroups: [],
        maxKeysPerDeveloper: 1,
        expectedRevision: INITIAL_PORTAL_REVISION,
      },
    });
    expect(stale.status).toBe(409);
    const taken = await call<PortalSettings>(
      `/tenants/${other}/portal-settings`,
      {
        auth: session(other),
      },
    );
    const duplicate = await call<{ message: string }>(
      `/tenants/${other}/portal-settings`,
      {
        method: 'PUT',
        auth: session(other),
        body: {
          enabled: true,
          title: 'Other',
          customDomain: 'portal.example.test',
          apiBaseUrl: null,
          signup: 'open',
          defaultGroups: [],
          maxKeysPerDeveloper: 1,
          expectedRevision: taken.body.revision,
        },
      },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.message).toContain('already uses');
    for (const invalid of [
      { customDomain: 'https://portal.example.test/x' },
      { title: '' },
      { signup: 'invite' },
      { defaultGroups: ['bad group'] },
      { maxKeysPerDeveloper: 26 },
      { apiBaseUrl: 'http://api.example.test' },
      { apiBaseUrl: 'https://user:pw@api.example.test' },
      { apiBaseUrl: 'https://api.example.test/?debug=1' },
      { extra: true },
    ])
      expect(
        (
          await call(`/tenants/${other}/portal-settings`, {
            method: 'PUT',
            auth: session(other),
            body: {
              enabled: true,
              title: 'Other',
              customDomain: null,
              apiBaseUrl: null,
              signup: 'open',
              defaultGroups: [],
              maxKeysPerDeveloper: 1,
              expectedRevision: taken.body.revision,
              ...invalid,
            },
          })
        ).status,
      ).toBe(400);
    expect(
      (await call('/portal/resolve?host=PORTAL.example.test')).body,
    ).toEqual({ tenantId: tenant });
    expect(
      (await call('/portal/resolve?host=unknown.example.test')).status,
    ).toBe(404);
    // Settings are workspace-session only.
    expect(
      (
        await call(`/tenants/${tenant}/portal-settings`, {
          auth: session(other),
        })
      ).status,
    ).toBe(403);
  });

  it('publishes only visible routes with derived auth and limits, never upstream details', async () => {
    const tenant = await workspace();
    const serviceId = await service(tenant);
    expect((await call(`/portal/${tenant}/catalog`)).status).toBe(404);
    const published = await route(tenant, serviceId, {
      pathPattern: '/users',
      plugins: [
        { name: 'rate-limit', config: { max: 30, windowMs: 1000 } },
        { name: 'acl', config: { allow: ['partners'] } },
        {
          name: 'oauth2-client-credentials',
          config: {
            tokenEndpoint: 'https://idp.example.test/token',
            clientId: 'gateway',
            clientSecret: 'never-publish-this-secret',
          },
        },
      ],
      portal: {
        visible: true,
        summary: 'List users',
        description: 'Returns users.\nPaginate with ?page.',
      },
    });
    await route(tenant, serviceId, {
      method: 'POST',
      pathPattern: '/users',
      authRequired: false,
      rateLimitOverride: 12,
      plugins: [
        {
          name: 'hmac-auth',
          config: {
            secrets: ['whsec_never_publish'],
            header: 'x-signature',
            algorithm: 'sha256',
          },
        },
      ],
      portal: { visible: true },
    });
    await route(tenant, serviceId, {
      pathPattern: '/internal',
      portal: { visible: false, summary: 'Hidden' },
    });
    await route(tenant, serviceId, { pathPattern: '/plain' });
    const disabled = await route(tenant, serviceId, {
      pathPattern: '/disabled',
      enabled: false,
      portal: { visible: true },
    });
    expect(disabled).toBeDefined();
    for (const portal of [
      { visible: 'yes' },
      { visible: true, summary: 'a\nb' },
      { visible: true, description: 'x'.repeat(4001) },
      { visible: true, html: '<b>' },
    ])
      expect(
        (
          await call(`/tenants/${tenant}/routes`, {
            method: 'POST',
            auth: session(tenant),
            body: { method: 'GET', pathPattern: '/bad', serviceId, portal },
          })
        ).status,
      ).toBe(400);
    const preview = await call<PortalCatalog>(
      `/tenants/${tenant}/portal/routes`,
      {
        auth: session(tenant),
      },
    );
    expect(preview.body.routes).toHaveLength(2);
    await enable(tenant);
    const catalog = await call<PortalCatalog>(`/portal/${tenant}/catalog`);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('cache-control')).toBe('public, max-age=30');
    expect(catalog.body).toEqual({
      tenantId: tenant,
      title: 'Acme API',
      apiBaseUrl: 'https://api.acme.test',
      signup: 'open',
      routes: [
        {
          id: published,
          method: 'GET',
          path: '/users',
          summary: 'List users',
          description: 'Returns users.\nPaginate with ?page.',
          auth: ['api-key'],
          rateLimit: { requests: 30, windowMs: 1000 },
          groupRestricted: true,
        },
        expect.objectContaining({
          method: 'POST',
          auth: ['hmac'],
          rateLimit: { requests: 12, windowMs: 60000 },
          groupRestricted: false,
          summary: null,
        }),
      ],
    });
    const text = JSON.stringify(catalog.body);
    for (const leak of [
      'users.internal.test',
      serviceId,
      'never-publish-this-secret',
      'whsec_never_publish',
      'Hidden',
    ])
      expect(text).not.toContain(leak);
    expect(
      (await call<{ path: string }>(`/portal/${tenant}/catalog/${published}`))
        .body.path,
    ).toBe('/users');
    expect((await call(`/portal/${tenant}/catalog/${disabled}`)).status).toBe(
      404,
    );
    // Unpublishing through a partial update removes the route from the catalog.
    await call(`/tenants/${tenant}/routes/${published}`, {
      method: 'PUT',
      auth: session(tenant),
      body: { portal: null },
    });
    expect(
      (await call<PortalCatalog>(`/portal/${tenant}/catalog`)).body.routes,
    ).toHaveLength(1);
    // Gateway payloads never carry portal metadata.
    const config = await push.assembleConfig(tenant, db);
    expect(JSON.stringify(config.routes)).not.toContain('portal');
  });

  it('registers, verifies and signs in developers without revealing accounts', async () => {
    const tenant = await workspace();
    expect(
      (
        await call(`/portal/${tenant}/developers/register`, {
          method: 'POST',
          body: {
            email: 'a@example.test',
            name: 'A',
            password: 'long enough pw',
          },
        })
      ).status,
    ).toBe(404);
    await enable(tenant, { customDomain: 'developers.acme.test' });
    const session1 = await developer(tenant, 'Dev@Example.test');
    expect(sent[0]).toEqual({
      to: 'dev@example.test',
      url: expect.stringMatching(
        /^https:\/\/developers\.acme\.test\/verify\?token=[a-f\d]{64}$/,
      ),
      title: 'Acme API',
    });
    expect(session1.developer.email).toBe('dev@example.test');
    const token = new URL(sent[0].url).searchParams.get('token');
    expect(
      (
        await call(`/portal/${tenant}/developers/verify`, {
          method: 'POST',
          body: { token },
        })
      ).status,
    ).toBe(400);
    // Registering an active address again is accepted but sends nothing.
    const again = await call(`/portal/${tenant}/developers/register`, {
      method: 'POST',
      body: {
        email: 'dev@example.test',
        name: 'Mallory',
        password: 'another password',
      },
    });
    expect(again.status).toBe(202);
    expect(sent).toHaveLength(1);
    const [stored] = await db.query(
      `SELECT password_hash,verify_token_hash FROM ${tenantSchema(tenant)}.portal_developers`,
    );
    expect(stored.password_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(stored.verify_token_hash).toBeNull();
    for (const body of [
      { email: 'not-an-email', name: 'x', password: 'long enough pw' },
      { email: 'b@example.test', name: 'x', password: 'short' },
      { email: 'b@example.test', name: 'x', password: 'é'.repeat(40) },
      { email: 'b@example.test', name: '', password: 'long enough pw' },
      {
        email: 'b@example.test',
        name: 'x',
        password: 'long enough pw',
        admin: true,
      },
    ])
      expect(
        (
          await call(`/portal/${tenant}/developers/register`, {
            method: 'POST',
            body,
          })
        ).status,
      ).toBe(400);
    const login = await call<PortalDeveloperSession>(
      `/portal/${tenant}/developers/login`,
      {
        method: 'POST',
        body: { email: 'DEV@example.test', password: 'correct horse battery' },
      },
    );
    expect(login.status).toBe(200);
    const unknown = await call<{ message: string }>(
      `/portal/${tenant}/developers/login`,
      {
        method: 'POST',
        body: {
          email: 'nobody@example.test',
          password: 'correct horse battery',
        },
      },
    );
    const wrong = await call<{ message: string }>(
      `/portal/${tenant}/developers/login`,
      {
        method: 'POST',
        body: { email: 'dev@example.test', password: 'wrong password!' },
      },
    );
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    // A pending account must confirm before signing in.
    await call(`/portal/${tenant}/developers/register`, {
      method: 'POST',
      body: {
        email: 'pending@example.test',
        name: 'P',
        password: 'pending password',
      },
    });
    expect(
      (
        await call(`/portal/${tenant}/developers/login`, {
          method: 'POST',
          body: { email: 'pending@example.test', password: 'pending password' },
        })
      ).status,
    ).toBe(403);
    // Closed signup refuses new registrations.
    await enable(tenant, {
      signup: 'closed',
      customDomain: 'developers.acme.test',
    });
    expect(
      (
        await call(`/portal/${tenant}/developers/register`, {
          method: 'POST',
          body: {
            email: 'late@example.test',
            name: 'L',
            password: 'late password!',
          },
        })
      ).status,
    ).toBe(403);
  });

  it('locks an account after ten failed sign-ins', async () => {
    const tenant = await workspace();
    await enable(tenant);
    await developer(tenant);
    for (let attempt = 0; attempt < 10; attempt++)
      await call(`/portal/${tenant}/developers/login`, {
        method: 'POST',
        body: { email: 'dev@example.test', password: `wrong ${attempt}` },
      });
    const locked = await call(`/portal/${tenant}/developers/login`, {
      method: 'POST',
      body: { email: 'dev@example.test', password: 'correct horse battery' },
    });
    expect(locked.status).toBe(401);
    await db.query(
      `UPDATE ${tenantSchema(tenant)}.portal_developers SET locked_until=clock_timestamp()-interval '1 second'`,
    );
    expect(
      (
        await call(`/portal/${tenant}/developers/login`, {
          method: 'POST',
          body: {
            email: 'dev@example.test',
            password: 'correct horse battery',
          },
        })
      ).status,
    ).toBe(200);
  });

  it('separates developer and workspace sessions in both directions', async () => {
    const tenant = await workspace();
    const other = await workspace();
    await enable(tenant);
    await enable(other);
    const dev = await developer(tenant);
    const bearer = `Bearer ${dev.token}`;
    expect((await call(`/portal/${tenant}/me`, { auth: bearer })).body).toEqual(
      dev.developer,
    );
    expect(
      (await call(`/tenants/${tenant}/routes`, { auth: bearer })).status,
    ).toBe(401);
    expect(
      (await call(`/portal/${tenant}/me`, { auth: session(tenant) })).status,
    ).toBe(401);
    expect((await call(`/portal/${other}/me`, { auth: bearer })).status).toBe(
      401,
    );
    // A session with the platform secret but the portal audience is still refused.
    const forged = sign({ tid: tenant, ver: 1 }, secret, {
      subject: dev.developer.id,
      audience: 'novagate-portal',
    });
    expect(
      (await call(`/portal/${tenant}/me`, { auth: `Bearer ${forged}` })).status,
    ).toBe(401);
    // Disabling the portal ends developer sessions.
    await enable(tenant, { enabled: false });
    expect((await call(`/portal/${tenant}/me`, { auth: bearer })).status).toBe(
      401,
    );
  });

  it('creates, limits, isolates and revokes developer keys through the gateway config', async () => {
    const tenant = await workspace();
    await enable(tenant);
    const first = await developer(tenant, 'first@example.test');
    const second = await developer(tenant, 'second@example.test');
    const auth = `Bearer ${first.token}`;
    const created = await call<CreatedPortalKey>(`/portal/${tenant}/me/keys`, {
      method: 'POST',
      auth,
      body: { name: 'Mobile app' },
    });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(
      new RegExp(`^gw_${tenant}_[a-f\\d]{64}$`),
    );
    expect(created.body.name).toBe('Mobile app');
    expect(publish).toHaveBeenCalledTimes(1);
    const config = await push.assembleConfig(tenant, db);
    const consumer = config.consumers.find((row) => row.id === created.body.id);
    expect(consumer).toMatchObject({
      name: 'Mobile app (portal: first@example.test)',
      groups: ['partners'],
    });
    expect(Object.keys(consumer ?? {})).not.toContain('portalDeveloperId');
    expect(Object.keys(consumer ?? {})).not.toContain('portalKeyName');
    expect(JSON.stringify(config)).not.toContain(created.body.apiKey);
    await call(`/portal/${tenant}/me/keys`, {
      method: 'POST',
      auth,
      body: { name: 'Server' },
    });
    const limited = await call(`/portal/${tenant}/me/keys`, {
      method: 'POST',
      auth,
      body: { name: 'Third' },
    });
    expect(limited.status).toBe(409);
    expect(
      (
        await call(`/portal/${tenant}/me/keys`, {
          method: 'POST',
          auth,
          body: { name: 'x', groups: ['admins'] },
        })
      ).status,
    ).toBe(400);
    const listed = await call<PortalKey[]>(`/portal/${tenant}/me/keys`, {
      auth,
    });
    expect(listed.body.map((key) => key.name).sort()).toEqual([
      'Mobile app',
      'Server',
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('gw_');
    const secondAuth = `Bearer ${second.token}`;
    expect(
      (
        await call<PortalKey[]>(`/portal/${tenant}/me/keys`, {
          auth: secondAuth,
        })
      ).body,
    ).toEqual([]);
    for (const path of [`/portal/${tenant}/me/keys/${created.body.id}/usage`])
      expect((await call(path, { auth: secondAuth })).status).toBe(404);
    expect(
      (
        await call(`/portal/${tenant}/me/keys/${created.body.id}`, {
          method: 'DELETE',
          auth: secondAuth,
        })
      ).status,
    ).toBe(404);
    const revoked = await call<PortalKey>(
      `/portal/${tenant}/me/keys/${created.body.id}`,
      { method: 'DELETE', auth },
    );
    expect(revoked.body.revokedAt).not.toBeNull();
    const repeated = await call<PortalKey>(
      `/portal/${tenant}/me/keys/${created.body.id}`,
      { method: 'DELETE', auth },
    );
    expect(repeated.body.revokedAt).toBe(revoked.body.revokedAt);
    const after = await push.assembleConfig(tenant, db);
    expect(after.consumers.some((row) => row.id === created.body.id)).toBe(
      false,
    );
    expect(
      (
        await call(`/portal/${tenant}/me/keys`, {
          method: 'POST',
          auth,
          body: { name: 'Replacement' },
        })
      ).status,
    ).toBe(201);
  });

  it('reports a key’s own recorded usage to its developer', async () => {
    const tenant = await workspace();
    await enable(tenant);
    const dev = await developer(tenant);
    const auth = `Bearer ${dev.token}`;
    const key = (
      await call<CreatedPortalKey>(`/portal/${tenant}/me/keys`, {
        method: 'POST',
        auth,
        body: { name: 'Mobile app' },
      })
    ).body;
    const schema = tenantSchema(tenant);
    for (const status of [200, 200, 503])
      await db.query(
        `INSERT INTO ${schema}.request_logs (id,"consumerId",method,path,"statusCode","responseTimeMs","requestId",timestamp)
         VALUES ($1,$2,'GET','/users',$3,20,$4,clock_timestamp() - interval '1 minute')`,
        [randomUUID(), key.id, status, randomUUID()],
      );
    const usage = await call<ConsumerUsageStats>(
      `/portal/${tenant}/me/keys/${key.id}/usage?period=1h`,
      { auth },
    );
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      consumer: { id: key.id, name: 'Mobile app' },
      requests: 3,
      serverErrors: 1,
    });
  });

  it('suspension revokes keys and ends sessions; reactivation restores sign-in only', async () => {
    const tenant = await workspace();
    await enable(tenant);
    const dev = await developer(tenant);
    const auth = `Bearer ${dev.token}`;
    const key = (
      await call<CreatedPortalKey>(`/portal/${tenant}/me/keys`, {
        method: 'POST',
        auth,
        body: { name: 'Mobile app' },
      })
    ).body;
    const list = await call<PortalDeveloper[]>(
      `/tenants/${tenant}/portal/developers`,
      { auth: session(tenant) },
    );
    expect(list.body).toEqual([
      expect.objectContaining({
        id: dev.developer.id,
        email: 'dev@example.test',
        status: 'active',
        activeKeys: 1,
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('$2');
    const suspended = await call(
      `/tenants/${tenant}/portal/developers/${dev.developer.id}`,
      { method: 'PUT', auth: session(tenant), body: { status: 'suspended' } },
    );
    expect(suspended.body).toEqual({ status: 'suspended', revokedKeys: 1 });
    expect((await call(`/portal/${tenant}/me`, { auth })).status).toBe(401);
    const config = await push.assembleConfig(tenant, db);
    expect(config.consumers.some((row) => row.id === key.id)).toBe(false);
    expect(
      (
        await call(`/portal/${tenant}/developers/login`, {
          method: 'POST',
          body: {
            email: 'dev@example.test',
            password: 'correct horse battery',
          },
        })
      ).status,
    ).toBe(403);
    await call(`/tenants/${tenant}/portal/developers/${dev.developer.id}`, {
      method: 'PUT',
      auth: session(tenant),
      body: { status: 'active' },
    });
    const login = await call<PortalDeveloperSession>(
      `/portal/${tenant}/developers/login`,
      {
        method: 'POST',
        body: { email: 'dev@example.test', password: 'correct horse battery' },
      },
    );
    expect(login.status).toBe(200);
    expect(
      (
        await call<PortalKey[]>(`/portal/${tenant}/me/keys`, {
          auth: `Bearer ${login.body.token}`,
        })
      ).body.every((entry) => entry.revokedAt !== null),
    ).toBe(true);
  });

  it('keeps developer keys out of declarative replacement and round-trips route portal metadata', async () => {
    const tenant = await workspace();
    await enable(tenant);
    const serviceId = await service(tenant);
    await route(tenant, serviceId, {
      pathPattern: '/users',
      portal: { visible: true, summary: 'List users' },
    });
    const dev = await developer(tenant);
    const key = (
      await call<CreatedPortalKey>(`/portal/${tenant}/me/keys`, {
        method: 'POST',
        auth: `Bearer ${dev.token}`,
        body: { name: 'Mobile app' },
      })
    ).body;
    const exported = await call<string>(`/tenants/${tenant}/export`, {
      auth: session(tenant),
    });
    const document = parse(exported.body);
    expect(document.consumers).toEqual([]);
    expect(document.routes[0].portal).toEqual({
      visible: true,
      summary: 'List users',
    });
    // An unchanged export previews as unchanged.
    const unchanged = await call<ConfigPreview>(`/tenants/${tenant}/import`, {
      method: 'POST',
      auth: session(tenant),
      type: 'application/yaml',
      body: exported.body,
    });
    expect(unchanged.body.changes).toEqual([]);
    // Removing the portal block is a visible change, and applying keeps the developer key.
    delete document.routes[0].portal;
    document.consumers.push({ name: 'ci-bot' });
    const edited = stringify(document);
    const preview = await call<ConfigPreview>(`/tenants/${tenant}/import`, {
      method: 'POST',
      auth: session(tenant),
      type: 'application/yaml',
      body: edited,
    });
    expect(preview.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'route',
          action: 'update',
          fields: ['portal'],
        }),
        expect.objectContaining({ resource: 'consumer', action: 'create' }),
      ]),
    );
    const applied = await fetch(
      `${base}/tenants/${tenant}/import?dryRun=false`,
      {
        method: 'POST',
        headers: {
          authorization: session(tenant),
          'content-type': 'application/yaml',
          'if-match': preview.body.revision,
        },
        body: edited,
      },
    );
    expect(applied.status).toBe(200);
    const [stillActive] = await db.query(
      `SELECT "revokedAt" FROM ${tenantSchema(tenant)}.consumers WHERE id=$1`,
      [key.id],
    );
    expect(stillActive.revokedAt).toBeNull();
    expect(
      (await call<PortalCatalog>(`/portal/${tenant}/catalog`)).body.routes,
    ).toEqual([]);
    const invalid = stringify({
      ...document,
      routes: [{ ...document.routes[0], portal: { visible: 'sure' } }],
    });
    expect(
      (
        await call(`/tenants/${tenant}/import`, {
          method: 'POST',
          auth: session(tenant),
          type: 'application/yaml',
          body: invalid,
        })
      ).status,
    ).toBe(400);
  });
});
