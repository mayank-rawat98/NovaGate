import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';

/**
 * Phase 6.4 exit criteria on real processes: the gateway meters requests in
 * its own Redis and reports cumulative totals through the control plane. A
 * consumer over its monthly quota gets 429 without reaching the upstream; a
 * workspace that uses its plan's monthly requests is suspended by the admin
 * API and the gateway refuses all traffic; a signed Stripe webhook for an
 * upgrade lifts the suspension immediately.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL) and Redis (E2E_REDIS_URL), and built
 * admin-api, control-plane and api. Stripe is a local fake; no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/9';
const artifacts = resolve('.local-work/billing-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3132, planeWs: 8212, gateway: 3133 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'billing-e2e-platform-secret-at-least-32-characters';
const webhookSecret = 'whsec_billingEndToEnd0123456789';
const gatewayApiKey = randomUUID();
const database = `novagate_billing_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
/** Small plan so the run reaches the limit in a few requests. */
const WORKSPACE_LIMIT = 12;
const CONSUMER_QUOTA = 3;
const children = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
let root;
let db;
let upstream;
let stripe;
let gatewayProcess;

function step(name, detail = {}) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`✓ ${name}`);
}
async function until(check, label, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
function start(name, script, env) {
  assert.ok(existsSync(script), `Build ${name} first: ${script} is missing`);
  const log = createWriteStream(resolve(artifacts, `${name}.log`));
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child });
  return child;
}
async function api(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.admin}/api${path}`, {
    ...init,
    headers: {
      authorization: session,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `${init.method ?? 'GET'} ${path} → ${response.status} ${text}`,
    );
  return text ? JSON.parse(text) : undefined;
}
async function gateway(path, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.gateway}${path}`, {
    headers,
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies are compared as text.
  }
  return { status: response.status, headers: response.headers, body };
}
async function webhook(event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', webhookSecret)
    .update(`${t}.${body}`)
    .digest('hex');
  // No session: Stripe authenticates with the signature.
  return fetch(`http://127.0.0.1:${ports.admin}/api/billing/stripe/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${t},v1=${v1}`,
    },
    body,
  });
}

