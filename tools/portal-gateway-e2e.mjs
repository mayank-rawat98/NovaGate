import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { chromium, expect } from '@playwright/test';
import { preparePortalStandalone } from './developer-portal-preview.mjs';

/**
 * Phase 5.3 exit criterion on real processes: a developer registers in the
 * production portal, confirms email, creates a key, calls the real gateway
 * through the real control plane, sees the recorded usage and revokes the key.
 *
 * Requires local PostgreSQL (E2E_DATABASE_URL, a role allowed to create
 * databases) and Redis (E2E_REDIS_URL), and built admin-api, control-plane,
 * api and developer-portal (the portal built with ADMIN_API_URL pointing at
 * http://127.0.0.1:3001). No containers, no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/7';
const artifacts = resolve('.local-work/portal-gateway-e2e');
mkdirSync(artifacts, { recursive: true });
const ports = {
  admin: 3001,
  planeHttp: 3102,
  planeWs: 8182,
  gateway: 3103,
  portal: 3104,
};
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'portal-e2e-platform-secret-at-least-32-characters';
const gatewayApiKey = randomUUID();
const database = `novagate_portal_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const children = [];
const emails = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
let root;
let db;
let mail;
let upstream;
let browser;

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
const gateway = (path, key) =>
  fetch(`http://127.0.0.1:${ports.gateway}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

try {
  // Disposable database with the canonical schema and real admin migrations.
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

  // Mail API fixture captures verification links; upstream echoes requests.
  mail = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    emails.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"id":"fixture"}');
  });
  mail.listen(0, '127.0.0.1');
  await once(mail, 'listening');
  upstream = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        upstream: 'users-api',
        path: request.url,
        // The gateway forwards the request; never echo credentials.
        sawAuthorization: Boolean(request.headers.authorization),
      }),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  start('admin-api', 'apps/admin-api/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PLATFORM_JWT_SECRET: secret,
    PORTAL_URL: `http://127.0.0.1:${ports.portal}`,
    SMTP_API_KEY: 'fixture-mail-key',
    SMTP_API_BASE_URL: `http://127.0.0.1:${mail.address().port}`,
    // Plain-HTTP mail endpoints must be explicitly trusted.
    ALERT_HTTP_TRUSTED_ORIGINS: JSON.stringify([
      `http://127.0.0.1:${mail.address().port}`,
    ]),
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
  start('developer-portal', preparePortalStandalone(), {
    PORT: String(ports.portal),
    HOSTNAME: '127.0.0.1',
    ADMIN_API_URL: `http://127.0.0.1:${ports.admin}`,
    PORTAL_SHARED_HOSTS: '127.0.0.1,localhost',
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.portal}/`)).ok,
    'developer-portal startup',
  );
  step('started admin-api, control-plane, gateway and developer-portal');

  // Workspace configuration through the authenticated admin API.
  const service = await api(`/tenants/${tenant}/services`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'users-api',
      targets: [
        { url: `http://127.0.0.1:${upstream.address().port}`, weight: 100 },
      ],
    }),
  });
  const route = await api(`/tenants/${tenant}/routes`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'GET',
      pathPattern: '/users',
      serviceId: service.id,
      authRequired: true,
      plugins: [{ name: 'rate-limit', config: { max: 1000, windowMs: 60000 } }],
      portal: { visible: true, summary: 'List users' },
    }),
  });
  const settings = await api(`/tenants/${tenant}/portal-settings`);
  await api(`/tenants/${tenant}/portal-settings`, {
    method: 'PUT',
    body: JSON.stringify({
      enabled: true,
      title: 'Acme API',
      customDomain: null,
      apiBaseUrl: 'https://api.acme.test',
      signup: 'open',
      defaultGroups: [],
      maxKeysPerDeveloper: 3,
      expectedRevision: settings.revision,
    }),
  });
  // The published route reaches the gateway: anonymous calls are refused.
  await until(
    async () => (await gateway('/users')).status === 401,
    'route delivery to the gateway',
  );
  step('published route delivered to the gateway', { routeId: route.id });

  // Developer journey in a real browser against the production portal.
  const executablePath = process.env.DASHBOARD_BROWSER_EXECUTABLE;
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const portal = `http://127.0.0.1:${ports.portal}/w/${tenant}`;
  await page.goto(portal);
  await expect(page.getByRole('heading', { name: 'Acme API' })).toBeVisible();
  await expect(page.getByText('List users')).toBeVisible();
  await page.goto(`${portal}/register`);
  await page.getByLabel('Name').fill('Dana Developer');
  await page.getByLabel('Email').fill('dana@example.test');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('confirmation link');
  const email = await until(() => emails.at(-1), 'verification email');
  assert.deepEqual(email.to, ['dana@example.test']);
  const link = /href="([^"]+\/verify\?token=[a-f\d]{64})"/.exec(
    email.html,
  )?.[1];
  assert.ok(
    link?.startsWith(`${portal}/verify?token=`),
    'Verification link targets the portal',
  );
  step('registered and received the confirmation email');
  await page.goto(link);
  await expect(page).toHaveURL(`${portal}/keys`);
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByLabel('Key name').fill('Mobile app');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create key' })
    .click();
  const value = page.getByLabel('API key value');
  await expect(value).toHaveText(new RegExp(`^gw_${tenant}_[a-f\\d]{64}$`));
  const apiKey = (await value.textContent()).trim();
  await page.getByRole('button', { name: 'I saved the key' }).click();
  step('confirmed email and created a key in the portal');

  // The key authenticates real gateway traffic once its config is delivered.
  const first = await until(async () => {
    const response = await gateway('/users', apiKey);
    return response.status === 200 ? response : undefined;
  }, 'developer key delivery to the gateway');
  const body = await first.json();
  assert.equal(body.upstream, 'users-api');
  for (let index = 0; index < 4; index++)
    assert.equal((await gateway('/users', apiKey)).status, 200);
  assert.equal((await gateway('/users', 'gw_not_a_real_key')).status, 401);
  step('called the gateway with the developer key (5 accepted requests)');

  // Usage recorded by the gateway → control plane → PostgreSQL appears in the portal.
  await page.goto(`${portal}/usage`);
  await until(
    async () => {
      await page.reload();
      const text = await page
        .getByRole('main')
        .locator('dl')
        .innerText({ timeout: 5000 })
        .catch(() => '');
      return /Requests\s+5\b/.test(text);
    },
    'recorded usage in the portal',
    60000,
  );
  step('saw five recorded requests on the portal usage page');

  // Revocation in the portal stops gateway access.
  await page.goto(`${portal}/keys`);
  await page.getByRole('button', { name: 'Revoke Mobile app' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Revoke key' })
    .click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await until(
    async () => (await gateway('/users', apiKey)).status === 401,
    'revocation delivery to the gateway',
  );
  step('revoked the key in the portal; the gateway now refuses it');
  assert.deepEqual(errors, [], 'No uncaught portal errors');
  evidence.passed = true;
  console.log('Portal → gateway end-to-end verification passed.');
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(
    resolve(artifacts, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  await browser?.close();
  for (const { child } of children.reverse()) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((done) => setTimeout(done, 10000)),
    ]);
  }
  mail?.close();
  upstream?.close();
  await db?.end().catch(() => undefined);
  if (root) {
    await root
      .query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      .catch(() => undefined);
    await root.end();
  }
  // Leave no gateway cache behind in the dedicated Redis database.
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
