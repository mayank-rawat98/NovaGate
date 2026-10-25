import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import {
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerSnapshot,
  type ConfigPreview,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { ServicesController } from '../proxy-config/services.controller';
import { ConfigImportController } from '../config-import/config-import.controller';
import { ConfigImportService } from '../config-import/config-import.service';
import { configureConfigImportParser } from '../config-import/config-import.body-parser';
import { CircuitBreakersController } from './circuit-breakers.controller';
import { CircuitBreakersService } from './circuit-breakers.service';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
integration('Circuit breakers on actual PostgreSQL, Redis and HTTP', () => {
  const secret = 'circuit-breakers-fixture-secret-longer-than-32-chars';
  const previous = {
    secret: process.env.PLATFORM_JWT_SECRET,
    redis: process.env.REDIS_URL,
  };
  const database = `novagate_circuits_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let redis: Redis;
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
    redis = new Redis(process.env.TEST_REDIS_URL as string);
    const module = await Test.createTestingModule({
      controllers: [
        ServicesController,
        ConfigImportController,
        CircuitBreakersController,
      ],
      providers: [
        ConfigImportService,
        CircuitBreakersService,
        ConfigPushService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ REDIS_URL: process.env.REDIS_URL }),
        },
        { provide: DataSource, useValue: db },
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
      await redis.del(`gw:circuits:${tenant}`);
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      for (const statement of [
        'DELETE FROM public.api_keys WHERE "tenantId"=$1',
        'DELETE FROM public.pending_config_updates WHERE "tenantId"=$1',
        'DELETE FROM public.tenants WHERE id=$1',
      ])
        await db.query(statement, [tenant]);
    }
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
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
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Circuit fixture',$2,'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    return tenant;
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  async function call<T = unknown>(
    tenant: string,
    path: string,
    init: { method?: string; body?: unknown; type?: string } = {},
  ) {
    const response = await fetch(`${base}/tenants/${tenant}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: session(tenant),
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
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // YAML stays text.
    }
    return { status: response.status, body: body as T };
  }
  const targets = [{ url: 'https://users.example.test', weight: 100 }];
  const published = async (tenant: string) =>
    (
      await db.query(
        `SELECT config FROM public.pending_config_updates WHERE "tenantId"=$1`,
        [tenant],
      )
    )[0].config.config;

  it('defaults new services to the breaker and validates explicit settings', async () => {
    const tenant = await workspace();
    const created = await call<{ id: string; circuitBreaker: unknown }>(
      tenant,
      '/services',
      { method: 'POST', body: { name: 'users', targets } },
    );
    expect(created.status).toBe(201);
    expect(created.body.circuitBreaker).toEqual(DEFAULT_CIRCUIT_BREAKER);
    expect((await published(tenant)).services[0].circuitBreaker).toEqual(
      DEFAULT_CIRCUIT_BREAKER,
    );
    const custom = { ...DEFAULT_CIRCUIT_BREAKER, windowSize: 40, openMs: 5000 };
    const updated = await call<{ circuitBreaker: unknown; name: string }>(
      tenant,
      `/services/${created.body.id}`,
      { method: 'PUT', body: { circuitBreaker: custom } },
    );
    expect(updated.body.circuitBreaker).toEqual(custom);
    // Omitting the field keeps it.
    const renamed = await call<{ circuitBreaker: unknown }>(
      tenant,
      `/services/${created.body.id}`,
      { method: 'PUT', body: { name: 'users-v2' } },
    );
    expect(renamed.body.circuitBreaker).toEqual(custom);
    const cleared = await call<{ circuitBreaker: unknown }>(
      tenant,
      `/services/${created.body.id}`,
      { method: 'PUT', body: { circuitBreaker: null } },
    );
    expect(cleared.body.circuitBreaker).toBeNull();
    expect((await published(tenant)).services[0].circuitBreaker).toBeNull();
    const optedOut = await call<{ circuitBreaker: unknown }>(
      tenant,
      '/services',
      {
        method: 'POST',
        body: { name: 'legacy', targets, circuitBreaker: null },
      },
    );
    expect(optedOut.body.circuitBreaker).toBeNull();
    for (const invalid of [
      { ...DEFAULT_CIRCUIT_BREAKER, windowSize: 4 },
      { ...DEFAULT_CIRCUIT_BREAKER, failureRatePercent: 100 },
      { ...DEFAULT_CIRCUIT_BREAKER, minimumRequests: 30 },
      { ...DEFAULT_CIRCUIT_BREAKER, openMs: 500 },
      { ...DEFAULT_CIRCUIT_BREAKER, enabled: 'yes' },
      { ...DEFAULT_CIRCUIT_BREAKER, extra: 1 },
      { enabled: true },
      'on',
    ])
      expect(
        (
          await call(tenant, '/services', {
            method: 'POST',
            body: {
              name: `bad-${randomUUID()}`,
              targets,
              circuitBreaker: invalid,
            },
          })
        ).status,
      ).toBe(400);
  });

  it('round-trips breakers through declarative configuration', async () => {
    const tenant = await workspace();
    await call(tenant, '/services', {
      method: 'POST',
      body: { name: 'users', targets },
    });
    const exported = await call<string>(tenant, '/export');
    expect(exported.body).toContain('circuitBreaker:');
    const same = await call<ConfigPreview>(tenant, '/import', {
      method: 'POST',
      body: exported.body,
      type: 'application/yaml',
    });
    expect(same.body.changes).toEqual([]);
    // A document without the field asks for no breaker, and says so.
    const legacy = await call<ConfigPreview>(tenant, '/import', {
      method: 'POST',
      body: {
        version: 1,
        services: [{ name: 'users', targets }],
        routes: [],
        consumers: [],
      },
    });
    expect(legacy.body.changes).toEqual([
      expect.objectContaining({
        resource: 'service',
        action: 'update',
        fields: ['circuitBreaker'],
      }),
    ]);
  });

  it('serves the reported snapshot and streams live changes', async () => {
    const tenant = await workspace();
    const empty = await call<CircuitBreakerSnapshot>(
      tenant,
      '/circuit-breakers',
    );
    expect(empty.body).toEqual({ reportedAt: null, services: [] });
    const open = {
      serviceId: randomUUID(),
      state: 'open',
      requests: 5,
      failures: 3,
      changedAt: new Date().toISOString(),
      nextProbeAt: new Date(Date.now() + 10000).toISOString(),
    };
    const stored = { reportedAt: new Date().toISOString(), services: [open] };
    await redis.set(`gw:circuits:${tenant}`, JSON.stringify(stored), 'EX', 60);
    expect(
      (await call<CircuitBreakerSnapshot>(tenant, '/circuit-breakers')).body,
    ).toEqual(stored);
    await redis.set(`gw:circuits:${tenant}`, '{"bad":', 'EX', 60);
    expect(
      (await call<CircuitBreakerSnapshot>(tenant, '/circuit-breakers')).body,
    ).toEqual({ reportedAt: null, services: [] });
    await redis.set(`gw:circuits:${tenant}`, JSON.stringify(stored), 'EX', 60);

    const abort = new AbortController();
    const response = await fetch(
      `${base}/tenants/${tenant}/circuit-breakers/stream`,
      {
        headers: { authorization: session(tenant) },
        signal: abort.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextFrame = async () => {
      for (;;) {
        const match = buffer.match(/event: circuits\ndata: (.*)\n\n/);
        if (match) {
          buffer = buffer.slice((match.index ?? 0) + match[0].length);
          return JSON.parse(match[1]) as CircuitBreakerSnapshot;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    try {
      expect(await nextFrame()).toEqual(stored);
      // Another workspace's channel and malformed publications are not relayed.
      await redis.publish(`circuits:${randomUUID()}`, JSON.stringify(stored));
      await redis.publish(`circuits:${tenant}`, 'not json');
      const closed = {
        reportedAt: new Date().toISOString(),
        services: [{ ...open, state: 'closed', nextProbeAt: null }],
      };
      await redis.publish(`circuits:${tenant}`, JSON.stringify(closed));
      expect(await nextFrame()).toEqual(closed);
    } finally {
      abort.abort();
    }
    // Other workspaces cannot open this stream.
    const other = await workspace();
    const denied = await fetch(
      `${base}/tenants/${tenant}/circuit-breakers/stream`,
      {
        headers: { authorization: session(other) },
      },
    );
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
  });
});
