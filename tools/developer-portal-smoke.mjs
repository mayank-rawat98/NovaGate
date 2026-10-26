import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, get } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { startPortal } from './developer-portal-preview.mjs';

/**
 * Production developer portal against a stateful admin-API fixture. The
 * standalone server proxies /api/portal/* to the fixture and resolves custom
 * domains through it, so rewrites and the domain proxy run for real.
 * Server behaviour itself is verified on PostgreSQL in admin-api.
 */
const require = createRequire(import.meta.url);
const artifacts = resolve('.local-work/developer-portal-verification');
mkdirSync(artifacts, { recursive: true });
const tenant = '12345678-1234-1234-1234-123456789abc';
const routeId = '23456789-1234-1234-1234-123456789abc';
const verifyToken = 'a'.repeat(64);
const password = 'correct horse battery';
const sessionToken = `portal-session-${randomUUID()}`;
const keys = [];
const requests = [];
const runtimeErrors = [];
const violations = [];
let failCreate = false;

const catalog = {
  tenantId: tenant,
  title: 'Acme API',
  apiBaseUrl: 'https://api.acme.test',
  signup: 'open',
  routes: [
    {
      id: routeId,
      method: 'GET',
      path: '/users/:id',
      summary: 'Fetch a user',
      description: 'Returns one user.\nUnknown IDs return 404.',
      auth: ['api-key'],
      rateLimit: { requests: 30, windowMs: 1000 },
      groupRestricted: true,
    },
    {
      id: randomUUID(),
      method: 'POST',
      path: '/webhooks',
      summary: null,
      description: null,
      auth: ['hmac'],
      rateLimit: null,
      groupRestricted: false,
    },
  ],
};
const developer = {
  id: randomUUID(),
  email: 'dana@example.test',
  name: 'Dana',
};
const session = () => ({
  token: sessionToken,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  developer,
});

const admin = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url ?? '/', 'http://fixture');
  requests.push(`${request.method} ${url.pathname}`);
  const reply = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/portal/resolve')
    return url.searchParams.get('host') === 'portal.acme.test'
      ? reply(200, { tenantId: tenant })
      : reply(404, { message: 'Portal not found' });
  const prefix = `/api/portal/${tenant}`;
  if (!url.pathname.startsWith(prefix))
    return reply(404, { message: 'Portal not found' });
  const path = url.pathname.slice(prefix.length);
  if (path === '/catalog') return reply(200, catalog);
  if (path.startsWith('/catalog/')) {
    const entry = catalog.routes.find((r) => r.id === path.slice(9));
    return entry
      ? reply(200, entry)
      : reply(404, { message: 'Route not found' });
  }
  const input = body ? JSON.parse(body) : {};
  if (path === '/developers/register') {
    assert.deepEqual(Object.keys(input).sort(), ['email', 'name', 'password']);
    return reply(202, {
      message:
        'If this email can register, a confirmation link has been sent. Check your inbox to finish signing up.',
    });
  }
  if (path === '/developers/verify')
    return input.token === verifyToken
      ? reply(200, session())
      : reply(400, { message: 'This verification link is invalid or expired' });
  if (path === '/developers/login')
    return input.password === password
      ? reply(200, session())
      : reply(401, {
          message:
            'Invalid email or password, or too many recent attempts. Try again later.',
        });
  if (request.headers.authorization !== `Bearer ${sessionToken}`)
    return reply(401, {
      message: 'Your portal session is invalid or expired.',
    });
  if (path === '/me') return reply(200, developer);
  if (path === '/me/keys' && request.method === 'GET') return reply(200, keys);
  if (path === '/me/keys' && request.method === 'POST') {
    assert.deepEqual(Object.keys(input), ['name']);
    if (failCreate) {
      failCreate = false;
      return reply(409, {
        message: 'You can hold 5 active keys. Revoke an unused key first.',
      });
    }
    const key = {
      id: randomUUID(),
      name: input.name,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    keys.unshift(key);
    return reply(201, { ...key, apiKey: `gw_${tenant}_${'f'.repeat(64)}` });
  }
  const keyMatch = /^\/me\/keys\/([^/]+)(\/usage)?$/.exec(path);
  const key = keyMatch && keys.find((entry) => entry.id === keyMatch[1]);
  if (!key) return reply(404, { message: 'Key not found' });
  if (keyMatch[2]) {
    const now = Date.now();
    return reply(200, {
      consumer: { id: key.id, name: key.name, revokedAt: key.revokedAt },
      period: url.searchParams.get('period'),
      from: new Date(now - 86400000).toISOString(),
      to: new Date(now).toISOString(),
      generatedAt: new Date(now).toISOString(),
      source: 'persisted_request_logs',
      bucketSeconds: 3600,
      rowLimit: 100000,
      requests: 42,
      serverErrors: 2,
      errorRate: 2 / 42,
      rps: 0.0005,
      latencySamples: 42,
      p50Ms: 18,
      p95Ms: 64,
      p99Ms: 90,
      series: [
        {
          timestamp: new Date(now - 7200000).toISOString(),
          requests: 30,
          serverErrors: 1,
          errorRate: 1 / 30,
          rps: 0,
          latencySamples: 30,
          p50Ms: 18,
          p95Ms: 60,
          p99Ms: 80,
        },
        {
          timestamp: new Date(now - 3600000).toISOString(),
          requests: 12,
          serverErrors: 1,
          errorRate: 1 / 12,
          rps: 0,
          latencySamples: 12,
          p50Ms: 18,
          p95Ms: 64,
          p99Ms: 90,
        },
      ],
      topPaths: [
        {
          method: 'GET',
          path: '/users/42',
          requests: 42,
          serverErrors: 2,
          errorRate: 2 / 42,
          rps: 0,
          latencySamples: 42,
          p50Ms: 18,
          p95Ms: 64,
          p99Ms: 90,
        },
      ],
    });
  }
  if (request.method === 'DELETE') {
    key.revokedAt ??= new Date().toISOString();
    return reply(200, key);
  }
  reply(404, { message: 'Not found' });
});
admin.listen(0, '127.0.0.1');
await once(admin, 'listening');
const port = Number(process.env.PORTAL_PREVIEW_PORT ?? '3334');
const portal = startPortal(
  {
    ADMIN_API_URL: `http://127.0.0.1:${admin.address().port}`,
    PORTAL_SHARED_HOSTS: '127.0.0.1,localhost',
    PORTAL_PREVIEW_PORT: String(port),
  },
  'pipe',
);
const base = `http://127.0.0.1:${port}`;
const systemChrome =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.DASHBOARD_BROWSER_EXECUTABLE ??
  (existsSync(systemChrome) ? systemChrome : undefined);
