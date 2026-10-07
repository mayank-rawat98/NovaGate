import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { startAlertFixture } from './alerts-container-fixture.mjs';
import { configureArchiveFixture } from './log-export-container-fixture.mjs';

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
const usageConsumer = randomUUID();
const usageConsumerKey = `gw_${tenant}_verification-only`;
const headers = {
  Authorization: `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '10m' })}`,
};
const controller = new AbortController();
let networkCreated = false;
let db;
let upstream;
let reader;
let alertFixture;
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
  const rustfs = run(
    'rustfs',
    'rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c',
    [
      'RUSTFS_ACCESS_KEY=novagate-verification',
      'RUSTFS_SECRET_KEY=local-object-storage-verification-only',
      'RUSTFS_CONSOLE_ENABLE=false',
      'RUSTFS_REGION=us-east-1',
    ],
    [9000],
  );
  const storageUrl = `http://127.0.0.1:${port(rustfs, 9000)}`;
  await until(
    async () => (await fetch(`${storageUrl}/health/ready`)).ok,
    'Private RustFS startup',
    60000,
  );

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
  await db.query(
    `INSERT INTO ${schema}.consumers (id,name,"keyHash") VALUES ($1,'Runtime usage consumer',$2)`,
    [
      usageConsumer,
      createHash('sha256').update(usageConsumerKey).digest('hex'),
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
  alertFixture = await startAlertFixture();
  const admin = run(
    'admin',
    images.admin,
    [
      ...common,
      `PLATFORM_JWT_SECRET=${secret}`,
      'OBJECT_STORAGE_ENABLED=true',
      `OBJECT_STORAGE_ENDPOINT=http://${rustfs}:9000`,
      'OBJECT_STORAGE_ACCESS_KEY=novagate-verification',
      'OBJECT_STORAGE_SECRET_KEY=local-object-storage-verification-only',
      'OBJECT_STORAGE_BUCKET=runtime-archives',
      'OBJECT_STORAGE_CREATE_BUCKET=true',

      ...alertFixture.environment,
    ],
    [3001],
  );
  const adminUrl = `http://127.0.0.1:${port(admin, 3001)}/api`;
  await until(
    async () => (await fetch(`${adminUrl}/health`)).ok,
    'Production admin startup',
  );
  const alertConfiguration = await alertFixture.configure(
    adminUrl,
    headers,
    tenant,
  );
  const archiveFixture = await configureArchiveFixture({
    adminUrl,
    tenant,
    headers,
  });
  const plane = run(
    'plane',
    images.plane,
    [...common, 'PORT=3000', 'WS_PORT=8080'],
    [3000, 8080],
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
  let gatewayUrl = `http://127.0.0.1:${port(gateway, 3000)}`;
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
          {
            headers: {
              'x-private-marker': 'fixture-should-not-export',
              authorization: `Bearer ${usageConsumerKey}`,
            },
          },
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
  const alerts = await alertFixture.verify({
    configuration: alertConfiguration,
    gatewayUrl,
    db,
    schema,
    tenant,
    until,
    trafficStartedAt: receivedAt,
  });
  const principalRequestIds = [randomUUID(), randomUUID()];
  const principalSubjects = [
    usageConsumer.toUpperCase(),
    'unrelated-principal-fixture',
  ];
  for (let i = 0; i < principalSubjects.length; i++) {
    const response = await fetch(`${gatewayUrl}/traffic/success`, {
      headers: {
        authorization: `Bearer ${jwt.sign({ sub: principalSubjects[i] }, secret, { expiresIn: '5m' })}`,
        'x-request-id': principalRequestIds[i],
      },
    });
    assert.equal(
      response.status,
      200,
      'Signed principal requests must retain their existing authentication behavior',
    );
  }
  await until(
    async () =>
      (
        await db.query(
          `SELECT id FROM ${schema}.request_logs WHERE "requestId"=ANY($1::text[])`,
          [principalRequestIds],
        )
      ).rowCount === 2,
    'Actual signed principal request persistence',
  );
  const principalRows = (
    await db.query(
      `SELECT "requestId","consumerId" FROM ${schema}.request_logs WHERE "requestId"=ANY($1::text[])`,
      [principalRequestIds],
    )
  ).rows;
  assert.equal(
    principalRows.find((row) => row.requestId === principalRequestIds[0])
      .consumerId,
    usageConsumer,
  );
  assert.equal(
    principalRows.find((row) => row.requestId === principalRequestIds[1])
      .consumerId,
    null,
  );
  await archiveFixture.lateLog(`ws://127.0.0.1:${port(plane, 8080)}`, apiKey);
  const archives = await archiveFixture.verify({
    db,
    schema,
    until,
    storageUrl,
    bucket: 'runtime-archives',
    trafficRequests: 22 + alerts.healthyRequests,
  });
  const usagePath = `${adminUrl}/tenants/${tenant}/consumers/${usageConsumer}/stats?period=1h`;
  assert.equal((await fetch(usagePath)).status, 401);
  assert.equal(
    (
      await fetch(
        `${adminUrl}/tenants/${randomUUID()}/consumers/${usageConsumer}/stats`,
        { headers },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(
        `${adminUrl}/tenants/${tenant}/consumers/${randomUUID()}/stats`,
        { headers },
      )
    ).status,
    404,
  );
  const usageResponse = await fetch(usagePath, { headers });
  assert.equal(usageResponse.status, 200);
  assert.equal(usageResponse.headers.get('cache-control'), 'no-store');
  const usage = await usageResponse.json();
  assert.equal(usage.source, 'persisted_request_logs');
  assert.equal(usage.requests, 21);
  assert.equal(usage.serverErrors, 10);
  assert.equal(usage.errorRate, 10 / 21);
  assert.equal(usage.rps, 21 / 3600);
  assert.equal(usage.series.length, 60);
  assert.equal(
    usage.series.reduce((sum, b) => sum + b.requests, 0),
    21,
  );
  const actualUsage = await db.query(
    `SELECT COUNT(*)::integer AS requests,percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseTimeMs") AS p95 FROM ${schema}.request_logs WHERE "consumerId"=$1 AND timestamp>=$2::timestamptz AND timestamp<$3::timestamptz`,
    [usageConsumer, usage.from, usage.to],
  );
  assert.equal(actualUsage.rows[0].requests, 21);
  assert.equal(usage.p95Ms, actualUsage.rows[0].p95);
  assert.equal(usage.topPaths.length, 1);
  assert.equal(usage.topPaths[0].path, '/traffic');
  assert.equal(usage.topPaths[0].requests, 21);
  assert.ok(!JSON.stringify(usage).includes(usageConsumerKey));
  assert.ok(!JSON.stringify(usage).includes('keyHash'));
  const consumerMetricsResponse = await fetch(
    `${adminUrl}/tenants/${tenant}/metrics?period=1h&consumerId=${usageConsumer}`,
    { headers },
  );
  assert.equal(consumerMetricsResponse.status, 200);
  const consumerMetrics = await consumerMetricsResponse.json();
  assert.equal(consumerMetrics.length, 60);
  assert.ok(consumerMetrics.some((b) => b.rps > 0));
  const consumerUsage = {
    requests: usage.requests,
    serverErrors: usage.serverErrors,
    p95Ms: usage.p95Ms,
    seriesBuckets: usage.series.length,
    checks: [
      'actual-consumer-key-attribution',
      'authenticated-isolated-statistics',
      'exact-persisted-UTC-counts-rates-percentiles',
      'filtered-metrics-with-private-consumer-metadata',
    ],
  };
  // The legacy-frame fixture deliberately replaces this tenant's sole gateway
  // socket; replacement is a permanent close. Restore the fixture gateway before
  // verifying subsequent live updates, without weakening production admission.
  docker('restart', gateway);
  // Ephemeral published ports can be reassigned on restart.
  gatewayUrl = `http://127.0.0.1:${port(gateway, 3000)}`;
  await until(
    async () => (await fetch(`${gatewayUrl}/health`)).ok,
    'Gateway restart after the legacy-frame replacement fixture',
  );
  const privacyUrl = `${adminUrl}/tenants/${tenant}/log-privacy`;
  let privacyState = await (await fetch(privacyUrl, { headers })).json();
  assert.deepEqual(privacyState.policy, {
    clientIp: 'omit',
    userAgent: 'omit',
  });
  await until(async () => {
    privacyState = await (await fetch(privacyUrl, { headers })).json();
    return privacyState.historicalCleanup === 'complete';
  }, 'Initial historical privacy cleanup');
  const savePrivacy = async (policy) => {
    const response = await fetch(privacyUrl, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ policy, expectedRevision: privacyState.revision }),
    });
    assert.equal(response.status, 200);
    privacyState = await response.json();
    await until(async () => {
      const cached = JSON.parse(
        docker('exec', redis, 'redis-cli', 'GET', 'cfg:default'),
      );
      const pending = await db.query(
        `SELECT 1 FROM public.pending_config_updates WHERE "tenantId"=$1`,
        [tenant],
      );
      return (
        cached?.tenantId === tenant &&
        cached.config?.logPrivacy?.clientIp === policy.clientIp &&
        pending.rowCount === 0
      );
    }, 'Privacy configuration installed and acknowledged by the production gateway');
  };
  await savePrivacy({ clientIp: 'retain', userAgent: 'retain' });
  const retainedRequestId = randomUUID();
  const retainedResponse = await fetch(`${gatewayUrl}/traffic/success`, {
    headers: {
      authorization: `Bearer ${usageConsumerKey}`,
      'x-request-id': retainedRequestId,
      'user-agent': 'privacy-fixture-agent',
    },
  });
  assert.equal(retainedResponse.status, 200);
  await until(
    async () =>
      (
        await db.query(
          `SELECT 1 FROM ${schema}.request_logs WHERE "requestId"=$1`,
          [retainedRequestId],
        )
      ).rowCount === 1,
    'Explicitly retained production request',
  );
  const retainedLog = (
    await db.query(
      `SELECT "clientIp","userAgent","consumerId" FROM ${schema}.request_logs WHERE "requestId"=$1`,
      [retainedRequestId],
    )
  ).rows[0];
  assert.notEqual(retainedLog.clientIp, '[redacted]');
  assert.equal(retainedLog.userAgent, 'privacy-fixture-agent');
  assert.equal(retainedLog.consumerId, usageConsumer);
  await savePrivacy({ clientIp: 'omit', userAgent: 'omit' });
  const omittedRequestId = randomUUID();
  assert.equal(
    (
      await fetch(`${gatewayUrl}/traffic/success`, {
        headers: {
          authorization: `Bearer ${usageConsumerKey}`,
          'x-request-id': omittedRequestId,
          'user-agent': 'privacy-fixture-agent',
        },
      })
    ).status,
    200,
  );
  await until(
    async () =>
      (
        await db.query(
          `SELECT 1 FROM ${schema}.request_logs WHERE "requestId"=$1 AND "clientIp"='[redacted]' AND "userAgent" IS NULL`,
          [omittedRequestId],
        )
      ).rowCount === 1,
    'Omitted production request fields',
  );
  await until(async () => {
    const state = await (await fetch(privacyUrl, { headers })).json();
    const privateRows = await db.query(
      `SELECT 1 FROM ${schema}.request_logs WHERE "clientIp" IS DISTINCT FROM '[redacted]' OR "userAgent" IS NOT NULL LIMIT 1`,
    );
    return state.historicalCleanup === 'complete' && privateRows.rowCount === 0;
  }, 'Historical production rows permanently minimized');
  const revokedArchive = (
    await db.query(
      `SELECT id FROM public.log_export_jobs WHERE tenant_id=$1 AND kind='scheduled' ORDER BY created_at LIMIT 1`,
      [tenant],
    )
  ).rows[0];
  assert.ok(revokedArchive);
  assert.equal(
    (
      await fetch(
        `${adminUrl}/tenants/${tenant}/log-exports/${revokedArchive.id}/download`,
        { headers },
      )
    ).status,
    404,
  );
  const logPrivacy = {
    gatewayConfigAcknowledged: true,
    retainedAndOmittedRequests: 2,
    historicalCleanup: 'complete',
    archivesRevoked: true,
    checks: [
      'conservative-defaults-and-legacy-collector-redaction',
      'revision-aware-save-and-durable-gateway-ACK',
      'explicit-retention-with-authentication-preserved',
      'historical-redaction-and-expired-private-archives',
    ],
  };
  const retentionUrl = `${adminUrl}/tenants/${tenant}/log-retention`;
  assert.equal((await fetch(retentionUrl)).status, 401);
  let retentionState = await (await fetch(retentionUrl, { headers })).json();
  assert.equal(retentionState.days, 30);
  assert.equal(retentionState.timeBasis, 'receipt');
  const oldRetained = randomUUID(),
    oldExpired = randomUUID();
  await db.query(
    `INSERT INTO ${schema}.request_logs
    (id,"consumerId",method,path,"statusCode","responseTimeMs",timestamp,"receivedAt","clientIp")
    VALUES ($1,$3,'GET','/retention-runtime',200,10,clock_timestamp(),clock_timestamp()-INTERVAL '5 days','[redacted]'),
    ($2,$3,'GET','/retention-runtime',500,900,clock_timestamp(),clock_timestamp()-INTERVAL '40 days','[redacted]')`,
    [oldRetained, oldExpired, usageConsumer],
  );
  const retainedLogs = async () => {
    const response = await fetch(
      `${adminUrl}/tenants/${tenant}/logs?path=%2Fretention-runtime`,
      { headers },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(
    (await retainedLogs()).map((log) => log.id),
    [oldRetained],
  );
  const usageBefore = await (
    await fetch(
      `${adminUrl}/tenants/${tenant}/consumers/${usageConsumer}/stats?period=1h`,
      { headers },
    )
  ).json();
  assert.equal(usageBefore.retention.days, 30);
  const queued = await fetch(`${adminUrl}/tenants/${tenant}/log-exports`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      pathPrefix: '/retention-runtime',
    }),
  });
  assert.equal(queued.status, 201);
  const archive = await queued.json();
  await until(async () => {
    const response = await fetch(`${adminUrl}/tenants/${tenant}/log-exports`, {
      headers,
    });
    const job = (await response.json()).jobs.find(
      (job) => job.id === archive.id,
    );
    return (
      job?.status === 'completed' &&
      job.rowCount === 1 &&
      job.retention?.days === 30
    );
  }, 'Retained-data archive processing');
  const saveRetention = async (days) => {
    const response = await fetch(retentionUrl, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ days, expectedRevision: retentionState.revision }),
    });
    assert.equal(response.status, 200);
    retentionState = await response.json();
    assert.equal(retentionState.days, days);
  };
  await saveRetention(1);
  assert.deepEqual(await retainedLogs(), []);
  const usageAfter = await (
    await fetch(
      `${adminUrl}/tenants/${tenant}/consumers/${usageConsumer}/stats?period=1h`,
      { headers },
    )
  ).json();
  assert.equal(usageAfter.requests, usageBefore.requests - 1);
  assert.equal(usageAfter.retention.days, 1);
  assert.equal(
    (
      await fetch(
        `${adminUrl}/tenants/${tenant}/log-exports/${archive.id}/download`,
        { headers },
      )
    ).status,
    404,
  );
  await saveRetention(90);
  assert.deepEqual(await retainedLogs(), []);
  const lateRead = await fetch(
    `${adminUrl}/tenants/${tenant}/logs?from=1999-01-01T00%3A00%3A00Z&to=2001-01-01T00%3A00%3A00Z`,
    { headers },
  );
  assert.equal(lateRead.status, 200);
  assert.ok(
    (await lateRead.json()).some(
      (log) => log.requestId === 'receipt-runtime-late',
    ),
  );
  await until(async () => {
    retentionState = await (await fetch(retentionUrl, { headers })).json();
    return (
      retentionState.cleanup === 'healthy' &&
      (
        await db.query(
          `SELECT 1 FROM ${schema}.request_logs WHERE id=ANY($1::uuid[])`,
          [[oldRetained, oldExpired]],
        )
      ).rowCount === 0
    );
  }, 'Bounded irreversible raw-log retention cleanup');
  const logRetention = {
    defaultDays: 30,
    finalDays: 90,
    cleanup: 'healthy',
    expiredRowsRemoved: 2,
    checks: [
      'authenticated-receipt-lifetime',
      'immediate-filter-and-consumer-coverage',
      'separate-private-archive-lifetime-and-revocation',
      'increasing-retention-does-not-resurrect',
      'late-request-time-with-fresh-receipt-is-preserved',
      'durable-bounded-database-cleanup',
    ],
  };
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
        alerts,
        archives,
        consumerUsage,
        logPrivacy,
        logRetention,
        consumerAttribution: {
          mappedJwt: true,
          unrelatedPrincipalRetained: true,
          legacyPrincipalIngested: true,
          jwtRequests: 2,
        },
        checks: [
          'production-gateway-control-plane-PostgreSQL-Redis-admin-SSE-within-two-seconds',
          'authenticated-workspace-isolation',
          'persisted-fractional-RPS-and-history',
          'fresh-reconnect',
          'production-lifecycle-shutdown-without-SIGKILL',
          'private-payload-free-aggregates',
          'automatic-receipt-window-RustFS-archives-with-late-log-and-private-downloads',
          'authenticated-consumer-key-usage-through-production-gateway-and-persistence',
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
      const output = spawnSync('docker', ['logs', name], {
        encoding: 'utf8',
        timeout: 10000,
      });
      writeFileSync(
        resolve('.local-work', `${name}.log`),
        (output.stdout ?? '') + (output.stderr ?? ''),
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
  await alertFixture?.close();
  if (networkCreated) docker('network', 'rm', network);
}
