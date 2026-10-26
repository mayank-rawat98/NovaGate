import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

const CHANNEL = '66666666-6666-4666-8666-666666666666';

/** Stateful anomaly fixture; detection itself is verified on PostgreSQL. */
export function anomaliesBrowserFixture() {
  const startedAt = new Date(Date.now() - 4 * 60000).toISOString();
  const state = {
    failSave: false,
    saves: [],
    settings: {
      enabled: true,
      zThreshold: 3,
      minRequests: 20,
      channelIds: [],
      revision: 1,
    },
    anomalies: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        method: 'GET',
        path: '/api/orders',
        metric: 'p95_latency_ms',
        direction: 'up',
        baseline: { mean: 42, stddev: 3, windows: 96 },
        current: 380,
        zScore: 112.7,
        requests: 140,
        state: 'active',
        startedAt,
        lastSeenAt: new Date().toISOString(),
        resolvedAt: null,
        summary:
          'Unusual 805% rise in p95 latency on GET /api/orders: baseline 42 ms, current 380 ms',
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        method: 'POST',
        path: '/api/payments',
        metric: 'error_rate',
        direction: 'up',
        baseline: { mean: 0.002, stddev: 0.001, windows: 96 },
        current: 0.018,
        zScore: 16,
        requests: 400,
        state: 'resolved',
        startedAt: '2026-10-24T10:00:00.000Z',
        lastSeenAt: '2026-10-24T10:20:00.000Z',
        resolvedAt: '2026-10-24T10:23:00.000Z',
        summary:
          'Unusual 800% rise in 5xx rate on POST /api/payments: baseline 0.20%, current 1.80%',
      },
    ],
  };
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const settingsPath = url.pathname.endsWith('/anomaly-settings');
    if (!settingsPath && !url.pathname.endsWith('/anomalies')) return false;
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    const reply = (status, body) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (!settingsPath) {
      assert.equal(url.searchParams.get('state'), 'all');
      return (await reply(200, state.anomalies), true);
    }
    if (request.method() === 'GET')
      return (await reply(200, state.settings), true);
    const dto = request.postDataJSON();
    state.saves.push(dto);
    if (state.failSave) {
      state.failSave = false;
      // Someone else saved meanwhile.
      state.settings = {
        ...state.settings,
        revision: state.settings.revision + 1,
      };
      return (
        await reply(409, {
          message: 'Anomaly settings changed. Reload them before saving.',
        }),
        true
      );
    }
    assert.equal(dto.expectedRevision, state.settings.revision);
    const { expectedRevision: _ignored, ...rest } = dto;
    state.settings = { ...rest, revision: state.settings.revision + 1 };
    return (await reply(200, state.settings), true);
  }
  return { handle, state };
}

