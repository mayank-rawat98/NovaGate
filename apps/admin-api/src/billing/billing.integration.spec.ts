import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import {
  nextMonthStart,
  usageMonth,
  type BillingOverview,
  type ConsumerQuotaUsage,
  type TenantConfig,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { ConsumersController } from '../proxy-config/consumers.controller';
import { RoutesController } from '../proxy-config/routes.controller';
import { ServicesController } from '../proxy-config/services.controller';
import { LogRetentionService } from '../log-retention/log-retention.service';
import {
  BillingController,
  StripeWebhookController,
} from './billing.controller';
import { BillingService } from './billing.service';
import { StripeService, verifyStripeSignature } from './stripe.service';

const WEBHOOK_SECRET = 'whsec_billingFixtureSecret0123';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;
integration('Quotas and billing on actual PostgreSQL, Redis and HTTP', () => {
  const secret = 'billing-fixture-secret-longer-than-32-characters';
  const previous = {
    secret: process.env.PLATFORM_JWT_SECRET,
    redis: process.env.REDIS_URL,
  };
  const database = `novagate_billing_${randomUUID().replaceAll('-', '')}`;
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let push: ConfigPushService, billing: BillingService, redis: Redis;
  let subscriber: Redis, stripe: http.Server;
  const stripeRequests: Array<{
    authorization?: string;
    form: URLSearchParams;
  }> = [];
  const published: Array<{
    tenantId: string;
    config: TenantConfig;
    version: number;
  }> = [];
  const tenants: string[] = [];

  const settings = (overrides: Record<string, string> = {}) =>
    new ConfigService({
      BILLING_QUOTAS_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_billingFixture',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_PRICES: JSON.stringify({ pro: 'price_proFixture' }),
      STRIPE_API_BASE: `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`,
      DASHBOARD_URL: 'https://app.example.test',
      BILLING_ENFORCEMENT_INTERVAL_MS: '3600000',
      ...overrides,
    });

  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = secret;
    process.env.REDIS_URL = process.env.TEST_REDIS_URL;
    stripe = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        stripeRequests.push({
          authorization: req.headers.authorization,
          form: new URLSearchParams(body),
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ url: 'https://checkout.stripe.test/c/pay/cs_1' }),
        );
      });
    });
    await new Promise<void>((done) => stripe.listen(0, '127.0.0.1', done));
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
        BillingController,
        StripeWebhookController,
        ConsumersController,
        RoutesController,
        ServicesController,
      ],
      providers: [
        BillingService,
        StripeService,
        { provide: ConfigService, useValue: settings() },
        { provide: DataSource, useValue: db },
        { provide: ConfigPushService, useValue: push },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    billing = module.get(BillingService);
    app = module.createNestApplication({
      logger: ['error'],
      forceCloseConnections: true,
      rawBody: true,
    });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  }, 30000);

  afterEach(async () => {
    for (const tenant of tenants.splice(0)) {
      await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`);
      for (const statement of [
        'DELETE FROM public.api_keys WHERE "tenantId"=$1',
        'DELETE FROM public.pending_config_updates WHERE "tenantId"=$1',
      ])
        await db.query(statement, [tenant]);
      await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
    }
    published.splice(0);
    stripeRequests.splice(0);
  });

  afterAll(async () => {
    await app?.close();
    await push?.onModuleDestroy();
    subscriber?.disconnect();
    redis?.disconnect();
    stripe?.close();
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
      `INSERT INTO public.tenants(id,name,email,"planId") VALUES($1,'Billing fixture',$2,'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    return tenant;
  }
  /** Publications arrive asynchronously through Redis. */
  async function delivered(count: number) {
    const deadline = Date.now() + 5000;
    while (published.length < count && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 20));
    // Leave time for an unexpected extra publication to show up.
    await new Promise((done) => setTimeout(done, 100));
    expect(published).toHaveLength(count);
  }
  const session = (tenant: string) => `Bearer ${sign({ sub: tenant }, secret)}`;
  async function call<T = unknown>(
    path: string,
    authorization: string | undefined,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(init.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
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
      // Plain text stays text.
    }
    return { status: response.status, body: body as T };
  }
  async function meter(
    tenant: string,
    requests: number,
    consumers: Array<[string, number]> = [],
  ) {
    const month = usageMonth(new Date());
    const source = randomUUID();
    await db.query(
      `INSERT INTO public.usage_meters ("tenantId",month,source,requests) VALUES ($1,$2,$3,$4)`,
      [tenant, month, source, requests],
    );
    for (const [consumerId, count] of consumers)
      await db.query(
        `INSERT INTO public.consumer_usage_meters ("tenantId",month,source,"consumerId",requests) VALUES ($1,$2,$3,$4,$5)`,
        [tenant, month, source, consumerId, count],
      );
  }
  function webhook(event: unknown, signingSecret = WEBHOOK_SECRET) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', signingSecret)
      .update(`${t}.${body}`)
      .digest('hex');
    return call<{ received: boolean; duplicate?: boolean }>(
      '/billing/stripe/webhook',
      undefined,
      {
        method: 'POST',
        body,
        headers: { 'stripe-signature': `t=${t},v1=${v1}` },
      },
    );
  }
  const consumer = (
    tenant: string,
    name: string,
    monthlyQuota?: number | null,
  ) =>
    call<{ id: string; monthlyQuota: number | null; apiKey: string }>(
      `/tenants/${tenant}/consumers`,
      session(tenant),
      {
        method: 'POST',
        body: { name, ...(monthlyQuota === undefined ? {} : { monthlyQuota }) },
      },
    );

  it('reports plan usage, summed meters and consumer quotas', async () => {
    const tenant = await workspace();
    const mobile = await consumer(tenant, 'mobile', 1000);
    expect(mobile.status).toBe(201);
    expect(mobile.body.monthlyQuota).toBe(1000);
    const web = await consumer(tenant, 'web');
    // Two gateways (sources) count separately and are summed.
    await meter(tenant, 600, [[mobile.body.id, 450]]);
    await meter(tenant, 400, [[mobile.body.id, 400]]);
    const overview = await call<BillingOverview>(
      `/tenants/${tenant}/billing`,
      session(tenant),
    );
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      plan: { id: 'free', requestsPerMonth: 100000, purchasable: false },
      month: usageMonth(new Date()),
      resetsAt: nextMonthStart(new Date()).toISOString(),
      requests: { used: 1000, limit: 100000, percent: 1 },
      consumers: { used: 2, limit: 5, percent: 40 },
      routes: { used: 0, limit: 10, percent: 0 },
      logRetentionDays: { configured: 30, max: 30 },
      suspended: null,
      quotasEnforced: true,
      checkoutAvailable: true,
    });
    expect(
      overview.body.plans.map((plan) => [plan.id, plan.purchasable]),
    ).toEqual([
      ['free', false],
      ['pro', true],
      ['enterprise', false],
    ]);
    const quotas = await call<ConsumerQuotaUsage[]>(
      `/tenants/${tenant}/billing/consumer-quotas`,
      session(tenant),
    );
    expect(quotas.body).toEqual([
      expect.objectContaining({
        consumerId: mobile.body.id,
        requests: 850,
        monthlyQuota: 1000,
        percent: 85,
      }),
      expect.objectContaining({
        consumerId: web.body.id,
        requests: 0,
        monthlyQuota: null,
        percent: null,
      }),
    ]);
    // The quota reaches the gateway configuration.
    const config = await push.assembleConfig(tenant);
    expect(
      config.consumers.find((c) => c.id === mobile.body.id)?.monthlyQuota,
    ).toBe(1000);
    // Other workspaces cannot read it.
    const other = await workspace();
    expect(
      (await call(`/tenants/${tenant}/billing`, session(other))).status,
    ).toBe(403);
  });

  it('refuses growth past plan caps, including concurrent creation', async () => {
    const tenant = await workspace();
    for (let i = 0; i < 3; i++)
      expect((await consumer(tenant, `c${i}`)).status).toBe(201);
    const racing = await Promise.all(
      [0, 1, 2, 3].map((i) => consumer(tenant, `race${i}`)),
    );
    expect(racing.map((r) => r.status).sort()).toEqual([201, 201, 402, 402]);
    expect(racing.find((r) => r.status === 402)?.body).toMatchObject({
      error: 'PLAN_LIMIT',
    });
    const [{ count }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${tenantSchema(tenant)}.consumers WHERE "revokedAt" IS NULL`,
    );
    expect(count).toBe(5);
    const service = await call<{ id: string }>(
      `/tenants/${tenant}/services`,
      session(tenant),
      {
        method: 'POST',
        body: {
          name: 'api',
          targets: [{ url: 'http://127.0.0.1:9', weight: 1 }],
        },
      },
    );
    expect(service.status).toBe(201);
    const route = (i: number) =>
      call(`/tenants/${tenant}/routes`, session(tenant), {
        method: 'POST',
        body: {
          method: 'GET',
          pathPattern: `/r${i}`,
          serviceId: service.body.id,
        },
      });
    for (let i = 0; i < 10; i++) expect((await route(i)).status).toBe(201);
    expect((await route(10)).status).toBe(402);
    // Log retention is bounded by the plan.
    const retention = new LogRetentionService(db, billing);
    const state = await retention.get(tenant);
    await expect(
      retention.save(tenant, { days: 60, expectedRevision: state.revision }),
    ).rejects.toMatchObject({ status: 402 });
    // Upgrading lifts the caps.
    await db.transaction((manager) =>
      billing.applyPlan(manager, tenant, 'pro'),
    );
    expect((await consumer(tenant, 'after-upgrade')).status).toBe(201);
    expect((await route(10)).status).toBe(201);
    await expect(
      retention.save(tenant, { days: 60, expectedRevision: state.revision }),
    ).resolves.toMatchObject({ days: 60 });
  });

  it('suspends an exhausted workspace until the monthly reset and lifts it on a signed upgrade', async () => {
    const tenant = await workspace();
    await meter(tenant, 99999);
    await billing.enforce();
    await delivered(0);
    await meter(tenant, 1);
    await billing.enforce();
    const until = nextMonthStart(new Date()).toISOString();
    await delivered(1);
    expect(published[0].config.suspended).toEqual({
      reason: 'QUOTA_EXCEEDED',
      until,
    });
    const overview = await call<BillingOverview>(
      `/tenants/${tenant}/billing`,
      session(tenant),
    );
    expect(overview.body.suspended).toEqual({
      reason: 'QUOTA_EXCEEDED',
      until,
    });
    expect(overview.body.requests.percent).toBe(100);
    // Stable: another pass publishes nothing.
    await billing.enforce();
    await delivered(1);

    // Webhooks need Stripe's signature, not a session.
    const event = {
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_fixture',
          status: 'complete',
          customer: 'cus_fixture',
          subscription: 'sub_fixture',
          metadata: { tenantId: tenant, planId: 'pro' },
        },
      },
    };
    expect((await webhook(event, 'whsec_wrongSecret00000')).status).toBe(400);
    expect(
      (
        await call('/billing/stripe/webhook', undefined, {
          method: 'POST',
          body: event,
        })
      ).status,
    ).toBe(400);
    const accepted = await webhook(event);
    expect(accepted).toEqual({ status: 200, body: { received: true } });
    await delivered(2);
    expect(published[1].config.suspended).toBeNull();
    const [row] = await db.query(
      `SELECT "planId","quotaSuspendedUntil","stripeCustomerId","stripeSubscriptionId" FROM public.tenants WHERE id=$1`,
      [tenant],
    );
    expect(row).toEqual({
      planId: 'pro',
      quotaSuspendedUntil: null,
      stripeCustomerId: 'cus_fixture',
      stripeSubscriptionId: 'sub_fixture',
    });
    // Stripe retries deliver the same event again: applied once.
    expect((await webhook(event)).body).toEqual({
      received: true,
      duplicate: true,
    });
    await delivered(2);

    // Cancelling returns to the free plan, found by subscription ID.
    const cancelled = await webhook({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_fixture', status: 'canceled', metadata: {} } },
    });
    expect(cancelled.status).toBe(200);
    const [after] = await db.query(
      `SELECT "planId","quotaSuspendedUntil","stripeSubscriptionId" FROM public.tenants WHERE id=$1`,
      [tenant],
    );
    expect(after.planId).toBe('free');
    expect(after.stripeSubscriptionId).toBeNull();
    expect(after.quotaSuspendedUntil?.toISOString()).toBe(until);
    await delivered(3);
    expect(published.at(-1)?.config.suspended).toEqual({
      reason: 'QUOTA_EXCEEDED',
      until,
    });

    // At the monthly reset the suspension lapses and is cleared.
    await billing.enforce(new Date(Date.parse(until) + 1000));
    await delivered(4);
    expect(published.at(-1)?.config.suspended).toBeNull();
  });

  it('creates Stripe checkout sessions bound to the workspace and plan', async () => {
    const tenant = await workspace();
    const created = await call<{ url: string }>(
      `/tenants/${tenant}/billing/checkout`,
      session(tenant),
      { method: 'POST', body: { planId: 'pro' } },
    );
    expect(created).toEqual({
      status: 200,
      body: { url: 'https://checkout.stripe.test/c/pay/cs_1' },
    });
    expect(stripeRequests).toHaveLength(1);
    const [{ authorization, form }] = stripeRequests;
    expect(authorization).toBe('Bearer sk_test_billingFixture');
    expect(Object.fromEntries(form)).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_proFixture',
      client_reference_id: tenant,
      'metadata[tenantId]': tenant,
      'metadata[planId]': 'pro',
      'subscription_data[metadata][tenantId]': tenant,
      customer_email: `${tenant}@example.test`,
      success_url: 'https://app.example.test/billing?checkout=success',
    });
    for (const planId of ['enterprise', 'free', 'missing'])
      expect(
        (
          await call(`/tenants/${tenant}/billing/checkout`, session(tenant), {
            method: 'POST',
            body: { planId },
          })
        ).status,
      ).toBe(400);
    expect(stripeRequests).toHaveLength(1);
  });

  it('lifts suspensions and caps when enforcement is turned off', async () => {
    const tenant = await workspace();
    await meter(tenant, 100000);
    await billing.enforce();
    await delivered(1);
    expect(published.at(-1)?.config.suspended).not.toBeNull();
    const relaxed = new BillingService(
      db,
      push,
      settings({ BILLING_QUOTAS_ENABLED: 'false' }),
    );
    await relaxed.enforce();
    await delivered(2);
    expect(published.at(-1)?.config.suspended).toBeNull();
    const overview = await relaxed.overview(tenant);
    expect(overview.quotasEnforced).toBe(false);
    expect(overview.requests.percent).toBe(100);
  });

  it('verifies Stripe signatures with tolerance and multiple v1 values', () => {
    const payload = Buffer.from('{"id":"evt_1"}');
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const good = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${t}.`)
      .update(payload)
      .digest('hex');
    expect(
      verifyStripeSignature(
        payload,
        `t=${t},v1=${'0'.repeat(64)},v1=${good}`,
        WEBHOOK_SECRET,
        now,
      ),
    ).toBe(true);
    expect(
      verifyStripeSignature(
        payload,
        `t=${t},v1=${good}`,
        WEBHOOK_SECRET,
        now + 301000,
      ),
    ).toBe(false);
    expect(
      verifyStripeSignature(
        Buffer.from('{"id":"evt_2"}'),
        `t=${t},v1=${good}`,
        WEBHOOK_SECRET,
        now,
      ),
    ).toBe(false);
    expect(
      verifyStripeSignature(payload, `v1=${good}`, WEBHOOK_SECRET, now),
    ).toBe(false);
    expect(verifyStripeSignature(payload, undefined, WEBHOOK_SECRET, now)).toBe(
      false,
    );
  });
});
