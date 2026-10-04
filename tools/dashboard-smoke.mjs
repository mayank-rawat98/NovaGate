import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const base = process.env.DASHBOARD_VERIFY_URL ?? 'http://127.0.0.1:3333';
const artifacts = resolve('.local-work/dashboard-verification');
mkdirSync(artifacts, { recursive: true });
const systemChrome =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.DASHBOARD_BROWSER_EXECUTABLE ??
  (existsSync(systemChrome) ? systemChrome : undefined);
const context = await chromium.launchPersistentContext(
  resolve(artifacts, 'profile'),
  {
    executablePath,
    headless: true,
    viewport: { width: 1440, height: 960 },
  },
);
const tenant = '12345678-1234-1234-1234-123456789abc';
const service = '23456789-1234-1234-1234-123456789abc';
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
    createdAt,
  },
];
let failServices = false;
let serviceRequests = 0;
const violations = [];
const runtimeErrors = [];
const apiRequests = [];
const page = await context.newPage();
page.on('pageerror', (error) => runtimeErrors.push(error.message));
page.on('console', (message) => {
  if (
    message.type() === 'error' &&
    message.text() !==
      'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
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
await context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  apiRequests.push(url.pathname);
  assert.equal(
    url.origin,
    new URL(base).origin,
    'Dashboard must use its configured API origin',
  );
  const resource = url.pathname.split('/').at(-1);
  let body = [];
  let status = 200;
  if (route.request().method() === 'POST' && resource === 'services') {
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
  if (resource === tenant)
    body = {
      id: tenant,
      name: 'Bluebird Studio',
      email: 'demo@example.test',
      planId: 'free',
      gatewayConfigVersion: 12,
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
    body = [{ serviceId: service, status: 'healthy', checkedAt: createdAt }];
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
        id: 'c1',
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
  await expect(async () => {
    const response = await page.request.get(base);
    expect(response.ok()).toBeTruthy();
  }).toPass({ timeout: 60000 });
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
      .getByText('1', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(artifacts, 'desktop.png'),
    fullPage: true,
  });
  await audit('overview desktop');
  failServices = true;
  await page.goto(`${base}/services`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Services could not be loaded' }),
  ).toContainText('Services could not be loaded');
  failServices = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('Catalog API', { exact: true })).toBeVisible();
  assert(serviceRequests >= 2, 'Retry must fetch the list again');
  await audit('services desktop');
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
        .getByRole('button', { name: 'Add Service', exact: true })
        .click();
      await expect(serviceDialog.getByRole('alert')).toHaveText(
        'Service could not be saved. Please try again.',
      );
      await expect(
        serviceDialog.getByLabel('Name', { exact: true }),
      ).toHaveValue('Test service');
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
  for (const path of [
    '/routes',
    '/consumers',
    '/errors',
    '/logs',
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
  console.log(
    'Dashboard browser checks passed: desktop/mobile layouts, API retry, navigation and form focus/Escape/restoration, reduced motion, and axe WCAG A/AA checks.',
  );
} catch (error) {
  await page
    .screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true })
    .catch(() => {});
  writeFileSync(
    resolve(artifacts, 'failure.json'),
    JSON.stringify({ runtimeErrors, apiRequests }, null, 2),
  );
  console.error(JSON.stringify({ runtimeErrors, apiRequests }));
  throw error;
} finally {
  await context.close();
}
