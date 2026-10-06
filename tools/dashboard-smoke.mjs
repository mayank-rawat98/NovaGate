import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyAlertsDashboard } from './alerts-dashboard-smoke.mjs';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const base = process.env.DASHBOARD_VERIFY_URL ?? 'http://127.0.0.1:3333';
const artifacts = resolve('.local-work/dashboard-verification');
const hydrationPasses = Number(process.env.DASHBOARD_HYDRATION_PASSES ?? '1');
assert.ok(
  Number.isInteger(hydrationPasses) &&
    hydrationPasses >= 1 &&
    hydrationPasses <= 20,
  'DASHBOARD_HYDRATION_PASSES must be an integer from 1 to 20.',
);
mkdirSync(artifacts, { recursive: true });
const systemChrome =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.DASHBOARD_BROWSER_EXECUTABLE ??
  (existsSync(systemChrome) ? systemChrome : undefined);
const profile = mkdtempSync(resolve(artifacts, 'profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: true,
  acceptDownloads: true,
  downloadsPath: resolve(artifacts, 'downloads'),
  viewport: { width: 1440, height: 960 },
});
let traceStarted = false;
let traceWritten = false;
let passed = false;
let coldLoads = 0;
const startedAt = Date.now();
let metricsConnections = 0;
let metricsDisconnects = 0;
let failLiveMetrics = false;
const runtimeErrors = [];
const metricsServer = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', new URL(base).origin);
  response.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,accept',
  );
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    assert.equal(
      request.headers.authorization,
      'Bearer browser-verification-token',
    );
  } catch (error) {
    runtimeErrors.push(
      `Metric fixture: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"message":"Browser fixture contract failed"}');
    return;
  }
  metricsConnections++;
  if (failLiveMetrics) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Live fixture outage' }));
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (rps) =>
    response.write(
      `event: metrics\ndata: ${JSON.stringify({ rps, p50Ms: 1, p95Ms: 2, p99Ms: 3, errorRate: 0.01, timestamp: new Date().toISOString() })}\n\n`,
    );
  send(123.5);
  const update = setTimeout(() => send(321.25), 250);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 1000);
  response.once('close', () => {
    metricsDisconnects++;
    clearTimeout(update);
    clearInterval(heartbeat);
  });
});
await new Promise((resolve) => metricsServer.listen(0, '127.0.0.1', resolve));
const metricsOrigin = `http://127.0.0.1:${metricsServer.address().port}`;
const tenant = '12345678-1234-1234-1234-123456789abc';
const service = '23456789-1234-1234-1234-123456789abc';
const traceId = '0123456789abcdef0123456789abcdef';
let traceMode = 'normal';
const traceRequests = [];
const createdAt = '2026-10-04T12:00:00.000Z';
const routes = [
  {
    id: 'r1',
    method: 'GET',
    pathPattern: '/v1/products',
    serviceId: service,
    authRequired: true,
    enabled: true,
    plugins: [
      {
        name: 'oauth2-client-credentials',
        config: {
          introspectionEndpoint: 'https://identity.example.test/introspect',
          clientId: 'browser-client',
          clientSecret: 'verification-only-secret',
          audience: 'catalog',
        },
      },
      { name: 'graphql-guard', config: { maxDepth: 7 } },
      { name: 'cors', config: { origins: ['https://app.example.test'] } },
    ],
    createdAt,
  },
  {
    id: 'r2',
    method: 'POST',
    pathPattern: '/events',
    serviceId: service,
    authRequired: false,
    enabled: false,
    plugins: [
      { name: 'request-size-limit', config: { maxBodyBytes: 1048576 } },
      {
        name: 'hmac-auth',
        config: {
          mode: 'generic',
          header: 'x-hub-signature-256',
          algorithm: 'sha256',
          secrets: ['fixture-old', 'fixture-new'],
        },
      },
    ],
    createdAt,
  },
];
routes.push({
  id: 'r3',
  method: 'POST',
  pathPattern: '/graphql',
  serviceId: service,
  authRequired: false,
  enabled: true,
  graphql: { maxDepth: 4, maxComplexity: 20, introspectionAllowed: false },
  plugins: [],
  createdAt,
});
let graphqlSaves = 0;
let configuredCa;
let failCaSave = false;
let caSaves = 0;
let archivesEnabled = true;
let failArchiveCreate = false;
let failArchiveDownload = false;
let failArchiveRetry = false;
let failSchedule = '';
let scheduleConfiguration = null;
let scheduleBacklog = false;
const archives = ['queued', 'processing', 'completed', 'failed', 'expired'].map(
  (status, i) => ({
    id: `3456789${i}-1234-1234-1234-123456789abc`,
    status,
    filter: { from: createdAt, to: createdAt },
    attempts: 1,
    retryCount: 0,
    kind: 'manual',
    timeBasis: 'request',
    rowCount: status === 'completed' ? 1 : 0,
    bytes: 64,
    createdAt,
    expiresAt: new Date(
      Date.now() + (status === 'expired' ? -1 : 7) * 86400000,
    ).toISOString(),
    ...(status === 'failed'
      ? { error: 'Export could not finish. Retry or use a smaller date range.' }
      : {}),
  }),
);
const newArchiveId = '45678901-1234-1234-1234-123456789abc';
let failConsumerUsage = false;
let emptyConsumerUsage = false;
const consumerUsageRequests = [];
const otherTenant = '87654321-1234-1234-1234-123456789abc';
let failServices = false;
let serviceRequests = 0;
let servicePolicy = 'weighted-round-robin';
let servicePolicySaves = 0;
const violations = [];
const apiRequests = [];
const page = await context.newPage();
page.on('pageerror', (error) =>
  runtimeErrors.push(`${page.url()}: ${error.message}\n${error.stack ?? ''}`),
);
page.on('console', (message) => {
  if (
    message.type() === 'error' &&
    ![
      'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      'Failed to load resource: the server responded with a status of 400 (Bad Request)',
      'Failed to load resource: the server responded with a status of 409 (Conflict)',
    ].includes(message.text())
  )
    runtimeErrors.push(message.text());
});
await context.addInitScript(
  ({ tenant }) => {
    localStorage.setItem('gw_token', 'browser-verification-token');
    localStorage.setItem('gw_tenant_id', tenant);
  },
  { tenant },
);
const handleApiFixture = async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === metricsOrigin) {
    await route.continue();
    return;
  }
  apiRequests.push(url.pathname);
  assert.equal(
    url.origin,
    new URL(base).origin,
    'Dashboard must use its configured API origin',
  );
  const resource = url.pathname.split('/').at(-1);
  if (resource === 'stream' && url.pathname.endsWith('/metrics/stream')) {
    assert.equal(
      route.request().headers().authorization,
      'Bearer browser-verification-token',
    );
    assert.equal(url.search, '', 'Metric sessions must never appear in URLs');
    await route.continue({ url: `${metricsOrigin}${url.pathname}` });
    return;
  }

  if (resource === 'stats' && url.pathname.includes('/consumers/')) {
    assert.equal(route.request().method(), 'GET');
    assert.equal(
      route.request().headers().authorization,
      'Bearer browser-verification-token',
    );
    assert.match(url.pathname.split('/').at(-2), /^[a-f0-9-]{36}$/);
    const period = url.searchParams.get('period');
    assert(['1h', '24h', '7d'].includes(period));
    consumerUsageRequests.push({
      tenant:
        url.pathname.split('/')[url.pathname.split('/').indexOf('tenants') + 1],
      period,
    });
    if (failConsumerUsage) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Usage temporarily unavailable' }),
      });
      return;
    }
    const seconds = period === '1h' ? 3600 : period === '7d' ? 604800 : 86400;
    const bucketSeconds = period === '1h' ? 60 : period === '7d' ? 3600 : 900;
    const to = new Date().toISOString();
    const from = new Date(Date.parse(to) - seconds * 1000).toISOString();
    const counts = (requests, errors = 0) => ({
      requests,
      serverErrors: errors,
      errorRate: requests ? errors / requests : 0,
      rps: requests / seconds,
      latencySamples: requests,
      p50Ms: requests ? 50 : null,
      p95Ms: requests ? 120 : null,
      p99Ms: requests ? 150 : null,
    });
    const series = Array.from({ length: seconds / bucketSeconds }, (_, i) => ({
      ...counts(
        emptyConsumerUsage
          ? 0
          : i === 0
            ? 12
            : i === seconds / bucketSeconds - 1
              ? 8
              : 0,
        emptyConsumerUsage ? 0 : i === 0 ? 4 : 0,
      ),
      timestamp: new Date(
        Date.parse(from) + i * bucketSeconds * 1000,
      ).toISOString(),
      rps: emptyConsumerUsage
        ? 0
        : (i === 0 ? 12 : i === seconds / bucketSeconds - 1 ? 8 : 0) /
          bucketSeconds,
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...counts(emptyConsumerUsage ? 0 : 20, emptyConsumerUsage ? 0 : 4),
        consumer: {
          id: url.pathname.split('/').at(-2),
          name: 'Storefront app',
          revokedAt: null,
        },
        period,
        from,
        to,
        generatedAt: to,
        source: 'persisted_request_logs',
        bucketSeconds,
        rowLimit: 100000,
        series,
        topPaths: emptyConsumerUsage
          ? []
          : [{ ...counts(20, 4), method: 'GET', path: '/orders' }],
      }),
    });
    return;
  }

  if (url.pathname.includes('/traces')) {
    traceRequests.push(url.searchParams.toString());
    const detail = url.pathname.endsWith(`/${traceId}`);
    const fail = traceMode === 'error';
    const spans = [
      {
        traceId,
        spanId: '0123456789abcdef',
        name: 'Gateway request',
        kind: 'server',
        timestamp: createdAt,
        durationMs: 24.125,
        status: 'error',
        attributes: { 'http.route': '/orders', 'gateway.request.id': tenant },
      },
      {
        traceId,
        spanId: '1123456789abcdef',
        parentSpanId: '0123456789abcdef',
        name: 'upstream HTTP1',
        kind: 'client',
        timestamp: createdAt,
        durationMs: 12.25,
        status: 'error',
        attributes: { 'http.response.status_code': 502 },
      },
    ];
    await route.fulfill({
      status: fail ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        fail
          ? { message: 'Trace fixture outage' }
          : detail
            ? { traceId, spans, truncated: true }
            : {
                traces:
                  traceMode === 'empty'
                    ? []
                    : [
                        {
                          traceId,
                          timestamp: createdAt,
                          durationMs: 24.125,
                          spanCount: 2,
                          status: 'error',
                          route: '/orders',
                          requestId: tenant,
                        },
                      ],
                nextCursor: url.searchParams.has('cursor')
                  ? null
                  : 'fixture-next-page',
              },
      ),
    });
    return;
  }

  if (resource === 'ca-cert' && route.request().method() === 'PUT') {
    caSaves++;
    const body = route.request().postDataJSON();
    if (!failCaSave) configuredCa = body.caCertPem ?? undefined;
    await route.fulfill({
      status: failCaSave ? 400 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        failCaSave
          ? {
              message:
                'Provide an active CA certificate bundle. Leaf certificates and private keys are not accepted.',
            }
          : { success: true },
      ),
    });
    return;
  }
  if (url.pathname.includes('/routes/') && route.request().method() === 'PUT') {
    const dto = route.request().postDataJSON();
    if (url.pathname.endsWith('/r3')) {
      assert.equal(dto.graphql, null);
      if (graphqlSaves++ === 0)
        assert.deepEqual(dto.plugins, [
          {
            name: 'graphql-guard',
            config: {
              maxDepth: 5,
              maxComplexity: 30,
              introspectionAllowed: false,
            },
          },
        ]);
      else assert.deepEqual(dto.plugins, []);
      routes[2] = { ...routes[2], ...dto };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(routes[2]),
      });
      return;
    }
    if (url.pathname.endsWith('/r2')) {
      assert.deepEqual(
        dto.plugins.map((p) => p.name),
        ['request-size-limit', 'hmac-auth'],
      );
      assert.deepEqual(dto.plugins[0].config, { maxBodyBytes: 1048576 });
      assert.deepEqual(dto.plugins[1].config, {
        mode: 'stripe',
        header: 'stripe-signature',
        algorithm: 'sha256',
        secrets: ['fixture-old', 'fixture-new'],
        maxClockSkewSeconds: 300,
      });
      routes[1] = { ...routes[1], ...dto };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(routes[1]),
      });
      return;
    }
    assert.deepEqual(
      dto.plugins.map((entry) => entry.name),
      ['oauth2-client-credentials', 'graphql-guard', 'cors'],
    );
    assert.deepEqual(dto.plugins[1].config, {
      maxDepth: 7,
      maxComplexity: 1000,
      introspectionAllowed: false,
    });
    assert.equal(dto.graphql, null);
    const oauth = dto.plugins[0].config;
    assert.equal(oauth.tokenEndpoint, 'https://identity.example.test/token');
    assert.equal(oauth.introspectionEndpoint, undefined);
    assert.equal(oauth.clientSecret, 'verification-only-secret');
    assert.deepEqual(oauth.scopes, ['read', 'write']);
    routes[0] = { ...routes[0], ...dto };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(routes[0]),
    });
    return;
  }
  let body = [];
  let status = 200;
  if (url.pathname.includes('/log-exports/') && resource === 'schedule') {
    const method = route.request().method();
    let status = 200;
    let problem;
    if (method === 'PUT' || method === 'DELETE') {
      const dto = route.request().postDataJSON();
      if (failSchedule === 'outage') {
        status = 503;
        problem = 'Schedule temporarily unavailable';
      } else if (
        failSchedule === 'revision' ||
        dto.expectedRevision !== (scheduleConfiguration?.revision ?? null)
      ) {
        status = 409;
        problem = 'The archive schedule changed. Refresh it before saving.';
      } else if (method === 'DELETE') {
        scheduleConfiguration = null;
      } else {
        assert.deepEqual(Object.keys(dto).sort(), [
          'cadence',
          'enabled',
          'expectedRevision',
          'filter',
        ]);
        assert.equal(typeof dto.enabled, 'boolean');
        assert.ok(['near_real_time', 'hourly'].includes(dto.cadence));
        assert.ok(
          Object.keys(dto.filter).every((key) =>
            ['minStatusCode', 'pathPrefix', 'consumerId'].includes(key),
          ),
        );
        if (dto.filter.consumerId)
          assert.match(dto.filter.consumerId, /^[a-f0-9-]{36}$/);
        const now = new Date().toISOString();
        scheduleConfiguration = {
          id: scheduleConfiguration?.id ?? randomUUID(),
          revision: randomUUID(),
          enabled: dto.enabled,
          cadence: dto.cadence,
          filter: dto.filter,
          startedAt: scheduleConfiguration?.startedAt ?? now,
          cursor: scheduleConfiguration?.cursor ?? now,
          nextWindowAt: new Date(Date.now() + 60000).toISOString(),
          updatedAt: now,
          lastCheckedAt: now,
        };
      }
    } else assert.equal(method, 'GET');
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        problem
          ? { message: problem }
          : {
              available: archivesEnabled,
              schedule: scheduleConfiguration
                ? {
                    ...scheduleConfiguration,
                    ...(scheduleBacklog
                      ? {
                          nextWindowAt: new Date(
                            Date.now() - 3600000,
                          ).toISOString(),
                          error:
                            'Waiting for pending archives; unprocessed windows are retained',
                        }
                      : {}),
                  }
                : null,
              settlementSeconds: 15,
              pendingJobs: scheduleBacklog ? 20 : 0,
              failedJobs: scheduleBacklog ? 1 : 0,
              backlogSeconds: scheduleBacklog ? 3600 : 0,
              queueLimit: 20,
            },
      ),
    });
    return;
  }
  if (url.pathname.includes('/log-exports/') && resource === 'retry') {
    assert.equal(route.request().method(), 'POST');
    const id = url.pathname.split('/').at(-2);
    const job = archives.find((entry) => entry.id === id);
    assert.ok(job);
    assert.equal(job.status, 'failed');
    if (!failArchiveRetry) {
      job.status = 'queued';
      job.attempts = 0;
      job.retryCount++;
      delete job.error;
    }
    await route.fulfill({
      status: failArchiveRetry ? 503 : 201,
      contentType: 'application/json',
      body: JSON.stringify(
        failArchiveRetry ? { message: 'Retry temporarily unavailable' } : job,
      ),
    });
    return;
  }
  if (url.pathname.includes('/log-exports/') && resource === 'download') {
    await route.fulfill({
      status: failArchiveDownload ? 503 : 200,
      contentType: 'application/x-ndjson',
      body: failArchiveDownload
        ? 'Verification download outage'
        : '{"requestId":"fixture-archive","path":"/v1/products"}\n',
    });
    return;
  }
  if (resource === 'log-exports') {
    if (route.request().method() === 'POST') {
      const filter = route.request().postDataJSON();
      assert.equal(filter.minStatusCode, 500);
      assert.equal(filter.pathPrefix, '/v1/');
      const job = {
        ...archives[0],
        id: newArchiveId,
        status: 'queued',
        filter,
      };
      if (!failArchiveCreate) archives.unshift(job);
      await route.fulfill({
        status: failArchiveCreate ? 503 : 201,
        contentType: 'application/json',
        body: JSON.stringify(
          failArchiveCreate ? { message: 'Verification queue outage' } : job,
        ),
      });
    } else
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: archivesEnabled,
          retentionDays: 7,
          jobs: archives,
        }),
      });
    return;
  }
  if (route.request().method() === 'PUT' && resource === service) {
    const submitted = route.request().postDataJSON();
    assert.equal(
      submitted.loadBalancing,
      servicePolicySaves++ === 0 ? 'least-connections' : 'weighted-round-robin',
    );
    assert.equal(submitted.name, 'Catalog API');
    assert.deepEqual(submitted.targets, [
      { url: 'https://catalog.example.test', weight: 100 },
    ]);
    servicePolicy = submitted.loadBalancing;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: service, ...submitted, createdAt }),
    });
    return;
  }
  if (route.request().method() === 'POST' && resource === 'services') {
    const submitted = route.request().postDataJSON();
    assert.equal(submitted.loadBalancing, 'least-connections');
    assert.equal(submitted.healthCheckIntervalMs, 1500);
    assert.equal(submitted.unhealthyFallback, true);
    assert.equal(submitted.healthCheckProtocol, 'grpc');
    assert.equal(submitted.healthCheckService, 'test.Echo');
    assert.equal(submitted.h2, true);
    assert.equal(submitted.supportsWebSocket, true);
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Verification save failure' }),
    });
    return;
  }
  if (route.request().method() === 'POST' && resource === 'consumers') {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'c2',
        name: 'Test consumer',
        apiKey: 'verification-only-consumer-key',
        createdAt,
      }),
    });
    return;
  }
  if (url.pathname.split('/').length === 4 && /^[a-f0-9-]{36}$/.test(resource))
    body = {
      id: resource,
      name: 'Bluebird Studio',
      email: 'demo@example.test',
      planId: 'free',
      gatewayConfigVersion: 12,
      caCertPem: configuredCa,
      createdAt,
    };
  else if (resource === 'gateway-status')
    body = { tenantId: tenant, online: true };
  else if (resource === 'routes') body = routes;
  else if (resource === 'services') {
    serviceRequests++;
    body = [
      {
        id: service,
        name: 'Catalog API',
        loadBalancing: servicePolicy,
        targets: [{ url: 'https://catalog.example.test', weight: 100 }],
        healthCheckPath: '/health',
        timeoutMs: 10000,
        createdAt,
      },
    ];
    if (failServices) {
      status = 503;
      body = { message: 'Verification outage' };
    }
  } else if (resource === 'health')
    body = [{ serviceId: service, status: 'degraded', checkedAt: createdAt }];
  else if (resource === 'metrics')
    body = Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(Date.parse(createdAt) + i * 60000).toISOString(),
      rps: 24 + i * 2,
      errorRate: 0.012,
      p50Ms: 18,
      p95Ms: 64,
      p99Ms: 112,
    }));
  else if (resource === 'logs')
    body = [
      {
        id: 'log1',
        requestId: 'req1',
        method: 'GET',
        path: '/v1/products',
        statusCode: 200,
        responseTimeMs: 24,
        timestamp: createdAt,
      },
    ];
  else if (resource === 'consumers')
    body = [
      {
        id: '56789012-1234-1234-1234-123456789abc',
        name: 'Storefront app',
        groups: ['read-only'],
        rateLimitTier: 'authenticated',
        createdAt,
      },
    ];
  else if (resource !== 'errors')
    throw new Error(`Unexpected verification API path: ${url.pathname}`);
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
};
await context.route('**/api/**', async (route) => {
  try {
    await handleApiFixture(route);
  } catch (error) {
    runtimeErrors.push(
      `Fixture ${route.request().url()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    await route
      .fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"message":"Browser fixture contract failed"}',
      })
      .catch(() => undefined);
  }
});
async function audit(label) {
  await page.addScriptTag({ path: require.resolve('axe-core') });
  const result = await page.evaluate(async () =>
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    }),
  );
  for (const violation of result.violations)
    violations.push({
      page: label,
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    });
}
try {
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  traceStarted = true;
  await expect(async () => {
    const response = await page.request.get(base);
    expect(response.ok()).toBeTruthy();
  }).toPass({ timeout: 60000 });
  // Cold loads exercise the server/session boundary independently of client navigation.
  const browserSession = await context.newCDPSession(page);
  await browserSession.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  for (let pass = 0; pass < hydrationPasses; pass++) {
    for (const path of [
      '/dashboard',
      '/services',
      '/routes',
      '/consumers',
      '/logs',
      '/traces',
      '/settings',
    ]) {
      await page.goto(`${base}${path}`);
      await expect(
        page
          .getByRole('complementary')
          .getByText('Bluebird Studio', { exact: true }),
      ).toBeVisible();
      coldLoads++;
    }
  }
  await browserSession.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await browserSession.detach();
  await page.goto(`${base}/dashboard`);
  await expect(
    page.getByRole('heading', { name: 'Your traffic, at a glance.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('complementary').getByText('Bluebird Studio'),
  ).toBeVisible();
  await expect(
    page
      .getByText('Active routes')
      .locator('..')
      .getByText('2', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(artifacts, 'desktop.png'),
    fullPage: true,
  });
  await audit('overview desktop');
  await expect(
    page.getByText('Live metrics connected', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('321.25', { exact: true })).toBeVisible();
  const established = metricsConnections;
  assert(
    established > 0,
    'Overview must connect to the authenticated SSE fixture',
  );
  failLiveMetrics = true;
  await page
    .getByRole('button', { name: 'Reconnect metrics', exact: true })
    .click();
  await expect(
    page.getByText('Reconnecting live metrics.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('321.25', { exact: true })).toBeVisible();
  failLiveMetrics = false;
  await page
    .getByRole('button', { name: 'Reconnect metrics', exact: true })
    .click();
  await expect(
    page.getByText('Live metrics connected', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('321.25', { exact: true })).toBeVisible();
  assert(
    metricsConnections > established,
    'Manual retry must establish a new authenticated stream',
  );
  await audit('Live metric reconnect desktop');

  failServices = true;
  await page.goto(`${base}/services`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Services could not be loaded' }),
  ).toContainText('Services could not be loaded');
  failServices = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Catalog API', { exact: true })).toBeVisible();
  assert(serviceRequests >= 2, 'Retry must fetch the list again');
  await expect(page.getByText('degraded', { exact: true })).toBeVisible();
  await expect.poll(() => metricsDisconnects).toBeGreaterThan(0);
  await audit('services desktop');
  for (const policy of ['least-connections', 'weighted-round-robin']) {
    await page
      .getByRole('button', { name: 'Edit service', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Services form' });
    await expect(
      dialog.getByLabel('Load balancing', { exact: true }),
    ).toHaveValue(servicePolicy);
    await dialog
      .getByLabel('Load balancing', { exact: true })
      .selectOption(policy);
    if (policy === 'least-connections')
      await expect(
        dialog.getByText(/Counts are local to each gateway/),
      ).toBeVisible();
    await audit(`service balancing ${policy}`);
    await dialog
      .getByRole('button', { name: 'Save Changes', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(page.getByText('Catalog API', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Edit service', exact: true })
      .click();
    await expect(
      dialog.getByLabel('Load balancing', { exact: true }),
    ).toHaveValue(policy);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
  assert.equal(servicePolicySaves, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/dashboard`);
  await expect(
    page.getByRole('heading', { name: 'Your traffic, at a glance.' }),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    'Mobile overview must fit the viewport',
  );
  await page.screenshot({
    path: resolve(artifacts, 'mobile.png'),
    fullPage: true,
  });
  const openMenu = page.getByRole('button', { name: 'Open navigation' });
  await openMenu.click();
  const menu = page.getByRole('dialog', {
    name: 'Workspace navigation',
    exact: true,
  });
  await expect(menu).toBeVisible();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate(
        () => !!document.activeElement.closest('dialog:modal'),
      ),
      'Mobile navigation must contain keyboard focus',
    );
  }
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(openMenu).toBeFocused();
  await openMenu.click();
  await menu.getByRole('link', { name: 'Routes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Routes', exact: true }),
  ).toBeVisible();
  await expect(menu).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Edit GET /v1/products', exact: true })
    .click();
  const oauthDrawer = page.getByRole('dialog', {
    name: 'Routes form',
    exact: true,
  });
  await oauthDrawer.getByRole('button', { name: /^plugins/i }).click();
  await expect(
    oauthDrawer.getByLabel('OAuth client ID', { exact: true }),
  ).toHaveValue('browser-client');
  await expect(
    oauthDrawer.getByLabel('OAuth client secret', { exact: true }),
  ).toHaveAttribute('type', 'password');
  await expect(
    oauthDrawer.getByLabel('OAuth expected audience (optional)', {
      exact: true,
    }),
  ).toHaveValue('catalog');
  await audit('OAuth introspection form mobile');
  await oauthDrawer
    .getByLabel('OAuth purpose', { exact: true })
    .selectOption('outbound');
  await expect(
    oauthDrawer.getByText(/does not authenticate your clients/),
  ).toBeVisible();
  await oauthDrawer
    .getByLabel('Token endpoint', { exact: true })
    .fill('https://identity.example.test/token');
  await oauthDrawer
    .getByLabel('OAuth scopes (comma separated)', { exact: true })
    .fill('read, write');
  await audit('OAuth outbound form mobile');
  await oauthDrawer
    .getByRole('button', { name: 'Save Changes', exact: true })
    .click();
  await expect(oauthDrawer).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Edit POST /events', exact: true })
    .click();
  const hmacDrawer = page.getByRole('dialog', {
    name: 'Routes form',
    exact: true,
  });
  await hmacDrawer.getByRole('button', { name: /^plugins/i }).click();
  await expect(
    hmacDrawer.getByLabel('Webhook signature format', { exact: true }),
  ).toHaveValue('generic');
  await expect(
    hmacDrawer.getByText(/Body-only signatures do not prevent replays/),
  ).toBeVisible();
  await hmacDrawer
    .getByLabel('Webhook signature format', { exact: true })
    .selectOption('stripe');
  await expect(
    hmacDrawer.getByLabel('Signature Header', { exact: true }),
  ).toHaveValue('stripe-signature');
  await expect(
    hmacDrawer.getByLabel('Algorithm', { exact: true }),
  ).toBeDisabled();
  await expect(
    hmacDrawer.getByLabel('Timestamp Header (optional)', { exact: true }),
  ).toHaveCount(0);
  await hmacDrawer
    .getByLabel('Max Clock Skew (seconds)', { exact: true })
    .fill('300');
  await audit('Stripe webhook format mobile');
  await hmacDrawer
    .getByRole('button', { name: 'Save Changes', exact: true })
    .click();
  await expect(hmacDrawer).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Edit POST /events', exact: true })
    .click();
  await hmacDrawer.getByRole('button', { name: /^plugins/i }).click();
  await expect(
    hmacDrawer.getByLabel('Webhook signature format', { exact: true }),
  ).toHaveValue('stripe');
  await expect(
    hmacDrawer.getByLabel('Secrets (one per line — supports rotation)', {
      exact: true,
    }),
  ).toHaveValue('fixture-old\nfixture-new');
  await page.keyboard.press('Escape');
  await expect(hmacDrawer).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Edit POST /graphql', exact: true })
    .click();
  const graphqlDrawer = page.getByRole('dialog', {
    name: 'Routes form',
    exact: true,
  });
  await graphqlDrawer.getByRole('button', { name: /^plugins/i }).click();
  await expect(
    graphqlDrawer.getByLabel('GraphQL maximum depth', { exact: true }),
  ).toHaveValue('4');
  await expect(
    graphqlDrawer.getByLabel('GraphQL maximum complexity', { exact: true }),
  ).toHaveValue('20');
  await expect(
    graphqlDrawer.getByRole('switch', {
      name: 'Allow GraphQL introspection',
      exact: true,
    }),
  ).toHaveAttribute('aria-checked', 'false');
  await graphqlDrawer
    .getByLabel('GraphQL maximum depth', { exact: true })
    .fill('5');
  await graphqlDrawer
    .getByLabel('GraphQL maximum complexity', { exact: true })
    .fill('30');
  await audit('GraphQL policy and legacy route conversion mobile');
  await graphqlDrawer
    .getByRole('button', { name: 'Save Changes', exact: true })
    .click();
  await expect(graphqlDrawer).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Edit POST /graphql', exact: true })
    .click();
  await graphqlDrawer.getByRole('button', { name: /^plugins/i }).click();
  await expect(
    graphqlDrawer.getByLabel('GraphQL maximum depth', { exact: true }),
  ).toHaveValue('5');
  await expect(
    graphqlDrawer.getByLabel('GraphQL maximum complexity', { exact: true }),
  ).toHaveValue('30');
  await graphqlDrawer
    .getByRole('switch', { name: 'GraphQL Guard plugin', exact: true })
    .click();
  await graphqlDrawer
    .getByRole('button', { name: 'Save Changes', exact: true })
    .click();
  await expect(graphqlDrawer).not.toBeVisible();
  assert.equal(graphqlSaves, 2);
  const addRoute = page.getByRole('button', { name: 'Add Route', exact: true });
  await addRoute.click();
  const drawer = page.getByRole('dialog', { name: 'Routes form', exact: true });
  await expect(drawer).toBeVisible();
  assert(
    await drawer
      .locator(':scope > div')
      .evaluate(
        (element) => element.getBoundingClientRect().width <= window.innerWidth,
      ),
    'Route drawer must fit the viewport',
  );
  await page.screenshot({
    path: resolve(artifacts, 'mobile-route-form.png'),
    fullPage: true,
  });
  await audit('route form mobile');
  await drawer.getByRole('button', { name: 'advanced', exact: true }).click();
  await drawer
    .getByRole('switch', { name: 'Retry policy', exact: true })
    .click();
  await audit('route advanced form mobile');
  await drawer.getByRole('button', { name: /^plugins/i }).click();
  for (const toggle of await drawer.getByRole('switch').all()) {
    if (
      (await toggle.getAttribute('aria-label'))?.endsWith(' plugin') &&
      (await toggle.getAttribute('aria-checked')) === 'false'
    )
      await toggle.click();
  }
  await audit('all route plugins mobile');
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate(
        () => !!document.activeElement.closest('dialog:modal'),
      ),
      'Route form must contain keyboard focus',
    );
  }
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(addRoute).toBeFocused();
  for (const [path, heading, button, dialogLabel] of [
    ['/services', 'Services', 'Add Service', 'Services form'],
    ['/consumers', 'Consumers', 'Add Consumer', 'Consumer form'],
  ]) {
    await page.goto(`${base}${path}`);
    await expect(
      page.getByRole('heading', { name: heading, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(page.getByRole('dialog', { name: dialogLabel })).toBeVisible();
    await audit(`${heading} form mobile`);
    if (path === '/services') {
      const serviceDialog = page.getByRole('dialog', { name: dialogLabel });
      await serviceDialog
        .getByLabel('Name', { exact: true })
        .fill('Test service');
      await serviceDialog
        .getByLabel('Target 1 URL', { exact: true })
        .fill('https://upstream.example.test');
      await serviceDialog
        .getByLabel('Health check interval (ms)', { exact: true })
        .fill('1500');
      await serviceDialog
        .getByRole('checkbox', { name: /Try failed targets/ })
        .check();
      await serviceDialog
        .getByLabel('Health check protocol', { exact: true })
        .selectOption('grpc');
      await serviceDialog
        .getByLabel('gRPC health service name', { exact: true })
        .fill('test.Echo');
      await serviceDialog
        .getByRole('checkbox', { name: /Use HTTP\/2 for upstream/ })
        .check();
      await serviceDialog
        .getByRole('checkbox', { name: 'Allow WebSocket upgrades' })
        .check();
      await serviceDialog
        .getByLabel('Load balancing', { exact: true })
        .selectOption('least-connections');
      await audit('Services native gRPC form mobile');
      await serviceDialog
        .getByRole('button', { name: 'Add Service', exact: true })
        .click();
      await expect(serviceDialog.getByRole('alert')).toHaveText(
        'Service could not be saved. Please try again.',
      );
      await expect(
        serviceDialog.getByLabel('Name', { exact: true }),
      ).toHaveValue('Test service');
      await expect(
        serviceDialog.getByLabel('Load balancing', { exact: true }),
      ).toHaveValue('least-connections');
      await audit('service save failure mobile');
    }
    if (path === '/consumers') {
      await page.getByLabel('Name', { exact: true }).fill('Test consumer');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      const keyDialog = page.getByRole('dialog', {
        name: 'Consumer API key',
        exact: true,
      });
      await expect(keyDialog).toBeVisible();
      await expect(
        keyDialog.getByText('verification-only-consumer-key'),
      ).toBeVisible();
      await audit('consumer one-time key dialog');
    }
    await page.keyboard.press('Escape');
  }
  await page.goto(`${base}/consumers`);
  const usageButton = page.getByRole('button', {
    name: 'View usage for Storefront app',
    exact: true,
  });
  await expect(usageButton).toBeVisible();
  failConsumerUsage = true;
  await usageButton.click();
  const usageDialog = page.getByRole('dialog', {
    name: 'Consumer usage',
    exact: true,
  });
  await expect(usageDialog).toBeVisible();
  await expect(usageDialog.getByRole('alert')).toContainText(
    'could not be refreshed',
  );
  await expect(
    usageDialog.getByLabel('Usage period', { exact: true }),
  ).toHaveValue('24h');
  failConsumerUsage = false;
  await usageDialog
    .getByRole('button', { name: 'Refresh usage', exact: true })
    .click();
  await expect(
    usageDialog.getByRole('heading', { name: 'Storefront app', exact: true }),
  ).toBeVisible();
  await expect(usageDialog.getByText('20%', { exact: true })).toBeVisible();
  await expect(
    usageDialog.getByRole('region', { name: 'Consumer top paths table' }),
  ).toContainText('GET /orders');
  await usageDialog
    .getByLabel('Usage period', { exact: true })
    .selectOption('1h');
  await expect
    .poll(() =>
      consumerUsageRequests.some((request) => request.period === '1h'),
    )
    .toBe(true);
  await expect(usageDialog.getByText(/over 1 minute/)).toBeVisible();
  const interval = usageDialog.getByLabel('Inspect an interval', {
    exact: true,
  });
  await interval.focus();
  await page.keyboard.press('End');
  await expect(interval).toHaveValue('59');
  await expect(
    usageDialog.getByText(/8 requests · 0 server errors/),
  ).toBeVisible();
  failConsumerUsage = true;
  await usageDialog
    .getByRole('button', { name: 'Refresh usage', exact: true })
    .click();
  await expect(usageDialog.getByRole('alert')).toContainText(
    'previous successful refresh',
  );
  await expect(usageDialog.getByText('20%', { exact: true })).toBeVisible();
  await audit('consumer usage stale recovery mobile');
  failConsumerUsage = false;
  emptyConsumerUsage = true;
  await usageDialog
    .getByLabel('Usage period', { exact: true })
    .selectOption('7d');
  await expect(usageDialog.getByRole('status')).toContainText(
    'No recorded requests',
  );
  await expect(
    usageDialog.getByRole('region', { name: 'Consumer top paths table' }),
  ).toContainText('No paths recorded');
  await audit('consumer usage empty mobile');
  emptyConsumerUsage = false;
  await usageDialog
    .getByRole('button', { name: 'Refresh usage', exact: true })
    .click();
  await expect(usageDialog.getByText('20%', { exact: true })).toBeVisible();
  await expect(
    usageDialog.getByText('0.000033', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(artifacts, 'consumer-usage-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await audit('consumer usage desktop');
  await page.screenshot({
    path: resolve(artifacts, 'consumer-usage-desktop.png'),
    fullPage: true,
  });
  const usageClose = usageDialog.getByRole('button', {
    name: 'Close consumer usage',
    exact: true,
  });
  await usageClose.focus();
  await page.keyboard.press('Shift+Tab');
  assert(
    await page.evaluate(() => !!document.activeElement.closest('dialog:modal')),
    'Usage dialog wraps keyboard focus',
  );
  await page.keyboard.press('Escape');
  await expect(usageDialog).not.toBeVisible();
  await expect(usageButton).toBeFocused();
  await usageButton.click();
  await expect(usageDialog).toBeVisible();
  await page.evaluate((other) => {
    localStorage.setItem('gw_tenant_id', other);
    window.dispatchEvent(new Event('storage'));
  }, otherTenant);
  await expect(usageDialog).not.toBeVisible();
  await page
    .getByRole('button', { name: 'View usage for Storefront app', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Consumer usage', exact: true })
      .getByLabel('Usage period', { exact: true }),
  ).toHaveValue('24h');
  await expect
    .poll(() =>
      consumerUsageRequests.some((request) => request.tenant === otherTenant),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await page.evaluate((current) => {
    localStorage.setItem('gw_tenant_id', current);
    window.dispatchEvent(new Event('storage'));
  }, tenant);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of [
    '/routes',
    '/consumers',
    '/errors',
    '/logs',
    '/traces',
    '/settings',
  ]) {
    await page.goto(`${base}${path}`);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `${path} must fit the mobile viewport`,
    );
    await audit(path);
  }
  await page.goto(`${base}/traces`);
  await expect(
    page.getByRole('heading', { name: 'Traces', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: traceId, exact: true }),
  ).toBeVisible();
  await page.getByLabel('Trace ID', { exact: true }).fill(traceId);
  await page.getByLabel('Request ID', { exact: true }).fill(tenant);
  await page.getByLabel('Route', { exact: true }).fill('/orders');
  await page.getByLabel('Errors only', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Search traces', exact: true })
    .click();
  await expect
    .poll(() =>
      traceRequests.some((value) => {
        const query = new URLSearchParams(value);
        return (
          query.get('traceId') === traceId &&
          query.get('requestId') === tenant &&
          query.get('route') === '/orders' &&
          query.get('errorsOnly') === 'true' &&
          query.has('from') &&
          query.has('to')
        );
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: traceId, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Request timeline' }),
  ).toBeVisible();
  await expect(
    page.getByText('This large trace is truncated.', { exact: false }),
  ).toBeVisible();
  await page.locator('summary').filter({ hasText: 'upstream HTTP1' }).click();
  await expect(
    page.getByText('http.response.status_code', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('12.25 ms', { exact: false }).first(),
  ).toBeVisible();
  await audit('Trace filters and waterfall mobile');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Next', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
  traceMode = 'empty';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('No traces match.', { exact: false }),
  ).toBeVisible();
  traceMode = 'error';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Traces could not be loaded' }),
  ).toContainText('Traces could not be loaded');
  traceMode = 'normal';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('button', { name: traceId, exact: true }),
  ).toBeVisible();
  await page.goto(`${base}/traces?traceId=${traceId}`);
  await expect(
    page.getByRole('heading', { name: 'Request timeline' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await audit('Trace linked waterfall desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/settings`);
  await expect(
    page.getByText(/Clients must prove possession of their private key/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save CA Certificate', exact: true }),
  ).toBeDisabled();
  assert.equal(caSaves, 0, 'Blank save must not remove trust');
  const caInput = page.getByLabel('CA certificate PEM', { exact: true });
  const publicFixture =
    '-----BEGIN CERTIFICATE-----\nfixture-public-ca\n-----END CERTIFICATE-----';
  await caInput.fill(publicFixture);
  failCaSave = true;
  await page
    .getByRole('button', { name: 'Save CA Certificate', exact: true })
    .click();
  await expect(
    page.getByRole('alert', { name: 'CA certificate error', exact: true }),
  ).toContainText('Leaf certificates and private keys are not accepted');
  await expect(
    page.getByRole('alert', { name: 'CA certificate error', exact: true }),
  ).not.toContainText('{');
  await expect(caInput).toHaveValue(publicFixture);
  await audit('CA validation recovery mobile');
  failCaSave = false;
  await page
    .getByRole('button', { name: 'Save CA Certificate', exact: true })
    .click();
  await expect(
    page.getByText('CA certificate is configured', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove CA certificate', exact: true })
    .click();
  await expect(
    page.getByText('CA certificate is configured', { exact: true }),
  ).not.toBeVisible();
  await expect(caInput).toHaveValue('');
  await audit('CA removal recovery mobile');
  const archivePanel = page.getByRole('region', {
    name: 'Log archives',
    exact: true,
  });
  await expect(archivePanel.getByText('queued', { exact: true })).toBeVisible();
  await expect(
    archivePanel.getByText('processing', { exact: true }),
  ).toBeVisible();
  await expect(archivePanel.getByText('failed', { exact: true })).toBeVisible();
  await expect(
    archivePanel.getByText('expired', { exact: true }),
  ).toBeVisible();
  await archivePanel
    .getByLabel('Minimum status code', { exact: true })
    .selectOption('500');
  await archivePanel
    .getByLabel('Path prefix (optional)', { exact: true })
    .fill('/v1/');
  failArchiveCreate = true;
  await archivePanel
    .getByRole('button', { name: 'Create archive', exact: true })
    .click();
  await expect(archivePanel.getByRole('alert')).toContainText(
    'Archive could not be queued',
  );
  await expect(
    archivePanel.getByLabel('Path prefix (optional)', { exact: true }),
  ).toHaveValue('/v1/');
  failArchiveCreate = false;
  await archivePanel
    .getByRole('button', { name: 'Create archive', exact: true })
    .click();
  await expect(archivePanel.getByRole('status')).toContainText(
    'Archive queued',
  );
  archives[0].status = 'completed';
  archives[0].rowCount = 1;
  await page
    .getByRole('button', { name: 'Refresh archives', exact: true })
    .click();
  const downloadButton = page.getByRole('button', {
    name: `Download archive ${newArchiveId}`,
    exact: true,
  });
  await expect(downloadButton).toBeVisible();
  failArchiveDownload = true;
  await downloadButton.click();
  await expect(archivePanel.getByRole('alert')).toContainText(
    'Download is temporarily unavailable',
  );
  failArchiveDownload = false;
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const downloaded = await downloadPromise;
  assert.equal(
    downloaded.suggestedFilename(),
    `novagate-logs-${newArchiveId}.ndjson`,
  );
  await downloaded.saveAs(resolve(artifacts, 'downloaded-archive.ndjson'));
  assert.equal(
    JSON.parse(
      readFileSync(resolve(artifacts, 'downloaded-archive.ndjson'), 'utf8'),
    ).requestId,
    'fixture-archive',
  );
  await audit('log archives enabled and completed');
  await page.screenshot({
    path: resolve(artifacts, 'mobile-archives.png'),
    fullPage: true,
  });
  const schedulePanel = page.getByRole('region', {
    name: 'Automatic log archives',
    exact: true,
  });
  await expect(
    schedulePanel.getByText('Not configured', { exact: true }),
  ).toBeVisible();
  await schedulePanel
    .getByRole('button', { name: 'Set up automatic archives', exact: true })
    .click();
  let scheduleDialog = page.getByRole('dialog', {
    name: 'Set up automatic archives',
    exact: true,
  });
  await scheduleDialog
    .getByLabel('Archive frequency', { exact: true })
    .selectOption('near_real_time');
  await scheduleDialog
    .getByLabel('Minimum response status (optional)', { exact: true })
    .fill('500');
  await scheduleDialog
    .getByLabel('Scheduled path prefix (optional)', { exact: true })
    .fill('/v1/');
  await scheduleDialog
    .getByLabel('Scheduled consumer', { exact: true })
    .selectOption('56789012-1234-1234-1234-123456789abc');
  failSchedule = 'outage';
  await scheduleDialog
    .getByRole('button', { name: 'Save archive schedule', exact: true })
    .click();
  await expect(scheduleDialog.getByRole('alert')).toContainText(
    'temporarily unavailable',
  );
  await expect(
    scheduleDialog.getByLabel('Scheduled path prefix (optional)', {
      exact: true,
    }),
  ).toHaveValue('/v1/');
  failSchedule = 'revision';
  await scheduleDialog
    .getByRole('button', { name: 'Save archive schedule', exact: true })
    .click();
  await expect(scheduleDialog.getByRole('alert')).toContainText(
    'schedule changed',
  );
  await expect(
    scheduleDialog.getByLabel('Archive frequency', { exact: true }),
  ).toHaveValue('near_real_time');
  await audit('archive schedule save and revision recovery mobile');
  failSchedule = '';
  await scheduleDialog
    .getByRole('button', { name: 'Save archive schedule', exact: true })
    .click();
  await expect(scheduleDialog).not.toBeVisible();
  await expect(
    schedulePanel.getByText('Active', { exact: true }),
  ).toBeVisible();
  assert.equal(
    scheduleConfiguration.filter.consumerId,
    '56789012-1234-1234-1234-123456789abc',
  );
  const originalCursor = scheduleConfiguration.cursor;
  await schedulePanel
    .getByRole('button', { name: 'Edit archive schedule', exact: true })
    .click();
  scheduleDialog = page.getByRole('dialog', {
    name: 'Edit archive schedule',
    exact: true,
  });
  await expect(
    scheduleDialog.getByLabel('Scheduled consumer', { exact: true }),
  ).toHaveValue(scheduleConfiguration.filter.consumerId);
  await scheduleDialog
    .getByLabel('Archive frequency', { exact: true })
    .selectOption('hourly');
  await scheduleDialog
    .getByLabel('Scheduled path prefix (optional)', { exact: true })
    .fill('/%_');
  await scheduleDialog
    .getByLabel('Run automatic archives', { exact: true })
    .uncheck();
  await scheduleDialog
    .getByRole('button', { name: 'Save archive schedule', exact: true })
    .click();
  await expect(
    schedulePanel.getByText('Paused', { exact: true }),
  ).toBeVisible();
  assert.equal(scheduleConfiguration.cursor, originalCursor);
  assert.equal(scheduleConfiguration.filter.pathPrefix, '/%_');
  await schedulePanel
    .getByRole('button', { name: 'Resume automatic archives', exact: true })
    .click();
  await expect(
    schedulePanel.getByText('Active', { exact: true }),
  ).toBeVisible();
  await schedulePanel
    .getByRole('button', { name: 'Pause automatic archives', exact: true })
    .click();
  await expect(
    schedulePanel.getByText('Paused', { exact: true }),
  ).toBeVisible();
  failSchedule = 'revision';
  await schedulePanel
    .getByRole('button', { name: 'Resume automatic archives', exact: true })
    .click();
  await expect(schedulePanel.getByRole('alert')).toContainText(
    'schedule changed',
  );
  await expect(
    schedulePanel.getByText('Paused', { exact: true }),
  ).toBeVisible();
  failSchedule = '';
  await schedulePanel
    .getByRole('button', { name: 'Resume automatic archives', exact: true })
    .click();
  await expect(
    schedulePanel.getByText('Active', { exact: true }),
  ).toBeVisible();
  scheduleBacklog = true;
  await schedulePanel
    .getByRole('button', { name: 'Refresh schedule', exact: true })
    .click();
  await expect(
    schedulePanel.getByText('Catching up', { exact: true }),
  ).toBeVisible();
  await expect(
    schedulePanel.getByText('20 / 20', { exact: true }),
  ).toBeVisible();
  await expect(
    schedulePanel.getByText(
      'Waiting for pending archives; unprocessed windows are retained',
      { exact: true },
    ),
  ).toBeVisible();
  await audit('archive schedule backlog and failed jobs mobile');
  await page.screenshot({
    path: resolve(artifacts, 'mobile-archive-schedule.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await audit('archive schedule desktop');
  await page.screenshot({
    path: resolve(artifacts, 'desktop-archive-schedule.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const removeSchedule = schedulePanel.getByRole('button', {
    name: 'Remove archive schedule',
    exact: true,
  });
  await removeSchedule.click();
  let removalDialog = page.getByRole('dialog', {
    name: 'Remove archive schedule',
    exact: true,
  });
  await removalDialog
    .getByRole('button', { name: 'Keep schedule', exact: true })
    .focus();
  await page.keyboard.press('Shift+Tab');
  await expect(
    removalDialog.getByRole('button', { name: 'Confirm removal', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    removalDialog.getByRole('button', { name: 'Keep schedule', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(removalDialog).not.toBeVisible();
  await expect(removeSchedule).toBeFocused();
  await removeSchedule.click();
  removalDialog = page.getByRole('dialog', {
    name: 'Remove archive schedule',
    exact: true,
  });
  failSchedule = 'revision';
  await removalDialog
    .getByRole('button', { name: 'Confirm removal', exact: true })
    .click();
  await expect(removalDialog.getByRole('alert')).toContainText(
    'schedule changed',
  );
  failSchedule = '';
  const retainedJobs = archives.length;
  await removalDialog
    .getByRole('button', { name: 'Confirm removal', exact: true })
    .click();
  await expect(removalDialog).not.toBeVisible();
  await expect(
    schedulePanel.getByText('Not configured', { exact: true }),
  ).toBeVisible();
  assert.equal(archives.length, retainedJobs);
  scheduleBacklog = false;
  const failedArchive = archives.find((entry) => entry.status === 'failed');
  const retryButton = archivePanel.getByRole('button', {
    name: `Retry archive ${failedArchive.id}`,
    exact: true,
  });
  failArchiveRetry = true;
  await retryButton.click();
  await expect(archivePanel.getByRole('alert')).toContainText(
    'Retry temporarily unavailable',
  );
  await expect(retryButton).toBeVisible();
  failArchiveRetry = false;
  await retryButton.click();
  await expect(archivePanel.getByRole('status')).toContainText(
    'original window and filters',
  );
  await expect(retryButton).not.toBeVisible();
  assert.equal(failedArchive.retryCount, 1);
  await audit('archive removal and failed-job retry mobile');
  await schedulePanel
    .getByRole('button', { name: 'Set up automatic archives', exact: true })
    .click();
  scheduleDialog = page.getByRole('dialog', {
    name: 'Set up automatic archives',
    exact: true,
  });
  await scheduleDialog
    .getByLabel('Scheduled path prefix (optional)', { exact: true })
    .fill('/unsaved-first-workspace');
  const otherArchiveWorkspace = '87654321-1234-1234-1234-123456789abc';
  await page.evaluate((other) => {
    localStorage.setItem('gw_tenant_id', other);
    window.dispatchEvent(new Event('storage'));
  }, otherArchiveWorkspace);
  await expect(scheduleDialog).not.toBeVisible();
  await expect(
    schedulePanel.getByText('Not configured', { exact: true }),
  ).toBeVisible();
  await schedulePanel
    .getByRole('button', { name: 'Set up automatic archives', exact: true })
    .click();
  scheduleDialog = page.getByRole('dialog', {
    name: 'Set up automatic archives',
    exact: true,
  });
  await expect(
    scheduleDialog.getByLabel('Scheduled path prefix (optional)', {
      exact: true,
    }),
  ).toHaveValue('');
  await expect(
    scheduleDialog.getByLabel('Archive frequency', { exact: true }),
  ).toHaveValue('hourly');
  await page.keyboard.press('Escape');
  await page.evaluate((tenant) => {
    localStorage.setItem('gw_tenant_id', tenant);
    window.dispatchEvent(new Event('storage'));
  }, tenant);
  await expect(
    schedulePanel.getByText('Not configured', { exact: true }),
  ).toBeVisible();
  assert.ok(
    apiRequests.includes(
      `/api/tenants/${otherArchiveWorkspace}/log-exports/schedule`,
    ),
  );
  await audit('archive schedule workspace state reset');
  archivesEnabled = false;
  await page
    .getByRole('button', { name: 'Refresh archives', exact: true })
    .click();
  await expect(
    archivePanel.getByText(
      'Log archives are not enabled for this installation.',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    archivePanel.getByRole('button', { name: 'Create archive', exact: true }),
  ).not.toBeVisible();
  await schedulePanel
    .getByRole('button', { name: 'Refresh schedule', exact: true })
    .click();
  await expect(
    schedulePanel.getByText('Automatic archives are unavailable.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    schedulePanel.getByRole('button', {
      name: 'Set up automatic archives',
      exact: true,
    }),
  ).toBeDisabled();
  await audit('log archives disabled');
  await verifyAlertsDashboard({
    page,
    context,
    base,
    tenant,
    audit,
    artifacts,
    onFixtureError: (error) => runtimeErrors.push(error),
  });
  writeFileSync(
    resolve(artifacts, 'accessibility.json'),
    JSON.stringify(violations, null, 2),
  );
  assert.deepEqual(runtimeErrors, [], 'No uncaught browser errors');
  assert.deepEqual(
    violations,
    [],
    'Dashboard WCAG A/AA checks failed; see accessibility.json',
  );
  passed = true;
  console.log(
    'Dashboard browser checks passed: desktop/mobile layouts, API retry, navigation and form focus/Escape/restoration, reduced motion, and axe WCAG A/AA checks.',
  );
} catch (error) {
  await page
    .screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true })
    .catch(() => undefined);
  writeFileSync(
    resolve(artifacts, 'failure.json'),
    JSON.stringify({ runtimeErrors, apiRequests }, null, 2),
  );
  console.error(JSON.stringify({ runtimeErrors, apiRequests }));
  throw error;
} finally {
  try {
    if (traceStarted) {
      await context.tracing.stop({
        path: resolve(artifacts, 'browser-trace.zip'),
      });
      traceWritten = true;
    }
  } finally {
    await context.close();
    metricsServer.closeAllConnections();
    await new Promise((resolve) => metricsServer.close(resolve));
    rmSync(profile, { recursive: true, force: true });
    writeFileSync(
      resolve(artifacts, 'run.json'),
      JSON.stringify(
        {
          ok: passed && traceWritten,
          origin: new URL(base).origin,
          hydrationPasses,
          coldLoads,
          cpuThrottlingRate: 6,
          elapsedMs: Date.now() - startedAt,
          traceWritten,
          runtimeErrors,
          accessibilityViolations: violations,
        },
        null,
        2,
      ),
    );
  }
}
