import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
 * Phase 5.5 exit criterion on real processes: plugin packages are packed and
 * installed with npm, loaded by the real gateway at their pinned versions and
 * run on live traffic. A plugin that crashes asynchronously is quarantined
 * while the gateway keeps serving; the control plane relays plugin state to
 * the admin API, and the workspace kill switch reaches the gateway.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL) and Redis (E2E_REDIS_URL), and built
 * admin-api, control-plane and api. No containers, no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/8';
const artifacts = resolve('.local-work/third-party-plugins-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3112, planeWs: 8192, gateway: 3113 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'plugins-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_plugins_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const STAMP = '@novagate-examples/header-stamp';
const CRASH = '@novagate-examples/crash-on-request';
const MISSING = '@novagate-examples/not-installed';
const QUARANTINE_MS = 3000;
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
const pluginState = async (name) =>
  (await api(`/tenants/${tenant}/gateway-plugins`)).plugins.find(
    (plugin) => plugin.name === name,
  );

try {
  // Pack and install the example plugins the way an operator would.
  const packs = resolve(artifacts, 'packs');
  const pluginDir = resolve(artifacts, 'gateway-plugins');
  mkdirSync(packs, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    resolve(pluginDir, 'package.json'),
    JSON.stringify({ name: 'novagate-gateway-plugins', private: true }),
  );
  const tarballs = ['header-stamp', 'crash-on-request'].map((example) =>
    resolve(
      packs,
      execFileSync(
        'npm',
        [
          'pack',
          resolve('libs/plugin-sdk/examples', example),
          '--pack-destination',
          packs,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .trim()
        .split('\n')
        .at(-1),
    ),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      pluginDir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--offline',
      ...tarballs,
    ],
    { stdio: 'ignore' },
  );
  assert.ok(
    existsSync(resolve(pluginDir, 'node_modules', STAMP, 'package.json')),
  );
  step('packed and npm-installed the example plugin packages', {
    tarballs: tarballs.map((file) => file.split('/').at(-1)),
  });

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

  // The upstream echoes the plugin-stamped request header.
  upstream = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        path: request.url,
        stamp: request.headers['x-plugin-stamp'] ?? null,
      }),
    );
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
  const service = await api(`/tenants/${tenant}/services`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'echo',
      targets: [
        { url: `http://127.0.0.1:${upstream.address().port}`, weight: 100 },
      ],
    }),
  });
  for (const [pathPattern, plugins] of [
    ['/stamp', [{ name: STAMP, config: { value: 'e2e-v1' } }]],
    ['/crash', [{ name: CRASH, config: {} }]],
    ['/missing', [{ name: MISSING, config: {} }]],
  ])
    await api(`/tenants/${tenant}/routes`, {
      method: 'POST',
      body: JSON.stringify({
        method: 'GET',
        pathPattern,
        serviceId: service.id,
        plugins,
      }),
    });
  gatewayProcess = start('gateway', 'apps/api/dist/main.js', {
    PORT: String(ports.gateway),
    REDIS_URL: redisUrl,
    JWT_SECRET: secret,
    GATEWAY_API_KEY: gatewayApiKey,
    CONTROL_PLANE_URL: `ws://127.0.0.1:${ports.planeWs}`,
    GRPC_ENABLED: 'false',
    THIRD_PARTY_PLUGIN_DIR: pluginDir,
    THIRD_PARTY_PLUGINS: JSON.stringify([
      { package: STAMP, version: '1.0.0' },
      { package: CRASH, version: '1.0.0' },
      { package: MISSING, version: '1.0.0' },
    ]),
    THIRD_PARTY_PLUGIN_HOOK_TIMEOUT_MS: '500',
    THIRD_PARTY_PLUGIN_FAILURE_THRESHOLD: '1',
    THIRD_PARTY_PLUGIN_QUARANTINE_MS: String(QUARANTINE_MS),
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.gateway}/health`)).ok,
    'gateway startup',
  );
  step('started admin-api, control-plane and a gateway with pinned plugins');

  const stamped = await until(async () => {
    const result = await gateway('/stamp');
    return result.status === 200 && result;
  }, 'configuration delivery to the gateway');
  assert.equal(stamped.body.stamp, 'e2e-v1');
  assert.equal(stamped.headers.get('x-plugin-stamp'), 'e2e-v1');
  step('installed plugin ran on live traffic (request and response hooks)');

  const missing = await gateway('/missing');
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, 'PLUGIN_UNAVAILABLE');
  const reported = await until(
    async () => (await pluginState(MISSING))?.state === 'failed',
    'plugin report through the control plane',
  );
  assert.ok(reported);
  assert.equal((await pluginState(STAMP)).state, 'active');
  step('an uninstalled pinned package fails its routes closed and is reported');

  for (const mode of ['timer', 'reject']) {
    await until(
      async () => (await gateway('/crash')).status === 200,
      `crash plugin recovers before the ${mode} crash`,
      QUARANTINE_MS + 10000,
    );
    // The hook returns normally; its timer or orphaned rejection fails later.
    await gateway('/crash', { 'x-crash-mode': mode });
    const blocked = await until(async () => {
      const result = await gateway('/crash');
      return result.status === 503 && result;
    }, `quarantine after the ${mode} crash`);
    assert.equal(blocked.body.error, 'PLUGIN_UNAVAILABLE');
    assert.equal(gatewayProcess.exitCode, null, 'gateway is still running');
    assert.equal((await gateway('/stamp')).status, 200);
    const status = await until(async () => {
      const state = await pluginState(CRASH);
      return state?.state === 'quarantined' && state;
    }, `quarantine report after the ${mode} crash`);
    assert.match(status.lastError, /plugin (timer crash|unhandled rejection)/);
    step(
      `asynchronous ${mode} crash quarantined the plugin; gateway kept serving`,
      {
        lastError: status.lastError,
      },
    );
  }

  // The admin kill switch reaches the gateway through the control plane.
  await api(`/tenants/${tenant}/gateway-plugins`, {
    method: 'PUT',
    body: JSON.stringify({ disabled: [STAMP] }),
  });
  const disabled = await until(async () => {
    const result = await gateway('/stamp');
    return result.status === 503 && result;
  }, 'kill switch delivery');
  assert.equal(disabled.body.error, 'PLUGIN_DISABLED');
  await until(
    async () => (await pluginState(STAMP))?.state === 'disabled',
    'disabled state report',
  );
  await api(`/tenants/${tenant}/gateway-plugins`, {
    method: 'PUT',
    body: JSON.stringify({ disabled: [] }),
  });
  await until(
    async () => (await gateway('/stamp')).status === 200,
    're-enable delivery',
  );
  step(
    'workspace kill switch disabled and re-enabled the plugin on the gateway',
  );

  assert.equal(gatewayProcess.exitCode, null);
  evidence.passed = true;
  console.log('Third-party plugin end-to-end verification passed.');
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