const profile = mkdtempSync(resolve(artifacts, 'profile-'));
let context;
let passed = false;
try {
  await expect(async () => {
    const response = await fetch(`${base}/`);
    expect(response.ok).toBeTruthy();
  }).toPass({ timeout: 30000 });
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--host-resolver-rules=MAP portal.acme.test 127.0.0.1`],
  });
  // Rewrites are fixed at build time (as in the dashboard), so browser API
  // calls are forwarded to the fixture; domain resolution stays server-side.
  const fixture = `http://127.0.0.1:${admin.address().port}`;
  await context.route(/\/api\/portal\//, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({
        url: `${fixture}${url.pathname}${url.search}`,
      }),
    });
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !/status of (400|401|409)/.test(message.text())
    )
      runtimeErrors.push(message.text());
  });
  async function audit(label) {
    await page.addScriptTag({ path: require.resolve('axe-core') });
    const result = await page.evaluate(() =>
      window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      }),
    );
    for (const violation of result.violations)
      violations.push({
        page: label,
        id: violation.id,
        nodes: violation.nodes.length,
      });
  }
  const fits = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );

  // Catalog on the shared host, including security headers.
  const response = await page.goto(`${base}/w/${tenant}`);
  const csp = response?.headers()['content-security-policy'] ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response?.headers()['x-frame-options'], 'DENY');
  await expect(page.getByRole('heading', { name: 'Acme API' })).toBeVisible();
  const published = page.getByRole('list', { name: 'Published APIs' });
  await expect(published.locator(':scope > li')).toHaveCount(2);
  await expect(published.getByText('30 requests per second')).toBeVisible();
  await expect(published.getByText('HMAC signature')).toBeVisible();
  await audit('catalog desktop');
  await published.getByRole('link', { name: /\/users\/:id/ }).click();
  await expect(page).toHaveURL(`${base}/w/${tenant}/docs/${routeId}`);
  await expect(page.getByText('Unknown IDs return 404.')).toBeVisible();
  await expect(
    page.getByText(
      "curl -X GET 'https://api.acme.test/users/{id}' \\ -H 'Authorization: Bearer YOUR_API_KEY'",
    ),
  ).toBeVisible();
  await expect(page.getByText(/Access depends on your key/)).toBeVisible();
  await audit('route docs');

  // Signed-out developers are asked to sign in.
  await page.goto(`${base}/w/${tenant}/keys`);
  await expect(
    page.getByRole('heading', { name: 'Sign in to continue' }),
  ).toBeVisible();

  // Registration and email confirmation.
  await page.goto(`${base}/w/${tenant}/register`);
  await page.getByLabel('Name').fill('Dana');
  await page.getByLabel('Email').fill('dana@example.test');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  // Native minlength blocks submission before the request.
  assert.ok(
    !requests.includes(`POST /api/portal/${tenant}/developers/register`),
  );
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('confirmation link');
  await audit('registration');
  await page.goto(`${base}/w/${tenant}/verify?token=${'b'.repeat(64)}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'invalid or expired',
  );
  await page.goto(`${base}/w/${tenant}/verify?token=${verifyToken}`);
  await expect(page).toHaveURL(`${base}/w/${tenant}/keys`);
  assert.equal(
    requests.filter((entry) => entry.endsWith('/developers/verify')).length,
    2,
    'Each verification link is submitted once',
  );

  // Keys: failed creation, one-time key, revocation.
  await expect(page.getByText('You have no keys yet.')).toBeVisible();
  failCreate = true;
  await page.getByRole('button', { name: 'Create key' }).click();
  let dialog = page.getByRole('dialog', { name: 'Create API key' });
  await dialog.getByLabel('Key name').fill('Mobile app');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Revoke an unused key');
  await expect(dialog.getByLabel('Key name')).toHaveValue('Mobile app');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  const saved = page.getByRole('dialog', { name: 'Save your API key' });
  const apiKey = `gw_${tenant}_${'f'.repeat(64)}`;
  await expect(saved.getByLabel('API key value')).toHaveText(apiKey);
  await audit('one-time key');
  assert.ok(
    !(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      )
    ).includes(apiKey),
    'Gateway keys never persist in the browser',
  );
  await saved.getByRole('button', { name: 'I saved the key' }).click();
  await expect(page.getByRole('status')).toHaveText('Key Mobile app created.');
  assert.ok(!(await page.content()).includes(apiKey));
  await page.getByRole('button', { name: 'Revoke Mobile app' }).click();
  dialog = page.getByRole('dialog', { name: 'Revoke API key' });
  await dialog.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await audit('keys');

  // Usage.
  await page.getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByText('42', { exact: true })).toBeVisible();
  await expect(page.getByText('64 ms')).toBeVisible();
  await page.getByLabel('Period').selectOption('7d');
  await expect
    .poll(() => requests.some((r) => r.includes('/usage')))
    .toBe(true);
  await audit('usage');

  // Sign out, failed and successful sign-in.
  await page.getByRole('button', { name: /Sign out/ }).click();
  await page.goto(`${base}/w/${tenant}/login`);
  await page.getByLabel('Email').fill('dana@example.test');
  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Invalid email or password',
  );
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${base}/w/${tenant}/keys`);

  // Mobile layout.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['', '/keys', '/usage', `/docs/${routeId}`]) {
    await page.goto(`${base}/w/${tenant}${path}`);
    await page.waitForLoadState('networkidle');
    assert.ok(await fits(), `${path || '/'} fits the mobile viewport`);
  }
  await audit('usage mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Custom domain: root-relative links and no cross-workspace paths.
  const custom = `http://portal.acme.test:${port}`;
  await page.goto(`${custom}/`);
  await expect(page.getByRole('heading', { name: 'Acme API' })).toBeVisible();
  const docs = page
    .getByRole('list', { name: 'Published APIs' })
    .getByRole('link', { name: /\/users\/:id/ });
  assert.equal(await docs.getAttribute('href'), `/docs/${routeId}`);
  await docs.click();
  await expect(page).toHaveURL(`${custom}/docs/${routeId}`);
  await page.goto(`${custom}/w/${tenant}`);
  await expect(
    page.getByRole('heading', { name: 'Portal not available' }),
  ).toBeVisible();
  // An unknown custom domain gets the not-available page, not another portal.
  const unknown = await new Promise((done, fail) =>
    get(`${base}/`, { headers: { host: 'other.acme.test' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => done(text));
    }).on('error', fail),
  );
  assert.match(unknown, /Portal not available/);
  await audit('custom domain');

  assert.deepEqual(runtimeErrors, [], 'No uncaught browser errors');
  assert.deepEqual(violations, [], 'Portal WCAG A/AA checks failed');
  passed = true;
  console.log(
    'Developer portal browser checks passed: catalog/docs, registration and verification, keys, usage, sign-in, custom domains, security headers, mobile layout and axe WCAG A/AA.',
  );
} finally {
  writeFileSync(
    resolve(artifacts, 'evidence.json'),
    JSON.stringify({ passed, runtimeErrors, violations, requests }, null, 2),
  );
  await context?.close();
  portal.kill('SIGTERM');
  admin.close();
  rmSync(profile, { recursive: true, force: true });
}
