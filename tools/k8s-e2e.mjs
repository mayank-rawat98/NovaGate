import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
 * Phase 6.5 exit criterion on real processes: `kubectl apply -f route.yaml`
 * creates the route in NovaGate. A real kube-apiserver and etcd (envtest
 * binaries in KUBEBUILDER_ASSETS: etcd, kube-apiserver, kubectl) run the
 * CRDs; the built controller reconciles into the real admin API with a
 * scoped automation token; the control plane pushes the route to a real
 * gateway that serves traffic. Editing and deleting the resource update
 * and soft-delete the route.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL), Redis (E2E_REDIS_URL), Go,
 * KUBEBUILDER_ASSETS and built admin-api, control-plane and api.
 */
const assets = process.env.KUBEBUILDER_ASSETS;
assert.ok(
  assets &&
    ['etcd', 'kube-apiserver', 'kubectl'].every((binary) =>
      existsSync(resolve(assets, binary)),
    ),
  'Set KUBEBUILDER_ASSETS to a directory with etcd, kube-apiserver and kubectl (see integrations/k8s-controller/README.md)',
);
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/13';
const artifacts = resolve('.local-work/k8s-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3162, planeWs: 8242, gateway: 3163 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'k8s-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_k8s_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const children = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
let root;
let db;
let upstream;

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

  upstream = createServer((request, response) => {
    request.resume();
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ users: [], path: request.url }));
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
  start('gateway', 'apps/api/dist/main.js', {
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
  // The controller's credential: only what it needs.
  const token = await api(`/tenants/${tenant}/automation-tokens`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'k8s-controller',
      scopes: ['routes:write', 'services:write'],
      expiresInDays: 1,
    }),
  });
  step(
    'started admin-api, control-plane and gateway; created a scoped automation token',
  );

  const build = spawnSync(
    'go',
    ['build', '-o', 'dist/novagate-controller', '.'],
    {
      cwd: 'integrations/k8s-controller',
      stdio: 'inherit',
    },
  );
  assert.equal(build.status, 0, 'controller build failed');
  // Asynchronous: the upstream below runs in this process's event loop.
  const goTest = spawn(
    'go',
    [
      'test',
      '-tags',
      'e2e',
      './e2e',
      '-run',
      'TestKubectlApply',
      '-count=1',
      '-v',
      '-timeout=10m',
    ],
    {
      cwd: 'integrations/k8s-controller',
      env: {
        ...process.env,
        NOVAGATE_API_URL: `http://127.0.0.1:${ports.admin}/api`,
        NOVAGATE_TENANT_ID: tenant,
        NOVAGATE_TOKEN: token.token,
        NOVAGATE_GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
        UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`,
        E2E_ARTIFACTS: artifacts,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const test = { stdout: '', stderr: '' };
  goTest.stdout.on('data', (chunk) => (test.stdout += chunk));
  goTest.stderr.on('data', (chunk) => (test.stderr += chunk));
  const [status] = await once(goTest, 'exit');
  writeFileSync(
    resolve(artifacts, 'go-test.log'),
    `${test.stdout}\n${test.stderr}`,
  );
  if (status !== 0) {
    console.error(test.stdout.slice(-4000), test.stderr.slice(-4000));
    throw new Error('kubectl end-to-end test failed');
  }
  assert.match(test.stdout, /--- PASS: TestKubectlApply/);
  const kubectl = JSON.parse(
    readFileSync(resolve(artifacts, 'kubectl.json'), 'utf8'),
  );
  step(
    'kubectl apply created the route in NovaGate and the gateway served it',
    kubectl,
  );

  // The deletion is a soft delete in the workspace schema.
  const rows = (
    await db.query(
      `SELECT "pathPattern", "deletedAt" IS NOT NULL AS deleted FROM ${schema}.routes WHERE id=$1`,
      [kubectl.routeId],
    )
  ).rows;
  assert.deepEqual(rows, [{ pathPattern: '/v2/users', deleted: true }]);
  const services = (
    await db.query(
      `SELECT name, "deletedAt" IS NOT NULL AS deleted FROM ${schema}.services ORDER BY name`,
    )
  ).rows;
  assert.deepEqual(services, [{ name: 'k8s:default/users', deleted: true }]);
  step('kubectl delete soft-deleted the route and its service in PostgreSQL');
  evidence.passed = true;
  console.log('Kubernetes controller end-to-end verification passed.');
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