try {
  root = new pg.Client({ connectionString: databaseRoot });
  await root.connect();
  await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(databaseRoot);
  url.pathname = `/${database}`;
  const databaseUrl = url.toString();
  db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(readFileSync('docker/postgres-init.sql', 'utf8'));
  await db.query(
    `INSERT INTO public.tenants (id,name,email,"planId","gatewayConfigVersion","emailVerified") VALUES ($1,'Acme','owner@acme.test','free',1,true)`,
    [tenant],
  );
  await db.query(`CREATE SCHEMA ${schema}`);
  const provisioning = readFileSync(
    'apps/admin-api/src/tenants/tenant-provisioning.service.ts',
    'utf8',
  );
  for (const match of provisioning.matchAll(
    /await manager\.query\(`([\s\S]*?)`\)/g,
  ))
    await db.query(match[1].replaceAll('${schemaName}', schema));
  await db.query(
    `INSERT INTO public.api_keys ("tenantId","keyHash",label) VALUES ($1,$2,'E2E gateway')`,
    [tenant, createHash('sha256').update(gatewayApiKey).digest('hex')],
  );

  let hits = 0;
  upstream = createServer((request, response) => {
    request.resume();
    // The gateway's active health checks are not traffic.
    if (request.url !== '/health') hits++;
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const checkouts = [];
  stripe = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      checkouts.push({
        path: request.url,
        authorization: request.headers.authorization,
        form: Object.fromEntries(new URLSearchParams(body)),
      });
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ url: 'https://checkout.stripe.test/c/pay/cs_e2e' }),
        );
    });
  });
  stripe.listen(0, '127.0.0.1');
  await once(stripe, 'listening');

  start('admin-api', 'apps/admin-api/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PLATFORM_JWT_SECRET: secret,
    OBJECT_STORAGE_ENABLED: 'false',
    BILLING_QUOTAS_ENABLED: 'true',
    BILLING_ENFORCEMENT_INTERVAL_MS: '1000',
    STRIPE_SECRET_KEY: 'sk_test_billingEndToEnd',
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICES: JSON.stringify({ pro: 'price_proEndToEnd' }),
    STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`,
    DASHBOARD_URL: 'https://app.example.test',
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.admin}/api/health`)).ok,
    'admin-api startup',
  );
  // Operators own plan rows; shrink the free plan for the run.
  await db.query(
    `UPDATE public.plans SET "requestsPerMonth"=$1 WHERE id='free'`,
    [WORKSPACE_LIMIT],
  );
  start('control-plane', 'apps/control-plane/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PORT: String(ports.planeHttp),
    WS_PORT: String(ports.planeWs),
  });
  await until(
    async () =>
      (await fetch(`http://127.0.0.1:${ports.planeHttp}/api/health`)).ok,
    'control-plane startup',
  );
  const service = await api(`/tenants/${tenant}/services`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'orders',
      targets: [
        { url: `http://127.0.0.1:${upstream.address().port}`, weight: 100 },
      ],
      circuitBreaker: null,
    }),
  });
  await api(`/tenants/${tenant}/routes`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'GET',
      pathPattern: '/orders',
      serviceId: service.id,
    }),
  });
  const consumer = await api(`/tenants/${tenant}/consumers`, {
    method: 'POST',
    body: JSON.stringify({ name: 'mobile', monthlyQuota: CONSUMER_QUOTA }),
  });
  assert.equal(consumer.monthlyQuota, CONSUMER_QUOTA);
  const asConsumer = { authorization: `Bearer ${consumer.apiKey}` };
  gatewayProcess = start('gateway', 'apps/api/dist/main.js', {
    PORT: String(ports.gateway),
    REDIS_URL: redisUrl,
    JWT_SECRET: secret,
    GATEWAY_API_KEY: gatewayApiKey,
    CONTROL_PLANE_URL: `ws://127.0.0.1:${ports.planeWs}`,
    GRPC_ENABLED: 'false',
  });
  await until(
    async () => (await gateway('/orders')).status === 200,
    'gateway serving the route',
  );
  step('started admin-api, control-plane and gateway with a 12-request plan');

  // Consumer quota: three requests, then 429 without reaching the upstream.
  const before = hits;
  for (let i = 0; i < CONSUMER_QUOTA; i++)
    assert.equal((await gateway('/orders', asConsumer)).status, 200);
  const refused = await gateway('/orders', asConsumer);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'QUOTA_EXCEEDED');
  assert.equal(refused.headers.get('x-quota-limit'), String(CONSUMER_QUOTA));
  assert.equal(refused.headers.get('x-quota-remaining'), '0');
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal(hits - before, CONSUMER_QUOTA, 'refusal never reaches upstream');
  step('a consumer over its monthly quota gets 429 QUOTA_EXCEEDED', {
    reset: refused.headers.get('x-quota-reset'),
  });

  // Fill the plan with anonymous traffic. The readiness request counted;
  // the refused consumer request did not.
  let used = CONSUMER_QUOTA + 1;
  while (used < WORKSPACE_LIMIT) {
    assert.equal((await gateway('/orders')).status, 200);
    used++;
  }
  const quotas = await until(
    async () => {
      const list = await api(`/tenants/${tenant}/billing/consumer-quotas`);
      return list[0]?.requests === CONSUMER_QUOTA && list;
    },
    'consumer usage reported through the control plane',
    45000,
  );
  step('gateway usage reports reach the admin API through the control plane', {
    quotas,
  });
  const suspended = await until(
    async () => {
      const overview = await api(`/tenants/${tenant}/billing`);
      return overview.suspended && overview;
    },
    'workspace suspension by the enforcement worker',
    45000,
  );
  assert.equal(suspended.requests.used, WORKSPACE_LIMIT);
  assert.equal(suspended.requests.percent, 100);
  const paused = await until(async () => {
    const response = await gateway('/orders');
    return response.status === 429 && response;
  }, 'gateway refusing traffic after the configuration push');
  assert.equal(paused.body.error, 'QUOTA_EXCEEDED');
  const retryAfter = Number(paused.headers.get('retry-after'));
  assert.ok(
    Math.abs(
      Date.now() + retryAfter * 1000 - Date.parse(suspended.suspended.until),
    ) < 5000,
    'Retry-After points at the monthly reset',
  );
  const pausedHits = hits;
  for (let i = 0; i < 3; i++)
    assert.equal((await gateway('/orders')).status, 429);
  assert.equal(hits, pausedHits);
  step('the exhausted workspace is suspended until the monthly reset', {
    until: suspended.suspended.until,
    retryAfter,
  });

  // Self-service upgrade: checkout goes to Stripe, the webhook changes the plan.
  const checkout = await api(`/tenants/${tenant}/billing/checkout`, {
    method: 'POST',
    body: JSON.stringify({ planId: 'pro' }),
  });
  assert.equal(checkout.url, 'https://checkout.stripe.test/c/pay/cs_e2e');
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].path, '/v1/checkout/sessions');
  assert.equal(checkouts[0].form['metadata[tenantId]'], tenant);
  assert.equal(checkouts[0].form['line_items[0][price]'], 'price_proEndToEnd');
  const event = {
    id: `evt_${randomUUID().replaceAll('-', '')}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_e2e',
        status: 'complete',
        customer: 'cus_e2e',
        subscription: 'sub_e2e',
        metadata: { tenantId: tenant, planId: 'pro' },
      },
    },
  };
  const unsigned = await fetch(
    `http://127.0.0.1:${ports.admin}/api/billing/stripe/webhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    },
  );
  assert.equal(unsigned.status, 400);
  assert.equal((await webhook(event)).status, 200);
  await until(
    async () => (await gateway('/orders')).status === 200,
    'traffic resumes after the upgrade',
  );
  const upgraded = await api(`/tenants/${tenant}/billing`);
  assert.equal(upgraded.plan.id, 'pro');
  assert.equal(upgraded.suspended, null);
  // Replays are acknowledged once.
  assert.deepEqual(await (await webhook(event)).json(), {
    received: true,
    duplicate: true,
  });
  step('a signed Stripe webhook for the upgrade lifts the suspension', {
    plan: upgraded.plan.id,
  });

  // The consumer's own quota still applies until it is raised.
  assert.equal((await gateway('/orders', asConsumer)).status, 429);
  await api(`/tenants/${tenant}/consumers/${consumer.id}`, {
    method: 'PUT',
    body: JSON.stringify({ monthlyQuota: CONSUMER_QUOTA + 5 }),
  });
  await until(
    async () => (await gateway('/orders', asConsumer)).status === 200,
    'raised consumer quota reaches the gateway',
  );
  step('raising the consumer quota takes effect on the next configuration');
  assert.equal(gatewayProcess.exitCode, null);
  evidence.passed = true;
  console.log('Quotas and billing end-to-end verification passed.');
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(
    resolve(artifacts, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  for (const { child } of children.reverse()) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((done) => setTimeout(done, 10000)),
    ]);
  }
  upstream?.close();
  stripe?.close();
  await db?.end().catch(() => undefined);
  if (root) {
    await root
      .query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      .catch(() => undefined);
    await root.end();
  }
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis
    .connect()
    .then(() => redis.flushdb())
    .catch(() => undefined);
  redis.disconnect();
}
