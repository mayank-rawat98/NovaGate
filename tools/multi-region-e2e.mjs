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
 * Phase 6.3 exit criterion on real processes: two control plane regions share
 * one database, each with its own Redis. The gateway is connected to us-east
 * when that region dies. It keeps serving every request, moves to eu-west, and
 * receives a route created while us-east is down (published only to us-east's
 * Redis, delivered by eu-west from the database). When us-east returns the
 * gateway fails back; a preferred-region change moves it to eu-west. Request
 * logs buffered across the moves all arrive.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL), Redis (E2E_REDIS_URL), redis-server
 * on PATH for the second region, and built admin-api, control-plane and api.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const primaryRedis = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/10';
const gatewayRedis = primaryRedis.replace(/\/\d+$/, '') + '/11';
const secondaryPort = 16390;
const secondaryRedis = `redis://127.0.0.1:${secondaryPort}/0`;
const artifacts = resolve('.local-work/multi-region-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = {
  admin: 3001,
  us: { http: 3142, ws: 8222 },
  eu: { http: 3143, ws: 8223 },
  gateway: 3144,
};
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'regions-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_regions_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const children = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
let root;
let db;
let upstream;
let databaseUrl;

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
function start(name, command, args, env) {
  const log = createWriteStream(resolve(artifacts, `${name}.log`), {
    flags: 'a',
  });
  const child = spawn(command, args, {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const entry = { name, child };
  children.push(entry);
  return entry;
}
function node(name, script, env) {
  assert.ok(existsSync(script), `Build ${name} first: ${script} is missing`);
  return start(name, process.execPath, [script], env);
}
function controlPlane(region) {
  const { http, ws } = ports[region === 'us-east' ? 'us' : 'eu'];
  return node(`control-plane-${region}`, 'apps/control-plane/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: region === 'us-east' ? primaryRedis : secondaryRedis,
    PORT: String(http),
    WS_PORT: String(ws),
    CONTROL_PLANE_REGION: region,
    CONTROL_PLANE_CONFIG_SYNC_INTERVAL_MS: '1000',
  });
}
async function healthy(port) {
  return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
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
async function gatewayStatus(path) {
  const response = await fetch(`http://127.0.0.1:${ports.gateway}${path}`);
  await response.arrayBuffer();
  return response.status;
}
async function gatewayRegion() {
  const response = await fetch(`http://127.0.0.1:${ports.gateway}/health`);
  return (await response.json()).controlPlaneRegion;
}

try {
  root = new pg.Client({ connectionString: databaseRoot });
  await root.connect();
  await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(databaseRoot);
  url.pathname = `/${database}`;
  databaseUrl = url.toString();
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

  upstream = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  // eu-west has its own Redis: publications in us-east never reach it.
  start('redis-eu-west', 'redis-server', [
    '--port',
    String(secondaryPort),
    '--bind',
    '127.0.0.1',
    '--save',
    '',
    '--appendonly',
    'no',
  ]);
  node('admin-api', 'apps/admin-api/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: primaryRedis,
    PLATFORM_JWT_SECRET: secret,
    OBJECT_STORAGE_ENABLED: 'false',
    CONTROL_PLANE_REGIONS: 'us-east,eu-west',
  });
  await until(() => healthy(ports.admin), 'admin-api startup');
  let us = controlPlane('us-east');
  controlPlane('eu-west');
  await until(() => healthy(ports.us.http), 'us-east startup');
  await until(() => healthy(ports.eu.http), 'eu-west startup');
  const service = await api(`/tenants/${tenant}/services`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'orders',
      targets: [
        { url: `http://127.0.0.1:${upstream.address().port}`, weight: 100 },
      ],
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
  const gateway = node('gateway', 'apps/api/dist/main.js', {
    PORT: String(ports.gateway),
    REDIS_URL: gatewayRedis,
    JWT_SECRET: secret,
    GATEWAY_API_KEY: gatewayApiKey,
    CONTROL_PLANE_URLS: `us-east=ws://127.0.0.1:${ports.us.ws},eu-west=ws://127.0.0.1:${ports.eu.ws}`,
    CONTROL_PLANE_FAILBACK_MS: '4000',
    GATEWAY_INSTANCE_NAME: 'edge-1',
    GRPC_ENABLED: 'false',
  });
  await until(async () => (await gatewayStatus('/orders')) === 200, 'gateway');
  assert.equal(await gatewayRegion(), 'us-east');
  const listed = await until(async () => {
    const state = await api(`/tenants/${tenant}/control-plane`);
    return state.gateways[0]?.online && state;
  }, 'gateway presence');
  assert.equal(listed.gateways[0].region, 'us-east');
  assert.equal(listed.gateways[0].name, 'edge-1');
  step(
    'the gateway serves traffic through us-east, listed in the dashboard API',
  );

  // Steady traffic for the rest of the run.
  const statuses = [];
  let traffic = true;
  const load = (async () => {
    while (traffic) {
      statuses.push(await gatewayStatus('/orders').catch(() => 0));
      // Below the gateway's anonymous rate limit (100 per minute).
      await new Promise((done) => setTimeout(done, 800));
    }
  })();

  const outageAt = Date.now();
  us.child.kill('SIGKILL');
  await once(us.child, 'exit');
  await until(async () => (await gatewayRegion()) === 'eu-west', 'failover');
  const failoverMs = Date.now() - outageAt;
  step('us-east died; the gateway reconnected to eu-west', { failoverMs });

  // Created while us-east is down: published to us-east's Redis only.
  await api(`/tenants/${tenant}/routes`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'GET',
      pathPattern: '/payments',
      serviceId: service.id,
    }),
  });
  const createdAt = Date.now();
  await until(
    async () => (await gatewayStatus('/payments')) === 200,
    'route delivered by eu-west from the database',
  );
  const deliveredMs = Date.now() - createdAt;
  const current = await api(`/tenants/${tenant}/control-plane`);
  const instance = current.gateways.find((g) => g.online);
  assert.equal(instance.region, 'eu-west');
  await until(async () => {
    const state = await api(`/tenants/${tenant}/control-plane`);
    return (
      state.gateways.find((g) => g.online)?.configVersion ===
      state.configVersion
    );
  }, 'acknowledged version recorded');
  step(
    'a route created during the outage reached the gateway through eu-west',
    {
      deliveredMs,
    },
  );

  us = controlPlane('us-east');
  await until(() => healthy(ports.us.http), 'us-east restart');
  await until(
    async () => (await gatewayRegion()) === 'us-east',
    'failback to us-east',
    60000,
  );
  step('us-east came back; the gateway failed back after the failback delay');

  await api(`/tenants/${tenant}/control-plane`, {
    method: 'PUT',
    body: JSON.stringify({ preferredRegion: 'eu-west' }),
  });
  await until(
    async () => (await gatewayRegion()) === 'eu-west',
    'preferred region',
  );
  await new Promise((done) => setTimeout(done, 5000));
  assert.equal(
    await gatewayRegion(),
    'eu-west',
    'stays in the preferred region',
  );
  step('the workspace preferred eu-west; the gateway moved and stayed');

  traffic = false;
  await load;
  const failed = statuses.filter((status) => status !== 200);
  assert.deepEqual(failed, [], 'every request succeeded across the moves');
  step('every request succeeded during failover, failback and the move', {
    requests: statuses.length,
  });

  // Logs buffered while disconnected arrive once the gateway is connected.
  const expected = statuses.length + 1; // plus the readiness request
  const logged = await until(
    async () => {
      const [{ count }] = (
        await db.query(
          `SELECT COUNT(*)::int AS count FROM ${schema}.request_logs WHERE path='/orders'`,
        )
      ).rows;
      return count >= expected && count;
    },
    'request logs for every request',
    30000,
  );
  step('request logs buffered across the moves were all delivered', {
    expected,
    logged,
  });
  assert.equal(gateway.child.exitCode, null);
  evidence.passed = true;
  console.log('Multi-region control plane end-to-end verification passed.');
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(
    resolve(artifacts, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  for (const { child } of children.reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
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
  for (const url of [primaryRedis, gatewayRedis]) {
    const redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis
      .connect()
      .then(() => redis.flushdb())
      .catch(() => undefined);
    redis.disconnect();
  }
}