export async function verifyAnomaliesDashboard({
  page,
  context,
  base,
  audit,
  fixture,
}) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/dashboard`);
  const feed = page.getByRole('region', { name: 'Anomaly feed' });
  const active = feed.getByRole('listitem').filter({ hasText: '/api/orders' });
  await expect(
    active.getByText(fixture.state.anomalies[0].summary),
  ).toBeVisible();
  await expect(active.getByText('Active', { exact: true })).toBeVisible();
  await expect(
    feed
      .getByRole('listitem')
      .filter({ hasText: '/api/payments' })
      .getByText('Resolved', { exact: true }),
  ).toBeVisible();
  await audit('overview anomaly feed');

  // One click to the related logs, prefilled and searched.
  let logQuery;
  const logs = async (route) => {
    logQuery = new URL(route.request().url()).searchParams;
    await route.fulfill({ contentType: 'application/json', body: '[]' });
  };
  await context.route('**/api/tenants/*/logs?*', logs);
  try {
    await active
      .getByRole('link', { name: 'View logs for GET /api/orders' })
      .click();
    await expect(page.getByLabel('Path')).toHaveValue('/api/orders');
    await expect.poll(() => logQuery?.get('path')).toBe('/api/orders');
    assert.ok(logQuery.get('from') && logQuery.get('to'));
  } finally {
    await context.unroute('**/api/tenants/*/logs?*', logs);
  }
  await page.goto(`${base}/dashboard`);
  await page
    .getByRole('region', { name: 'Anomaly feed' })
    .getByRole('link', { name: 'View traces for GET /api/orders' })
    .click();
  await expect(page.getByLabel('Route', { exact: true })).toHaveValue(
    '/api/orders',
  );

  // Settings on the Alerts page, with channels from the alert configuration.
  const configuration = async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rules: [],
        channels: [
          {
            id: CHANNEL,
            name: 'On-call webhook',
            type: 'webhook',
            enabled: true,
            destination: 'https://hooks.example.test',
            hasSecret: true,
            revision: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        deliveryEnabled: true,
        deliveryAvailability: { webhook: true, slack: true, email: false },
      }),
    });
  };
  const history = async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: '99999999-9999-4999-8999-999999999999',
          ruleId: null,
          ruleName: 'Anomaly: p95_latency_ms GET /api/orders',
          metric: 'p95_latency_ms',
          operator: '>',
          threshold: 42,
          windowMinutes: 5,
          state: 'firing',
          value: 380,
          createdAt: fixture.state.anomalies[0].startedAt,
          anomaly: {
            id: fixture.state.anomalies[0].id,
            method: 'GET',
            path: '/api/orders',
            direction: 'up',
            baseline: 42,
            zScore: 112.7,
            summary: fixture.state.anomalies[0].summary,
          },
          deliveries: [],
        },
      ]),
    });
  await context.route('**/api/tenants/*/alerts', configuration);
  await context.route('**/api/tenants/*/alerts/history', history);
  try {
    await page.goto(`${base}/alerts`);
    const panel = page.getByRole('region', { name: 'Anomaly detection' });
    await expect(panel.getByText('Dashboard only')).toBeVisible();
    // Anomaly events in alert history carry their description.
    await expect(
      page
        .getByRole('region', { name: 'Recent activity' })
        .getByText(fixture.state.anomalies[0].summary),
    ).toBeVisible();
    const opener = panel.getByRole('button', {
      name: 'Edit anomaly detection',
    });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Edit anomaly detection' });
    await dialog.getByLabel('Sensitivity (z-score)').fill('1');
    await dialog
      .getByRole('button', { name: 'Save anomaly detection' })
      .click();
    // The browser refuses out-of-range input before anything is sent.
    assert.equal(
      await dialog
        .getByLabel('Sensitivity (z-score)')
        .evaluate((input) => input.validity.rangeUnderflow),
      true,
    );
    assert.equal(fixture.state.saves.length, 0);
    await dialog.getByLabel('Sensitivity (z-score)').fill('4');
    await dialog.getByRole('checkbox', { name: /On-call webhook/ }).check();
    await audit('anomaly settings form');
    fixture.state.failSave = true;
    await dialog
      .getByRole('button', { name: 'Save anomaly detection' })
      .click();
    await expect(dialog.getByRole('alert')).toContainText('changed');
    await dialog.getByRole('button', { name: 'Reload revision' }).click();
    await expect(dialog.getByRole('alert')).toContainText('edits are kept');
    await expect(dialog.getByLabel('Sensitivity (z-score)')).toHaveValue('4');
    await dialog
      .getByRole('button', { name: 'Save anomaly detection' })
      .click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    assert.deepEqual(fixture.state.saves.at(-1), {
      enabled: true,
      zThreshold: 4,
      minRequests: 20,
      channelIds: [CHANNEL],
      expectedRevision: 2,
    });
    await expect(panel.getByText('On-call webhook')).toBeVisible();
    await expect(
      panel.getByText('z-score 4 · at least 20 requests'),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/dashboard`);
    await page
      .getByRole('region', { name: 'Anomaly feed' })
      .scrollIntoViewIfNeeded();
    await audit('overview anomaly feed mobile');
    await page.setViewportSize({ width: 1440, height: 960 });
  } finally {
    await context.unroute('**/api/tenants/*/alerts', configuration);
    await context.unroute('**/api/tenants/*/alerts/history', history);
  }
  return {
    feedStates: true,
    logsLinkPrefillsAndSearches: true,
    tracesLinkPrefills: true,
    settingsValidationAndRevision: true,
    channelSelection: true,
    desktopMobileAccessibility: true,
  };
}
