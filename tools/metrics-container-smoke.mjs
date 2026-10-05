import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';

// Production images, disposable infrastructure and fixture credentials only.
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
assert.equal(docker('context', 'show'), 'orbstack');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const network = `novagate-metrics-${suffix}`;
const names = [];
const images = {
  gateway: process.env.NOVAGATE_GRPC_IMAGE ?? 'novagate-api:verification',
  admin: process.env.NOVAGATE_ADMIN_IMAGE ?? 'novagate-admin:verification',
  plane:
    process.env.NOVAGATE_CONTROL_PLANE_IMAGE ??
    'novagate-control-plane:verification',
};
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'metric-container-fixture-session-secret-32-characters';
const apiKey = randomUUID();
const headers = {
  Authorization: `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '5m' })}`,
};
const controller = new AbortController();
let networkCreated = false;
let db;
let upstream;
let reader;
function run(name, image, env = [], ports = []) {
  const full = `${network}-${name}`;
  names.push(full);
  docker(
    'run',
    '-d',
    '--name',
    full,
    '--network',
    network,
    ...ports.flatMap((p) => ['-p', `127.0.0.1::${p}`]),
    ...env.flatMap((v) => ['-e', v]),
    image,
  );
  return full;
}
function port(name, value) {
  return Number(docker('port', name, `${value}/tcp`).split(':').at(-1));
}
async function until(check, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await check()) return;
    } catch {
      /* Wait for fixture readiness. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
function parser(streamReader) {
  let pending = '';
  const decoder = new TextDecoder();
  return async function next(predicate = () => true) {
    while (true) {
      const boundary = pending.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (data) {
          const sample = JSON.parse(data.slice(6));
          if (predicate(sample)) return sample;
        }
        continue;
      }
      const chunk = await streamReader.read();
      assert.ok(!chunk.done, 'Metrics stream ended unexpectedly');
      pending += decoder.decode(chunk.value, { stream: true });
      assert.ok(pending.length < 65536);
    }
  };
}
try {
  docker('network', 'create', network);
  networkCreated = true;
  const postgres = run(
    'postgres',
    'postgres:16-alpine',
    [
      'POSTGRES_USER=metric_fixture',
      'POSTGRES_PASSWORD=metric-fixture-only',
      'POSTGRES_DB=metric_fixture',
    ],
    [5432],
  );
  const redis = run('redis', 'redis:7-alpine');
  await until(
    () =>
      docker(
        'exec',
        postgres,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'metric_fixture',
      ).includes('accepting'),
    'PostgreSQL startup',
  );
  await until(
    () => docker('exec', redis, 'redis-cli', 'ping') === 'PONG',
    'Redis startup',
  );
  db = new pg.Client({
    connectionString: `postgres://metric_fixture:metric-fixture-only@127.0.0.1:${port(postgres, 5432)}/metric_fixture`,
  });
  await db.connect();
  await db.query(readFileSync('docker/postgres-init.sql', 'utf8'));
  await db.query(
    'INSERT INTO public.tenants (id,name,email,"planId","gatewayConfigVersion") VALUES ($1,$2,$3,$4,1)',
    [tenant, 'Metric fixture', `${tenant}@example.test`, 'free'],
  );
  await db.query(`CREATE SCHEMA ${schema}`);
  // Use the canonical provisioning SQL, then run the real admin migration.
  const provisioning = readFileSync(
    'apps/admin-api/src/tenants/tenant-provisioning.service.ts',
    'utf8',
  );
  for (const match of provisioning.matchAll(
    /await manager\.query\(`([\s\S]*?)`\)/g,
  ))
    await db.query(match[1].replaceAll('${schemaName}', schema));
  await db.query(
    'INSERT INTO public.api_keys ("tenantId","keyHash",label) VALUES ($1,$2,$3)',
    [
      tenant,
      createHash('sha256').update(apiKey).digest('hex'),
      'Metric fixture',
    ],
  );
  upstream = createServer((request, response) => {
    request.resume();
    response.writeHead(request.url?.includes('/failure') ? 503 : 200);
    response.end('metric fixture');
  });
  await new Promise((done) => upstream.listen(0, '0.0.0.0', done));
  const service = randomUUID();
  await db.query(
    `INSERT INTO ${schema}.services (id,name,targets,"healthCheckPath") VALUES ($1,$2,$3,$4)`,
    [
      service,
      'Metric fixture',
      JSON.stringify([
        {
          url: `http://host.docker.internal:${upstream.address().port}`,
          weight: 1,
        },
      ]),
      '/health',
    ],
  );
  await db.query(
    `INSERT INTO ${schema}.routes (method,"pathPattern","serviceId","authRequired") VALUES ('GET','/traffic',$1,false)`,
    [service],
  );
  const common = [
    `DATABASE_URL=postgres://metric_fixture:metric-fixture-only@${postgres}:5432/metric_fixture`,
    `REDIS_URL=redis://${redis}:6379`,
  ];
  const admin = run(
    'admin',
    images.admin,
    [
      ...common,
      `PLATFORM_JWT_SECRET=${secret}`,
      'OBJECT_STORAGE_ENABLED=false',
    ],
    [3001],
  );
  const adminUrl = `http://127.0.0.1:${port(admin, 3001)}/api`;
  await until(
    async () => (await fetch(`${adminUrl}/health`)).ok,
    'Production admin startup',
  );
  const plane = run(
    'plane',
    images.plane,
    [...common, 'PORT=3000', 'WS_PORT=8080'],
    [3000],
  );
  await until(
    async () =>
      (await fetch(`http://127.0.0.1:${port(plane, 3000)}/api/health`)).ok,
    'Production control-plane startup',
  );
  const gateway = run(
    'gateway',
    images.gateway,
    [
      `REDIS_URL=redis://${redis}:6379`,
      `JWT_SECRET=${secret}`,
      `GATEWAY_API_KEY=${apiKey}`,
      `CONTROL_PLANE_URL=ws://${plane}:8080`,
      'GRPC_ENABLED=false',
      'METRICS_REPORT_INTERVAL_MS=1000',
    ],
    [3000],
  );
  const gatewayUrl = `http://127.0.0.1:${port(gateway, 3000)}`;
  await until(
    async () => (await fetch(`${gatewayUrl}/health`)).ok,
    'Production gateway startup',
  );
  const streamUrl = `${adminUrl}/tenants/${tenant}/metrics/stream`;
  assert.equal((await fetch(streamUrl)).status, 401);
  assert.equal(
    (
      await fetch(`${adminUrl}/tenants/${randomUUID()}/metrics/stream`, {
        headers,
      })
    ).status,
    403,
  );
  const stream = await fetch(streamUrl, { headers, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  assert.ok(stream.body);
  reader = stream.body.getReader();
  const next = parser(reader);
  const receivedAt = Date.now();
  const deadline = setTimeout(() => controller.abort(), 10000);
  let sample;
  try {
    const pending = next((value) => value.rps > 0 && value.errorRate > 0);
    // Attach rejection handling before traffic assertions can abort the stream.
    void pending.catch(() => undefined);
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        fetch(
          `${gatewayUrl}/traffic/${index % 2 ? 'failure' : 'success'}?private=fixture`,
          { headers: { 'x-private-marker': 'fixture-should-not-export' } },
        ),
      ),
    );
    assert.equal(
      responses.filter((response) => response.status === 200).length,
      10,
    );
    assert.equal(
      responses.filter((response) => response.status === 502).length,
      10,
    );
    sample = await pending;
    assert.ok(
      Date.now() - receivedAt < 2000,
      'HTTP traffic reaches SSE within two seconds',
    );
  } finally {
    clearTimeout(deadline);
  }
  assert.ok(sample.p50Ms <= sample.p95Ms && sample.p95Ms <= sample.p99Ms);
  assert.ok(sample.errorRate > 0 && sample.errorRate <= 1);
  assert.ok(!JSON.stringify(sample).includes('fixture-should-not-export'));
  const stored = await db.query(
    `SELECT rps,"errorRate",timestamp FROM ${schema}.metrics_snapshots WHERE timestamp >= $1::timestamptz AND timestamp < $1::timestamptz + INTERVAL '1 millisecond'`,
    [sample.timestamp],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].rps, sample.rps);
  const history = await fetch(
    `${adminUrl}/tenants/${tenant}/metrics?period=1h`,
    { headers },
  );
  assert.ok(
    (await history.json()).some(
      (row) => row.timestamp === sample.timestamp && row.rps === sample.rps,
    ),
  );
  controller.abort();
  await reader.cancel().catch(() => undefined);
  reader = undefined;
  const reconnect = new AbortController();
  try {
    const response = await fetch(streamUrl, {
      headers,
      signal: reconnect.signal,
    });
    assert.equal(response.status, 200);
    const freshReader = response.body.getReader();
    const timeout = setTimeout(() => reconnect.abort(), 5000);
    try {
      const fresh = await parser(freshReader)();
      assert.ok(Date.parse(fresh.timestamp) >= Date.parse(sample.timestamp));
    } finally {
      clearTimeout(timeout);
      reconnect.abort();
      await freshReader.cancel().catch(() => undefined);
    }
  } finally {
    reconnect.abort();
  }
  const shutdown = [];
  for (const [name, role] of [
    [gateway, 'gateway'],
    [plane, 'plane'],
    [admin, 'admin'],
  ]) {
    docker('stop', '--time', '10', name);
    const state = JSON.parse(
      docker('inspect', name, '--format', '{{json .State}}'),
    );
    assert.equal(state.Running, false);
    assert.notEqual(
      state.ExitCode,
      137,
      `${role} must finish lifecycle cleanup before SIGKILL`,
    );
    shutdown.push({ role, exitCode: state.ExitCode });
  }
  const artifacts = resolve('.local-work');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    resolve(artifacts, 'metrics-container-evidence.json'),
    JSON.stringify(
      {
        images: Object.fromEntries(
          [
            [gateway, 'gateway'],
            [admin, 'admin'],
            [plane, 'plane'],
          ].map(([name, role]) => [
            role,
            docker('inspect', name, '--format', '{{.Image}}'),
          ]),
        ),
        trafficRequests: 20,
        shutdown,
        sample,
        checks: [
          'production-gateway-control-plane-PostgreSQL-Redis-admin-SSE-within-two-seconds',
          'authenticated-workspace-isolation',
          'persisted-fractional-RPS-and-history',
          'fresh-reconnect',
          'production-lifecycle-shutdown-without-SIGKILL',
          'private-payload-free-aggregates',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Production live metric pipeline checks passed with OrbStack: real HTTP completions, persistence, tenant authorization, SSE delivery and reconnect.',
  );
} catch (error) {
  mkdirSync(resolve('.local-work'), { recursive: true });
  for (const name of names) {
    try {
      writeFileSync(
        resolve('.local-work', `${name}.log`),
        docker('logs', name),
      );
    } catch {
      /* Container may have failed before creation. */
    }
  }
  throw error;
} finally {
  controller.abort();
  await reader?.cancel().catch(() => undefined);
  await db?.end().catch(() => undefined);
  for (const name of [...names].reverse()) {
    try {
      docker('rm', '-f', '-v', name);
    } catch {
      /* Already stopped. */
    }
  }
  upstream?.closeAllConnections();
  if (upstream) await new Promise((done) => upstream.close(done));
  if (networkCreated) docker('network', 'rm', network);
}
