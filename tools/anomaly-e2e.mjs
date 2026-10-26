import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
 * Phase 6.1 exit criterion on real processes: a route with an established
 * baseline gets a latency spike through the real gateway. The admin API's
 * detector must raise the anomaly and the Phase 4 delivery worker must deliver
 * a signed webhook alert, well within 5 minutes. Baseline windows are seeded
 * (hours of real traffic would be needed otherwise); materializing windows
 * from request logs is covered by the PostgreSQL integration tests.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL) and Redis (E2E_REDIS_URL), and built
 * admin-api, control-plane and api. No containers, no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/8';
const artifacts = resolve('.local-work/anomaly-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3132, planeWs: 8212, gateway: 3133 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'anomaly-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_anomaly_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const WEBHOOK_SECRET = 'anomaly-e2e-webhook-signing-secret-32-bytes-min';
const children = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
let root;
let db;
let upstream;
let mail;
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

  // Webhook receiver for the delivered alert.
  const received = [];
  mail = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push({ headers: request.headers, text, at: Date.now() });
    response.writeHead(202).end('accepted');
  });
  mail.listen(0, '127.0.0.1');
  await once(mail, 'listening');
  const webhook = `http://127.0.0.1:${mail.address().port}`;
  // The upstream answers at baseline speed until the spike starts.
  let delayMs = 0;
  upstream = createServer((request, response) => {
    request.resume();
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    }, delayMs);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  start('admin-api', 'apps/admin-api/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PLATFORM_JWT_SECRET: secret,
    OBJECT_STORAGE_ENABLED: 'false',
    ALERT_CHANNEL_KEYS: JSON.stringify({
      e2e: randomBytes(32).toString('base64'),
    }),
    ALERT_CHANNEL_ACTIVE_KEY: 'e2e',
    ALERT_HTTP_TRUSTED_ORIGINS: JSON.stringify([webhook]),
    ANOMALY_EVALUATION_INTERVAL_MS: '5000',
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.admin}/api/health`)).ok,
    'admin-api startup',
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
  const channel = await api(`/tenants/${tenant}/alerts/channels`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'On-call webhook',
      type: 'webhook',
      url: `${webhook}/novagate-alerts`,
      secret: WEBHOOK_SECRET,
    }),
  });
  // Detection stays off until the spike: the seeded baseline expects about
  // 40 requests per 5 minutes, so an idle start would correctly read as a
  // traffic drop.
  const configure = async (enabled) => {
    const settings = await api(`/tenants/${tenant}/anomaly-settings`);
    return api(`/tenants/${tenant}/anomaly-settings`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled,
        zThreshold: 3,
        minRequests: 20,
        channelIds: [channel.id],
        expectedRevision: settings.revision,
      }),
    });
  };
  await configure(false);

  // Seed eight completed 15-minute windows of normal traffic for the route:
  // 120 requests each at a p95 of 20-26 ms.
  const [{ now }] = (await db.query('SELECT clock_timestamp() AS now')).rows;
  const current = Math.floor(new Date(now).getTime() / 900000) * 900000;
  const schemaWindows = [];
  for (let i = 1; i <= 8; i++)
    schemaWindows.push([new Date(current - i * 900000), 20 + (i % 4) * 2]);
  for (const [start, p95] of schemaWindows)
    await db.query(
      `INSERT INTO ${schema}.route_traffic_windows (window_start, method, path, requests, server_errors, p95_ms)
        VALUES ($1, 'GET', '/orders', 120, 0, $2)`,
      [start, p95],
    );
  await db.query(`UPDATE ${schema}.anomaly_settings SET next_window = $1`, [
    new Date(current),
  ]);
  step('seeded a 2-hour baseline for GET /orders (p95 20-26 ms)', {
    windows: schemaWindows.length,
  });

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
    'gateway startup and route delivery',
  );
  step('started admin-api, control-plane and gateway with a webhook channel');

  // Inject the latency spike: 40 requests at about 400 ms.
  delayMs = 400;
  const injected = Date.now();
  const statuses = await Promise.all(
    Array.from({ length: 40 }, () =>
      gateway('/orders').then((result) => result.status),
    ),
  );
  assert.ok(statuses.every((status) => status === 200));
  await configure(true);
  step('injected a latency spike through the gateway and enabled detection', {
    requests: 40,
  });

  const delivered = await until(
    async () =>
      received.find(
        (item) => JSON.parse(item.text).event.metric === 'p95_latency_ms',
      ),
    'delivered p95 anomaly webhook',
    300000,
  );
  const elapsedMs = delivered.at - injected;
  assert.ok(elapsedMs < 300000, 'alert within 5 minutes');
  const payload = JSON.parse(delivered.text);
  assert.equal(payload.tenantId, tenant);
  assert.equal(payload.event.state, 'firing');
  assert.equal(payload.event.metric, 'p95_latency_ms');
  assert.equal(payload.event.ruleId, null);
  assert.equal(payload.event.anomaly.path, '/orders');
  assert.match(
    payload.event.anomaly.summary,
    /^Unusual \d+% rise in p95 latency on GET \/orders: baseline \d+ ms, current \d+ ms$/,
  );
  assert.ok(payload.event.value >= 350);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${delivered.headers['x-novagate-timestamp']}.`)
    .update(delivered.text)
    .digest('hex');
  assert.equal(delivered.headers['x-novagate-signature'], `v1=${signature}`);
  step('the signed webhook alert arrived', {
    elapsedSeconds: Math.round(elapsedMs / 1000),
    summary: payload.event.anomaly.summary,
  });

  const anomalies = await api(`/tenants/${tenant}/anomalies?state=active`);
  // Only the latency changed: no traffic or error anomaly.
  assert.deepEqual(
    anomalies.map((anomaly) => [anomaly.method, anomaly.path, anomaly.metric]),
    [['GET', '/orders', 'p95_latency_ms']],
  );
  const history = await until(async () => {
    const events = await api(`/tenants/${tenant}/alerts/history`);
    return events[0]?.deliveries[0]?.status === 'delivered' && events;
  }, 'delivery recorded in alert history');
  assert.equal(history[0].anomaly.id, anomalies[0].id);
  step('the anomaly feed and alert history show the anomaly and its delivery');
  assert.equal(gatewayProcess.exitCode, null);
  evidence.passed = true;
  console.log('Anomaly detection end-to-end verification passed.');
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
  mail?.close();
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
