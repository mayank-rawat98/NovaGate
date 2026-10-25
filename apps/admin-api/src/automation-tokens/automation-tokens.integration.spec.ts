import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import type {
  AutomationTokenSummary,
  CreatedAutomationToken,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { ServicesController } from '../proxy-config/services.controller';
import { RoutesController } from '../proxy-config/routes.controller';
import { ConfigImportController } from '../config-import/config-import.controller';
import { ConfigImportService } from '../config-import/config-import.service';
import { configureConfigImportParser } from '../config-import/config-import.body-parser';
import { AutomationTokensController } from './automation-tokens.controller';
import {
  AutomationTokensService,
  hashAutomationToken,
} from './automation-tokens.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Automation tokens on actual PostgreSQL and HTTP', () => {
  const secret = 'automation-token-fixture-secret-longer-than-32-chars';
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const database = `novagate_tokens_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
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
    const push = new ConfigPushService(db);
    const module = await Test.createTestingModule({
      controllers: [
        AutomationTokensController,
        ServicesController,
        RoutesController,
        ConfigImportController,
      ],
      providers: [
        AutomationTokensService,
        ConfigImportService,
        { provide: DataSource, useValue: db },
        {
          provide: ConfigPushService,
          useValue: {
            persistUpdate: push.persistUpdate.bind(push),
            publish: jest.fn().mockResolvedValue(false),
            triggerUpdate: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication({
      logger: ['error'],
      forceCloseConnections: true,
    });
    configureConfigImportParser(app);
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  }, 30000);

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) {
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      await db.query(`DELETE FROM public.api_keys WHERE "tenantId"=$1`, [
        tenant,
      ]);
      await db.query(
        `DELETE FROM public.pending_config_updates WHERE "tenantId"=$1`,
        [tenant],
      );
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

  async function workspace() {
    const tenant = randomUUID();
    tenants.push(tenant);
    await db.query(
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Token fixture',$2,'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    return tenant;
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  function call(
    path: string,
    authorization: string,
    init: { method?: string; body?: unknown; type?: string } = {},
  ) {
    return fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization,
        ...(init.body === undefined
          ? {}
          : { 'content-type': init.type ?? 'application/json' }),
      },
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
    });
  }
  async function mint(
    tenant: string,
    scopes: string[],
    extra: Record<string, unknown> = {},
  ) {
    const response = await call(
      `/tenants/${tenant}/automation-tokens`,
      session(tenant),
      { method: 'POST', body: { name: 'CI deploy', scopes, ...extra } },
    );
    expect(response.status).toBe(201);
    return (await response.json()) as CreatedAutomationToken;
  }
  const service = {
    name: 'users-api',
    targets: [{ url: 'https://users.example.test', weight: 100 }],
  };

  it('returns the secret once and stores only its digest', async () => {
    const tenant = await workspace();
    const created = await mint(tenant, ['routes:read', 'config:read'], {
      expiresInDays: 30,
    });
    expect(created.token).toMatch(/^ngat_[A-Za-z0-9_-]{43}$/);
    expect(created.scopes).toEqual(['config:read', 'routes:read']);
    expect(created.displayPrefix).toBe(created.token.slice(0, 11));
    const days =
      (Date.parse(created.expiresAt) - Date.parse(created.createdAt)) /
      86400000;
    expect(days).toBeCloseTo(30, 3);
    const [row] = await db.query(
      `SELECT token_hash FROM public.automation_tokens WHERE id=$1`,
      [created.id],
    );
    expect(row.token_hash).toBe(hashAutomationToken(created.token));
    const listing = await call(
      `/tenants/${tenant}/automation-tokens`,
      session(tenant),
    );
    expect(listing.headers.get('cache-control')).toBe('no-store');
    const text = await listing.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(row.token_hash);
    const [summary] = JSON.parse(text) as AutomationTokenSummary[];
    expect(summary).toEqual({
      id: created.id,
      name: 'CI deploy',
      scopes: ['config:read', 'routes:read'],
      displayPrefix: created.displayPrefix,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it('enforces scopes, write-implies-read and session-only endpoints', async () => {
    const tenant = await workspace();
    const reader = `Bearer ${(await mint(tenant, ['services:read'])).token}`;
    const writer = `Bearer ${(await mint(tenant, ['services:write'])).token}`;
    expect((await call(`/tenants/${tenant}/services`, reader)).status).toBe(
      200,
    );
    const denied = await call(`/tenants/${tenant}/services`, reader, {
      method: 'POST',
      body: service,
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { message: string }).message).toBe(
      'This token needs the services:write scope',
    );
    expect((await call(`/tenants/${tenant}/routes`, reader)).status).toBe(403);
    const created = await call(`/tenants/${tenant}/services`, writer, {
      method: 'POST',
      body: service,
    });
    expect(created.status).toBe(201);
    const listed = await call(`/tenants/${tenant}/services`, writer);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      expect.objectContaining({ name: 'users-api' }),
    ]);
    // Tokens cannot mint, list or revoke tokens, whatever their scopes.
    for (const method of ['GET', 'POST'])
      expect(
        (
          await call(`/tenants/${tenant}/automation-tokens`, writer, {
            method,
            body:
              method === 'POST'
                ? { name: 'escalate', scopes: ['routes:write'] }
                : undefined,
          })
        ).status,
      ).toBe(403);
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM public.automation_tokens WHERE tenant_id=$1`,
            [tenant],
          )
        )[0].count,
      ),
    ).toBe(2);
  });

  it('allows write-free previews with read scope but applies only with write', async () => {
    const tenant = await workspace();
    const reader = `Bearer ${(await mint(tenant, ['config:read'])).token}`;
    const writer = `Bearer ${(await mint(tenant, ['config:write'])).token}`;
    const exported = await call(`/tenants/${tenant}/export`, reader);
    expect(exported.status).toBe(200);
    const document = await exported.text();
    const preview = await call(`/tenants/${tenant}/import`, reader, {
      method: 'POST',
      body: document,
      type: 'application/yaml',
    });
    expect(preview.status).toBe(200);
    const { revision } = (await preview.json()) as { revision: string };
    const apply = (authorization: string) =>
      fetch(`${base}/tenants/${tenant}/import?dryRun=false`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/yaml',
          'if-match': revision,
        },
        body: document,
      });
    expect((await apply(reader)).status).toBe(403);
    expect((await apply(writer)).status).toBe(200);
  });

  it('rejects other workspaces, revoked, expired and unknown tokens', async () => {
    const tenant = await workspace();
    const other = await workspace();
    const token = await mint(tenant, ['services:read']);
    const bearer = `Bearer ${token.token}`;
    expect((await call(`/tenants/${other}/services`, bearer)).status).toBe(403);
    expect(
      (
        await call(
          `/tenants/${tenant}/services`,
          `Bearer ngat_${'A'.repeat(43)}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await call(`/tenants/${tenant}/services`, 'Bearer ngat_short')).status,
    ).toBe(401);
    // Another workspace's session cannot revoke this token.
    expect(
      (
        await call(
          `/tenants/${other}/automation-tokens/${token.id}`,
          session(other),
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(404);
    expect((await call(`/tenants/${tenant}/services`, bearer)).status).toBe(
      200,
    );
    const revoked = await call(
      `/tenants/${tenant}/automation-tokens/${token.id}`,
      session(tenant),
      { method: 'DELETE' },
    );
    expect(revoked.status).toBe(200);
    const first = (await revoked.json()) as AutomationTokenSummary;
    expect(first.revokedAt).not.toBeNull();
    const again = await call(
      `/tenants/${tenant}/automation-tokens/${token.id}`,
      session(tenant),
      { method: 'DELETE' },
    );
    expect(((await again.json()) as AutomationTokenSummary).revokedAt).toBe(
      first.revokedAt,
    );
    const rejected = await call(`/tenants/${tenant}/services`, bearer);
    expect(rejected.status).toBe(401);
    expect(((await rejected.json()) as { message: string }).message).toBe(
      'Token is invalid, expired or revoked',
    );
    const expiring = await mint(tenant, ['services:read']);
    await db.query(
      `UPDATE public.automation_tokens SET expires_at=clock_timestamp() - interval '1 second' WHERE id=$1`,
      [expiring.id],
    );
    expect(
      (await call(`/tenants/${tenant}/services`, `Bearer ${expiring.token}`))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          `/tenants/${tenant}/automation-tokens/${randomUUID()}`,
          session(tenant),
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(404);
  });

  it('records last use at most once per minute', async () => {
    const tenant = await workspace();
    const token = await mint(tenant, ['services:read']);
    const bearer = `Bearer ${token.token}`;
    await call(`/tenants/${tenant}/services`, bearer);
    const [first] = await db.query(
      `SELECT last_used_at FROM public.automation_tokens WHERE id=$1`,
      [token.id],
    );
    expect(first.last_used_at).not.toBeNull();
    await call(`/tenants/${tenant}/services`, bearer);
    const [second] = await db.query(
      `SELECT last_used_at FROM public.automation_tokens WHERE id=$1`,
      [token.id],
    );
    expect(second.last_used_at).toEqual(first.last_used_at);
    await db.query(
      `UPDATE public.automation_tokens SET last_used_at=last_used_at - interval '2 minutes' WHERE id=$1`,
      [token.id],
    );
    await call(`/tenants/${tenant}/services`, bearer);
    const [third] = await db.query(
      `SELECT last_used_at FROM public.automation_tokens WHERE id=$1`,
      [token.id],
    );
    expect(third.last_used_at.getTime()).toBeGreaterThan(
      first.last_used_at.getTime() - 120000,
    );
  });

  it.each([
    [{ name: 'x', scopes: [] }],
    [{ name: 'x', scopes: ['routes:admin'] }],
    [{ name: 'x', scopes: ['routes:read', 'routes:read'] }],
    [{ name: '', scopes: ['routes:read'] }],
    [{ name: 'bad\u001bname', scopes: ['routes:read'] }],
    [{ name: 'x'.repeat(65), scopes: ['routes:read'] }],
    [{ name: 'x', scopes: ['routes:read'], expiresInDays: 0 }],
    [{ name: 'x', scopes: ['routes:read'], expiresInDays: 366 }],
    [{ name: 'x', scopes: ['routes:read'], expiresInDays: 1.5 }],
    [{ name: 'x', scopes: ['routes:read'], tenantId: 'elsewhere' }],
    [['routes:read']],
  ])('rejects invalid creation input %j', async (body) => {
    const tenant = await workspace();
    const response = await call(
      `/tenants/${tenant}/automation-tokens`,
      session(tenant),
      { method: 'POST', body },
    );
    expect(response.status).toBe(400);
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM public.automation_tokens WHERE tenant_id=$1`,
          [tenant],
        )
      )[0].n,
    ).toBe(0);
  });

  it('holds the active token limit under concurrent creation', async () => {
    const tenant = await workspace();
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        call(`/tenants/${tenant}/automation-tokens`, session(tenant), {
          method: 'POST',
          body: { name: `runner ${index}`, scopes: ['routes:read'] },
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    // Admission may also shed load with 503; the limit must never be exceeded.
    expect(
      statuses.filter((status) => status === 201).length,
    ).toBeLessThanOrEqual(50);
    expect(statuses.every((status) => [201, 409, 503].includes(status))).toBe(
      true,
    );
    for (;;) {
      const response = await call(
        `/tenants/${tenant}/automation-tokens`,
        session(tenant),
        { method: 'POST', body: { name: 'fill', scopes: ['routes:read'] } },
      );
      if (response.status === 409) break;
      expect(response.status).toBe(201);
    }
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM public.automation_tokens WHERE tenant_id=$1 AND revoked_at IS NULL`,
      [tenant],
    );
    expect(n).toBe(50);
    const [victim] = await db.query(
      `SELECT id FROM public.automation_tokens WHERE tenant_id=$1 LIMIT 1`,
      [tenant],
    );
    await call(
      `/tenants/${tenant}/automation-tokens/${victim.id}`,
      session(tenant),
      { method: 'DELETE' },
    );
    expect((await mint(tenant, ['routes:read'])).token).toBeDefined();
  });

  it('removes tokens with their workspace', async () => {
    const tenant = await workspace();
    await mint(tenant, ['routes:read']);
    await db.query(`DROP SCHEMA ${tenantSchema(tenant)} CASCADE`);
    await db.query(`DELETE FROM public.api_keys WHERE "tenantId"=$1`, [tenant]);
    await db.query(
      `DELETE FROM public.pending_config_updates WHERE "tenantId"=$1`,
      [tenant],
    );
    await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM public.automation_tokens WHERE tenant_id=$1`,
          [tenant],
        )
      )[0].n,
    ).toBe(0);
  });
});
