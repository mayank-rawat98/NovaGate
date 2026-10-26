import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { AlertRulesService } from './alert-rules.service';
import { AlertsController } from './alerts.controller';
import type {
  AlertChannel,
  AlertRule,
  AlertConfiguration,
} from '@api-gateway/shared-types';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const secret = 'alert-http-fixture-secret-at-least-32-characters';
integration('Authenticated alerts HTTP API with PostgreSQL', () => {
  let root: DataSource;
  let ds: DataSource;
  let app: INestApplication;
  let url: string;
  const tenant = randomUUID();
  const other = randomUUID();
  const database = `novagate_alert_http_${randomUUID().replaceAll('-', '')}`;
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const token = sign({}, secret, { subject: tenant, expiresIn: '1h' });
  let channel: AlertChannel;
  let rule: AlertRule;
  async function request(
    path = '',
    method = 'GET',
    body?: unknown,
    authorization = `Bearer ${token}`,
    workspace = tenant,
  ) {
    return fetch(`${url}/tenants/${workspace}/alerts${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = secret;
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL as string);
    databaseUrl.pathname = `/${database}`;
    ds = new DataSource({ type: 'postgres', url: databaseUrl.href });
    await ds.initialize();
    await ds.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    for (const id of [tenant, other]) {
      await ds.query(
        `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'HTTP fixture', $2, 'free')`,
        [id, `${id}@example.test`],
      );
      await new TenantProvisioningService(ds).provisionTenant(id);
    }
    await new MigrationService(ds).onModuleInit();
    const module = await Test.createTestingModule({
      controllers: [AlertsController],
      providers: [
        AlertRulesService,
        { provide: APP_GUARD, useClass: TenantAuthGuard },
        { provide: DataSource, useValue: ds },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ALERT_CHANNEL_KEYS: JSON.stringify({
              fixture: Buffer.alloc(32, 11).toString('base64'),
            }),
            ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
          }),
        },
      ],
    }).compile();
    app = module.createNestApplication({ forceCloseConnections: true });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    if (ds?.isInitialized) await ds.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
    if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousSecret;
  }, 30000);
  it('requires a bearer session and rejects foreign workspace access for every endpoint', async () => {
    for (const [path, method, body] of [
      ['', 'GET', undefined],
      ['/history', 'GET', undefined],
      ['/rules', 'POST', {}],
      [`/rules/${randomUUID()}`, 'PUT', {}],
      [`/rules/${randomUUID()}`, 'DELETE', { revision: 1 }],
      ['/channels', 'POST', {}],
      [`/channels/${randomUUID()}`, 'PUT', {}],
      [`/channels/${randomUUID()}`, 'DELETE', { revision: 1 }],
    ] as const) {
      expect((await request(path, method, body, '')).status).toBe(401);
      expect(
        (await request(path, method, body, `Bearer ${token}`, other)).status,
      ).toBe(403);
    }
    expect(
      (await request(`?token=${token}`, 'GET', undefined, '')).status,
    ).toBe(401);
    expect(
      (
        await request(
          '',
          'GET',
          undefined,
          `Bearer ${sign({}, secret, { subject: tenant, expiresIn: -1 })}`,
        )
      ).status,
    ).toBe(401);
  });
  it('creates a channel with private write credentials and returns redacted configuration', async () => {
    const response = await request('/channels', 'POST', {
      name: 'Operations',
      type: 'webhook',
      url: 'https://example.test/private-path?token=private-fixture',
      secret: 'fixture-signing-secret-at-least-32-bytes',
    });
    expect(response.status).toBe(201);
    channel = (await response.json()) as AlertChannel;
    expect(channel).toMatchObject({
      destination: 'https://example.test',
      hasSecret: true,
      revision: 1,
    });
    const read = (await (await request()).json()) as AlertConfiguration;
    expect(read).toMatchObject({
      rules: [],
      channels: [channel],
      deliveryEnabled: true,
    });
    expect(JSON.stringify(read)).not.toMatch(
      /private-path|private-fixture|signing-secret|ciphertext|credentials/,
    );
  });
  it('validates rules and references, then saves a typed rule with revision checks', async () => {
    const input = {
      name: 'Errors',
      metric: 'error_rate',
      operator: '>',
      threshold: 0.1,
      windowMinutes: 1,
      channelIds: [channel.id],
    };
    expect(
      (await request('/rules', 'POST', { ...input, tenantId: other })).status,
    ).toBe(400);
    expect(
      (
        await request('/rules', 'POST', {
          ...input,
          channelIds: [randomUUID()],
        })
      ).status,
    ).toBe(400);
    const response = await request('/rules', 'POST', input);
    expect(response.status).toBe(201);
    rule = (await response.json()) as AlertRule;
    expect(rule).toMatchObject({
      revision: 1,
      evaluation: null,
      enabled: true,
      minRequests: 1,
      channelIds: [channel.id],
    });
    const updated = await request(`/rules/${rule.id}`, 'PUT', {
      ...input,
      enabled: false,
      revision: 1,
    });
    expect(updated.status).toBe(200);
    rule = (await updated.json()) as AlertRule;
    expect(rule).toMatchObject({ enabled: false, revision: 2 });
    expect(
      (await request(`/rules/${rule.id}`, 'PUT', { ...input, revision: 1 }))
        .status,
    ).toBe(409);
    expect(await (await request('/history')).json()).toEqual([]);
  });
  it('edits channel metadata without exposing credentials and validates delete revisions', async () => {
    const update = await request(`/channels/${channel.id}`, 'PUT', {
      name: 'Renamed',
      enabled: false,
      revision: 1,
    });
    expect(update.status).toBe(200);
    channel = (await update.json()) as AlertChannel;
    expect(channel).toMatchObject({
      name: 'Renamed',
      enabled: false,
      revision: 2,
    });
    expect(
      (await request(`/channels/${channel.id}`, 'DELETE', { revision: 1 }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(`/channels/${channel.id}`, 'DELETE', {
          revision: 2,
          tenantId: other,
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`/channels/${channel.id}`, 'DELETE', { revision: '2' }))
        .status,
    ).toBe(400);
    expect(
      (await request(`/channels/${channel.id}`, 'DELETE', { revision: 2 }))
        .status,
    ).toBe(200);
    const read = (await (await request()).json()) as AlertConfiguration;
    expect(read.rules[0]).toMatchObject({
      id: rule.id,
      channelIds: [],
      revision: 3,
    });
    expect(
      (await request(`/rules/${rule.id}`, 'DELETE', { revision: 2 })).status,
    ).toBe(409);
    expect(
      (await request(`/rules/${rule.id}`, 'DELETE', { revision: 3 })).status,
    ).toBe(200);
    expect(
      (await request(`/rules/${rule.id}`, 'DELETE', { revision: 3 })).status,
    ).toBe(404);
  });
});
