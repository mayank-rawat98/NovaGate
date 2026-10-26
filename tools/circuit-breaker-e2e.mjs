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
 * Phase 6.2 exit criterion on real processes: a service answering 60% of
 * requests with 5xx opens its circuit on the real gateway, which then refuses
 * traffic without reaching the upstream. The state reaches the admin API
 * through the control plane, both as a snapshot and on the live stream, and
 * the circuit closes again after the upstream recovers.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL) and Redis (E2E_REDIS_URL), and built
 * admin-api, control-plane and api. No containers, no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/8';
const artifacts = resolve('.local-work/circuit-breaker-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3122, planeWs: 8202, gateway: 3123 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'circuit-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_circuit_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const OPEN_MS = 2000;
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
const circuitOf = async (serviceId) =>
  (await api(`/tenants/${tenant}/circuit-breakers`)).services.find(
    (status) => status.serviceId === serviceId,
  );

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

  // The upstream fails while `failing` is set: 3 of every 5 requests.
  let failing = true;
  let hits = 0;
  upstream = createServer((request, response) => {
    request.resume();
    // The gateway's active health checks are not traffic.
    if (request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }
    hits++;
    const fail = failing && hits % 5 !== 2 && hits % 5 !== 4;
    response.writeHead(fail ? 503 : 200, { 'content-type': 'text/plain' });
    response.end(fail ? 'overloaded' : 'ok');
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
  // Created through the API without circuitBreaker: the default applies.
  const created = await api(`/tenants/${tenant}/services`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'orders',
      targets: [
        { url: `http://127.0.0.1:${upstream.address().port}`, weight: 100 },
      ],
    }),
  });
  assert.equal(created.circuitBreaker.enabled, true);
  const service = await api(`/tenants/${tenant}/services/${created.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      circuitBreaker: { ...created.circuitBreaker, openMs: OPEN_MS },
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
  gatewayProcess = start('gateway', 'apps/api/dist/main.js', {
    PORT: String(ports.gateway),
    REDIS_URL: redisUrl,
    JWT_SECRET: secret,
    GATEWAY_API_KEY: gatewayApiKey,
    CONTROL_PLANE_URL: `ws://127.0.0.1:${ports.planeWs}`,
    GRPC_ENABLED: 'false',
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.gateway}/health`)).ok,
    'gateway startup',
  );
  await until(
    async () => (await circuitOf(service.id))?.state === 'closed',
    'first circuit report through the control plane',
  );
  step(
    'started admin-api, control-plane and gateway; the new service reports a closed circuit',
  );

  // Live stream from the admin API, read alongside the traffic.
  const frames = [];
  const abort = new AbortController();
  const live = await fetch(
    `http://127.0.0.1:${ports.admin}/api/tenants/${tenant}/circuit-breakers/stream`,
    { headers: { authorization: session }, signal: abort.signal },
  );
  assert.equal(live.status, 200);
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of live.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = buffer.match(/event: circuits\ndata: (.*)\n\n/))) {
          buffer = buffer.slice(match.index + match[0].length);
          frames.push(JSON.parse(match[1]));
        }
      }
    } catch {
      /* Aborted at the end of the run. */
    }
  })();
  const stateIn = (frame) =>
    frame.services.find((status) => status.serviceId === service.id)?.state;

  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await gateway('/orders')).status);
  assert.deepEqual(statuses, [502, 200, 502, 200, 502]);
  const refused = await gateway('/orders');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, 'CIRCUIT_OPEN');
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal(hits, 5, 'an open circuit sends nothing upstream');
  step(
    '3 of 5 upstream failures (60%) opened the circuit; the gateway refuses with 503',
    {
      statuses,
    },
  );
  const open = await until(async () => {
    const status = await circuitOf(service.id);
    return status?.state === 'open' && status;
  }, 'open state in the admin snapshot');
  assert.deepEqual([open.requests, open.failures], [5, 3]);
  await until(
    async () => frames.some((frame) => stateIn(frame) === 'open'),
    'open state on the live stream',
  );
  step('the admin snapshot and live stream show the open circuit', {
    nextProbeAt: open.nextProbeAt,
  });

  failing = false;
  await new Promise((done) => setTimeout(done, OPEN_MS + 100));
  // One probe, then wait past the gateway's 200 ms report debounce so the
  // half-open state is published before the second probe closes the circuit.
  assert.equal((await gateway('/orders')).status, 200);
  await until(
    async () => frames.some((frame) => stateIn(frame) === 'half-open'),
    'half-open state on the live stream',
  );
  assert.equal((await gateway('/orders')).status, 200);
  await until(
    async () => (await circuitOf(service.id))?.state === 'closed',
    'closed state after recovery',
  );
  await until(
    async () => stateIn(frames.at(-1)) === 'closed',
    'closed state on the live stream',
  );
  abort.abort();
  await reading;
  step('after recovery two probes closed the circuit, observed live', {
    liveStates: frames.map(stateIn),
  });
  assert.equal(gatewayProcess.exitCode, null);
  evidence.passed = true;
  console.log('Circuit breaker end-to-end verification passed.');
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
