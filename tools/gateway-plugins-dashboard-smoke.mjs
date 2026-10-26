import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Stateful workspace-side plugin fixture; real behaviour is verified in PostgreSQL. */
export function gatewayPluginsBrowserFixture() {
  const state = { failSave: false, saves: [], disabled: new Map() };
  const reportedAt = '2026-10-25T10:00:00.000Z';
  const plugins = [
    {
      name: '@acme/stamp',
      package: '@acme/stamp',
      version: '1.0.0',
      state: 'active',
      protocols: ['http'],
      hooks: ['onRequest', 'onResponse'],
      failures: 0,
      lastError: null,
      quarantinedUntil: null,
    },
    {
      name: '@acme/legacy-sso',
      package: '@acme/legacy-sso',
      version: '2.4.1',
      state: 'quarantined',
      protocols: ['http', 'websocket'],
      hooks: ['onRequest'],
      failures: 5,
      lastError: 'Error: onRequest exceeded 2000 ms',
      quarantinedUntil: '2026-10-25T10:01:00.000Z',
    },
  ];
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/gateway-plugins')) return false;
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    const parts = url.pathname.split('/');
    const tenant = parts[parts.indexOf('tenants') + 1];
    const reply = (status, body) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    const current = () => ({
      reportedAt,
      plugins: plugins.map((plugin) =>
        (state.disabled.get(tenant) ?? []).includes(plugin.name)
          ? { ...plugin, state: 'disabled' }
          : plugin,
      ),
      // A disabled package the gateway no longer reports stays reversible.
      disabled: state.disabled.get(tenant) ?? ['@acme/retired'],
    });
    if (!state.disabled.has(tenant))
      state.disabled.set(tenant, ['@acme/retired']);
    if (request.method() === 'GET') return (await reply(200, current()), true);
    const dto = request.postDataJSON();
    assert.deepEqual(Object.keys(dto), ['disabled']);
    state.saves.push(dto.disabled);
    if (state.failSave) {
      state.failSave = false;
      return (
        await reply(503, { message: 'Workspace is busy. Try again.' }),
        true
      );
    }
    state.disabled.set(tenant, [...dto.disabled].sort());
    return (await reply(200, current()), true);
  }
  return { handle, state };
}

export async function verifyGatewayPluginsDashboard({
  page,
  context,
  base,
  audit,
  fixture,
}) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/settings`);
  const panel = page.getByRole('region', { name: 'Gateway plugins' });
  await expect(panel.getByText(/Last reported by the gateway/)).toBeVisible();
  const table = panel.getByRole('table', {
    name: 'Third-party gateway plugins',
  });
  await expect(table.getByText('Paused after failures')).toBeVisible();
  await expect(
    table.getByText('Error: onRequest exceeded 2000 ms'),
  ).toBeVisible();
  await expect(table.getByText('Not reported')).toBeVisible();
  await audit('gateway plugins panel');

  await table.getByRole('button', { name: 'Disable @acme/stamp' }).click();
  const confirm = page.getByRole('dialog', { name: 'Disable plugin' });
  await expect(confirm.getByText(/503 PLUGIN_DISABLED/)).toBeVisible();
  await audit('gateway plugin disable confirmation');
  fixture.state.failSave = true;
  await confirm.getByRole('button', { name: 'Disable plugin' }).click();
  await expect(confirm.getByRole('alert')).toContainText('Workspace is busy');
  await confirm.getByRole('button', { name: 'Disable plugin' }).click();
  await expect(confirm).toBeHidden();
  await expect(panel.getByRole('status')).toContainText(
    '@acme/stamp disabled.',
  );
  assert.deepEqual(fixture.state.saves.at(-1), [
    '@acme/retired',
    '@acme/stamp',
  ]);
  await expect(
    table.getByRole('button', { name: 'Enable @acme/stamp' }),
  ).toBeVisible();
  await table.getByRole('button', { name: 'Enable @acme/retired' }).click();
  await page
    .getByRole('dialog', { name: 'Enable plugin' })
    .getByRole('button', { name: 'Enable plugin' })
    .click();
  await expect(panel.getByRole('status')).toContainText(
    '@acme/retired enabled.',
  );
  assert.deepEqual(fixture.state.saves.at(-1), ['@acme/stamp']);
  await expect(table.getByText('Not reported')).toBeHidden();

  // Route editor: edit an existing third-party plugin in place, add another.
  const listed = {
    id: 'r1',
    method: 'GET',
    pathPattern: '/v1/products',
    serviceId: '23456789-1234-1234-1234-123456789abc',
    authRequired: true,
    enabled: true,
    plugins: [
      { name: '@acme/legacy-sso', config: { realm: 'staff' } },
      { name: 'cors', config: { origins: ['https://app.example.test'] } },
    ],
    createdAt: '2026-10-04T12:00:00.000Z',
  };
  let saved;
  const list = async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([listed]),
    });
  };
  const put = async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saved = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...listed, ...saved }),
    });
  };
  await context.route('**/api/tenants/*/routes', list);
  await context.route('**/api/tenants/*/routes/r1', put);
  try {
    await page.goto(`${base}/routes`);
    await page.getByRole('button', { name: 'Edit GET /v1/products' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByRole('button', { name: 'plugins' }).click();
    const section = editor.getByRole('region', {
      name: 'Third-party plugins',
    });
    await expect(section.getByLabel('Plugin name 1')).toHaveValue(
      '@acme/legacy-sso',
    );
    await section
      .getByLabel('Configuration (JSON object) 1')
      .fill('{"realm":"contractors"}');
    await section
      .getByRole('button', { name: 'Add third-party plugin' })
      .click();
    await section.getByLabel('Plugin name 2').fill('stamp');
    await section.getByLabel('Configuration (JSON object) 2').fill('{"v":');
    await audit('route third-party plugins');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(
      page.getByText(/must be a scoped npm package name/),
    ).toBeVisible();
    assert.equal(saved, undefined, 'Invalid names are not sent');
    await section.getByLabel('Plugin name 2').fill('@acme/stamp');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText(/is not valid JSON/)).toBeVisible();
    await section
      .getByLabel('Configuration (JSON object) 2')
      .fill('{"value":"v1"}');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor).toBeHidden();
  } finally {
    await context.unroute('**/api/tenants/*/routes', list);
    await context.unroute('**/api/tenants/*/routes/r1', put);
  }
  // Order is kept: the edited entry stays first, the new one is appended.
  assert.deepEqual(saved.plugins, [
    { name: '@acme/legacy-sso', config: { realm: 'contractors' } },
    { name: 'cors', config: { origins: ['https://app.example.test'] } },
    { name: '@acme/stamp', config: { value: 'v1' } },
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/settings`);
  await page
    .getByRole('region', { name: 'Gateway plugins' })
    .scrollIntoViewIfNeeded();
  await audit('gateway plugins panel mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  return {
    reportedStates: true,
    killSwitchFailureRetry: true,
    unreportedDisabledReversible: true,
    routeEditorOrderAndValidation: true,
    desktopMobileAccessibility: true,
  };
}
