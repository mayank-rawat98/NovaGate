import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
 * Phase 6.6 exit criteria on real processes:
 * - a catalog WebAssembly plugin installed through the admin API reaches the
 *   gateway through the control plane by digest and changes live traffic, in
 *   well under 50 ms per call (measured by the gateway and reported back);
 * - modules that import WASI filesystem calls are refused at upload, and the
 *   sandbox offers no other way to reach files;
 * - a runaway module is stopped at its 50 ms deadline, its route fails
 *   closed, repeated failures quarantine it, and other routes keep serving.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL) and Redis (E2E_REDIS_URL), and built
 * admin-api, control-plane and api. No containers, no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/12';
const artifacts = resolve('.local-work/wasm-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3152, planeWs: 8232, gateway: 3153 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'wasm-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_wasm_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const fixture = (name) =>
  readFileSync(`libs/plugin-sdk/wasm/fixtures/${name}.wasm`).toString('base64');
const children = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
let root;
let db;
let upstream;
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
    await new Promise((done) => setTimeout(done, 100));
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
  const body = text ? JSON.parse(text) : undefined;
  return { status: response.status, body };
}
async function ok(path, init) {
  const result = await api(path, init);
  if (result.status >= 300)
    throw new Error(
      `${init?.method ?? 'GET'} ${path} → ${result.status} ${JSON.stringify(result.body)}`,
    );
  return result.body;
}
// A consumer key puts this run's traffic in the authenticated rate tier.
let consumerKey;
async function gateway(path, headers = {}) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${ports.gateway}${path}`, {
    headers: consumerKey
      ? { authorization: `Bearer ${consumerKey}`, ...headers }
      : headers,
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies are compared as text.
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    ms: performance.now() - started,
  };
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

  const seen = [];
  upstream = createServer((request, response) => {
    request.resume();
    if (request.url !== '/health')
      seen.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  start('admin-api', 'apps/admin-api/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PLATFORM_JWT_SECRET: secret,
    OBJECT_STORAGE_ENABLED: 'false',
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
  const service = await ok(`/tenants/${tenant}/services`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'orders',
      targets: [
        { url: `http://127.0.0.1:${upstream.address().port}`, weight: 100 },
      ],
      circuitBreaker: null,
    }),
  });
  consumerKey = (
    await ok(`/tenants/${tenant}/consumers`, {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e' }),
    })
  ).apiKey;
  const route = (pathPattern, plugins) =>
    ok(`/tenants/${tenant}/routes`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'GET',
        pathPattern,
        serviceId: service.id,
        plugins,
      }),
    });

  // Install from the marketplace and attach to routes.
  for (const catalogId of ['header-stamp', 'require-header'])
    await ok(`/tenants/${tenant}/wasm-plugins/install`, {
      method: 'POST',
      body: JSON.stringify({ catalogId }),
    });
  await route('/plain', []);
  await route('/stamped', [
    {
      name: 'wasm:header-stamp',
      config: { header: 'x-stamp', value: 'from-wasm' },
    },
  ]);
  await route('/secure', [
    { name: 'wasm:require-header', config: { header: 'x-token' } },
  ]);

  // Filesystem access is refused before anything reaches a gateway.
  const refused = await api(`/tenants/${tenant}/wasm-plugins/upload`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'read-files',
      version: '1.0.0',
      module: fixture('wasi-fs'),
    }),
  });
  assert.equal(refused.status, 400);
  assert.match(
    refused.body.message,
    /wasi_snapshot_preview1\.path_open is not available/,
  );
  step('a module importing WASI filesystem calls is refused at upload', {
    message: refused.body.message,
  });
  await ok(`/tenants/${tenant}/wasm-plugins/upload`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'runaway',
      version: '1.0.0',
      module: fixture('loop'),
    }),
  });
  await route('/runaway', [{ name: 'wasm:runaway', config: {} }]);

  gatewayProcess = start('gateway', 'apps/api/dist/main.js', {
    PORT: String(ports.gateway),
    REDIS_URL: redisUrl,
    JWT_SECRET: secret,
    GATEWAY_API_KEY: gatewayApiKey,
    CONTROL_PLANE_URL: `ws://127.0.0.1:${ports.planeWs}`,
    GRPC_ENABLED: 'false',
    WASM_PLUGIN_FAILURE_THRESHOLD: '3',
  });
  await until(async () => (await gateway('/plain')).status === 200, 'gateway');
  // Modules arrive by digest after authentication.
  const stamped = await until(async () => {
    const response = await gateway('/stamped');
    return response.status === 200 && response;
  }, 'header-stamp delivered to the gateway');
  assert.equal(stamped.headers.get('x-stamp'), 'from-wasm');
  assert.equal(seen.at(-1).headers['x-stamp'], 'from-wasm');
  step('the catalog plugin changed the request and the response', {
    upstreamHeader: seen.at(-1).headers['x-stamp'],
  });

  assert.equal((await gateway('/secure')).status, 401);
  assert.equal((await gateway('/secure', { 'x-token': 't' })).status, 200);
  step(
    'require-header refused a request without x-token and passed one with it',
  );

  // Execution time: measured by the gateway around each sandbox call.
  for (let i = 0; i < 50; i++) await gateway('/stamped');
  const timing = await until(
    async () => {
      const state = await ok(`/tenants/${tenant}/wasm-plugins`);
      const status = state.statuses.find((s) => s.name === 'header-stamp');
      return status && status.calls >= 50 && status;
    },
    'gateway WASM report',
    45000,
  );
  assert.ok(timing.p99Us < 50000, `p99 ${timing.p99Us} µs`);
  const plain = [];
  const withPlugin = [];
  for (let i = 0; i < 30; i++) {
    plain.push((await gateway('/plain')).ms);
    withPlugin.push((await gateway('/stamped')).ms);
  }
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  step('plugin calls run far under 50 ms', {
    sandboxP50Us: timing.p50Us,
    sandboxP99Us: timing.p99Us,
    sandboxMaxUs: timing.maxUs,
    medianRequestMsWithout: Number(median(plain).toFixed(2)),
    medianRequestMsWith: Number(median(withPlugin).toFixed(2)),
  });

  const runaway = [];
  for (let i = 0; i < 3; i++) {
    const response = await gateway('/runaway');
    runaway.push({
      status: response.status,
      error: response.body.error,
      ms: Math.round(response.ms),
    });
    assert.equal(
      (await gateway('/stamped')).status,
      200,
      'other routes keep serving',
    );
  }
  assert.deepEqual(
    runaway.map((r) => r.status),
    [502, 502, 502],
  );
  assert.ok(
    runaway.every((r) => r.ms < 1000),
    'stopped at the deadline',
  );
  const paused = await gateway('/runaway');
  assert.equal(paused.status, 503);
  assert.equal(paused.body.error, 'PLUGIN_UNAVAILABLE');
  const quarantined = await until(async () => {
    const state = await ok(`/tenants/${tenant}/wasm-plugins`);
    return state.statuses.find(
      (s) => s.name === 'runaway' && s.state === 'quarantined',
    );
  }, 'quarantine report');
  step('a runaway module was stopped at its deadline and quarantined', {
    runaway,
    lastError: quarantined.lastError,
  });
  assert.equal(gatewayProcess.exitCode, null);
  evidence.passed = true;
  console.log('WebAssembly plugin sandbox end-to-end verification passed.');
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
