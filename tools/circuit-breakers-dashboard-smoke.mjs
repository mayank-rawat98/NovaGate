import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect } from '@playwright/test';

const BREAKER = {
  enabled: true,
  windowSize: 20,
  failureRatePercent: 50,
  minimumRequests: 5,
  openMs: 10000,
  halfOpenSuccesses: 2,
};
const GUARDED = '44444444-4444-4444-8444-444444444444';
const LEGACY = '55555555-5555-4555-8555-555555555555';

/**
 * Circuit status fixture: an empty snapshot by default, and a real SSE server
 * (reached through route.continue) whose frames the verifier scripts.
 */
export async function circuitBreakersBrowserFixture() {
  const state = { frames: [], streams: 0 };
  const clients = new Set();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer browser-verification-token') {
      response.writeHead(401).end();
      return;
    }
    state.streams++;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    clients.add(response);
    response.once('close', () => clients.delete(response));
    response.write(': connected\n\n');
    for (const frame of state.frames) send(response, frame);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  function send(response, snapshot) {
    response.write(`event: circuits\ndata: ${JSON.stringify(snapshot)}\n\n`);
  }
  async function handle(route) {
    const url = new URL(route.request().url());
    if (!url.pathname.includes('/circuit-breakers')) return false;
    assert.equal(
      route.request().headers().authorization,
      'Bearer browser-verification-token',
    );
    if (url.pathname.endsWith('/circuit-breakers/stream')) {
      await route.continue({ url: `${origin}${url.pathname}` });
      return true;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        state.frames.at(-1) ?? { reportedAt: null, services: [] },
      ),
    });
    return true;
  }
  return {
    handle,
    state,
    /** Pushes a snapshot to every open stream and to later connections. */
    publish(snapshot) {
      state.frames = [snapshot];
      for (const client of clients) send(client, snapshot);
    },
    async close() {
      for (const client of clients) client.destroy();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

export async function verifyCircuitBreakersDashboard({
  page,
  context,
  base,
  audit,
  fixture,
}) {
  const createdAt = '2026-10-04T12:00:00.000Z';
  const services = [
    {
      id: GUARDED,
      name: 'Orders API',
      targets: [{ url: 'https://orders.example.test', weight: 100 }],
      healthCheckPath: '/health',
      timeoutMs: 10000,
      circuitBreaker: BREAKER,
      createdAt,
    },
    {
      id: LEGACY,
      name: 'Legacy API',
      targets: [{ url: 'https://legacy.example.test', weight: 100 }],
      healthCheckPath: '/health',
      timeoutMs: 10000,
      circuitBreaker: null,
      createdAt,
    },
  ];
  const saved = [];
  const handler = async (route) => {
    const method = route.request().method();
    if (method === 'GET')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(services),
      });
    const body = route.request().postDataJSON();
    saved.push({ method, body });
    return route.fulfill({
      status: method === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: GUARDED, ...body, createdAt }),
    });
  };
  const patterns = ['**/api/tenants/*/services', '**/api/tenants/*/services/*'];
  for (const pattern of patterns) await context.route(pattern, handler);
  const at = (offset) => new Date(Date.now() + offset).toISOString();
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    fixture.publish({
      reportedAt: at(0),
      services: [
        {
          serviceId: GUARDED,
          state: 'open',
          requests: 5,
          failures: 3,
          changedAt: at(0),
          nextProbeAt: at(10000),
        },
      ],
    });
    await page.goto(`${base}/services`);
    const table = page.getByRole('region', { name: 'Services table' });
    const orders = table.getByRole('row', { name: /Orders API/ });
    await expect(orders.getByText('Open', { exact: true })).toBeVisible();
    await expect(orders.getByText('3/5 failed')).toBeVisible();
    await expect(
      table
        .getByRole('row', { name: /Legacy API/ })
        .getByText('Off', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Circuit status is live/)).toBeVisible();
    await audit('services circuit open');
    // A live transition replaces the badge without a reload.
    fixture.publish({
      reportedAt: at(0),
      services: [
        {
          serviceId: GUARDED,
          state: 'closed',
          requests: 0,
          failures: 0,
          changedAt: at(0),
          nextProbeAt: null,
        },
      ],
    });
    await expect(orders.getByText('Closed', { exact: true })).toBeVisible();
    // A gateway that stopped reporting is not shown as healthy.
    fixture.publish({ reportedAt: at(0), services: [] });
    await expect(orders.getByText('No report', { exact: true })).toBeVisible();

    await orders.getByRole('button', { name: 'Edit service' }).click();
    const dialog = page.getByRole('dialog', { name: 'Services form' });
    const enabled = dialog.getByRole('checkbox', {
      name: /Stop sending traffic while this service is failing/,
    });
    await expect(enabled).toBeChecked();
    await expect(dialog.getByLabel('Window (requests)')).toHaveValue('20');
    await dialog.getByLabel('Window (requests)').fill('40');
    await dialog.getByLabel('Minimum requests').fill('50');
    await audit('service circuit settings');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog.getByText(/values are out of range/)).toBeVisible();
    assert.equal(saved.length, 0, 'Invalid settings are not sent');
    await dialog.getByLabel('Minimum requests').fill('8');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden();
    assert.deepEqual(saved.at(-1).body.circuitBreaker, {
      ...BREAKER,
      windowSize: 40,
      minimumRequests: 8,
    });

    // Legacy services start with the breaker off; turning it on saves defaults.
    await table
      .getByRole('row', { name: /Legacy API/ })
      .getByRole('button', { name: 'Edit service' })
      .click();
    await expect(enabled).not.toBeChecked();
    await expect(dialog.getByLabel('Window (requests)')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden();
    assert.deepEqual(saved.at(-1).body.circuitBreaker, {
      ...BREAKER,
      enabled: false,
    });

    // New services default to the breaker.
    await page
      .getByRole('button', { name: 'Add Service', exact: true })
      .click();
    await expect(enabled).toBeChecked();
    await dialog.getByPlaceholder('user-service').fill('Billing API');
    await dialog
      .getByLabel('Target 1 URL')
      .fill('https://billing.example.test');
    await dialog
      .getByRole('button', { name: 'Add Service', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    assert.equal(saved.at(-1).method, 'POST');
    assert.deepEqual(saved.at(-1).body.circuitBreaker, BREAKER);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
    await audit('services circuit mobile');
    await page.setViewportSize({ width: 1440, height: 960 });
  } finally {
    for (const pattern of patterns) await context.unroute(pattern, handler);
    fixture.publish({ reportedAt: null, services: [] });
  }
  return {
    liveTransitions: true,
    unreportedNotHealthy: true,
    settingsValidation: true,
    legacyOptIn: true,
    newServiceDefault: true,
    desktopMobileAccessibility: true,
  };
}
