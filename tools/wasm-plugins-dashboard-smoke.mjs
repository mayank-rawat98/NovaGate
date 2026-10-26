import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

const SHA = 'a'.repeat(64);

/** Stateful marketplace fixture; the sandbox is verified on real processes. */
export function wasmPluginsBrowserFixture() {
  const catalog = [
    {
      id: 'header-stamp',
      name: 'header-stamp',
      version: '1.0.0',
      description: 'Adds a fixed header to requests, responses or both.',
      configKeys: [{ key: 'header', description: 'Header name' }],
      hooks: ['on_request', 'on_response'],
      allowedHosts: [],
      sha256: SHA,
      size: 1733,
    },
    {
      id: 'require-header',
      name: 'require-header',
      version: '1.0.0',
      description: 'Refuses requests that do not carry a header.',
      configKeys: [{ key: 'header', description: 'Required header' }],
      hooks: ['on_request'],
      allowedHosts: [],
      sha256: 'b'.repeat(64),
      size: 506,
    },
  ];
  const state = {
    plugins: [],
    uploads: [],
    failRemove: false,
    statuses: [],
  };
  const view = () => ({
    plugins: state.plugins,
    catalog: catalog.map((entry) => ({
      ...entry,
      installed: state.plugins.some((p) => p.catalogId === entry.id),
    })),
    reportedAt: state.statuses.length ? new Date().toISOString() : null,
    statuses: state.statuses,
  });
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.includes('/wasm-plugins')) return false;
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
    if (request.method() === 'GET') return (await reply(200, view()), true);
    if (url.pathname.endsWith('/install')) {
      const entry = catalog.find(
        (c) => c.id === request.postDataJSON().catalogId,
      );
      state.plugins.push({
        name: entry.name,
        version: entry.version,
        description: entry.description,
        sha256: entry.sha256,
        size: entry.size,
        hooks: entry.hooks,
        allowedHosts: [],
        source: 'catalog',
        catalogId: entry.id,
        installedAt: new Date().toISOString(),
      });
      state.statuses = [
        {
          name: entry.name,
          sha256: entry.sha256,
          state: 'active',
          calls: 1200,
          failures: 0,
          lastError: null,
          quarantinedUntil: null,
          p50Us: 85,
          p99Us: 310,
          maxUs: 900,
        },
      ];
      return (await reply(200, view()), true);
    }
    if (url.pathname.endsWith('/upload')) {
      const body = request.postDataJSON();
      state.uploads.push(body);
      if (body.name === 'bad')
        return (
          await reply(400, {
            message:
              'The module was refused: Import wasi_snapshot_preview1.path_open is not available in the sandbox (no WASI, filesystem or network)',
          }),
          true
        );
      state.plugins.push({
        name: body.name,
        version: body.version,
        description: body.description,
        sha256: 'c'.repeat(64),
        size: 100,
        hooks: ['on_request'],
        allowedHosts: body.allowedHosts,
        source: 'upload',
        catalogId: null,
        installedAt: new Date().toISOString(),
      });
      return (await reply(200, view()), true);
    }
    if (request.method() === 'DELETE') {
      if (state.failRemove) {
        state.failRemove = false;
        return (
          await reply(409, {
            message:
              'Remove wasm:header-stamp from these routes first: GET /orders',
          }),
          true
        );
      }
      const name = decodeURIComponent(url.pathname.split('/').at(-1));
      state.plugins = state.plugins.filter((p) => p.name !== name);
      return (await reply(200, view()), true);
    }
    return false;
  }
  return { handle, state };
}

export async function verifyWasmPluginsDashboard({
  page,
  base,
  audit,
  fixture,
}) {
  const banner = () => page.getByRole('alert').filter({ hasText: /\S/ });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/plugins`);
  await expect(
    page.getByRole('heading', { name: 'Plugin marketplace', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No WebAssembly plugins yet.')).toBeVisible();
  await audit('plugin marketplace catalog');
  await page.getByRole('button', { name: 'Install header-stamp' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'wasm:header-stamp' }),
  ).toBeVisible();
  const table = page.getByRole('region', { name: 'Installed plugins table' });
  const row = table.getByRole('row').filter({ hasText: 'wasm:header-stamp' });
  await expect(row.getByText('Running')).toBeVisible();
  await expect(row.getByText('310 µs')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Installed header-stamp' }),
  ).toBeDisabled();

  // A refused upload shows the sandbox reason; a valid one installs.
  const name = page.getByLabel('Name', { exact: true });
  await name.fill('bad');
  await page.getByLabel('Module (.wasm)').setInputFiles({
    name: 'bad.wasm',
    mimeType: 'application/wasm',
    buffer: readFileSync('libs/plugin-sdk/wasm/fixtures/wasi-fs.wasm'),
  });
  await page.getByRole('button', { name: 'Upload plugin' }).click();
  await expect(banner()).toContainText('wasi_snapshot_preview1.path_open');
  await name.fill('my-check');
  await page.getByLabel('Allowed hosts (optional)').fill('API.Partner.test');
  await page.getByLabel('Module (.wasm)').setInputFiles({
    name: 'echo.wasm',
    mimeType: 'application/wasm',
    buffer: readFileSync('libs/plugin-sdk/wasm/fixtures/echo.wasm'),
  });
  await page.getByRole('button', { name: 'Upload plugin' }).click();
  await expect(table.getByText('wasm:my-check')).toBeVisible();
  const last = fixture.state.uploads.at(-1);
  assert.equal(last.name, 'my-check');
  assert.deepEqual(last.allowedHosts, ['api.partner.test']);
  assert.equal(
    Buffer.from(last.module, 'base64').equals(
      readFileSync('libs/plugin-sdk/wasm/fixtures/echo.wasm'),
    ),
    true,
  );
  await expect(name).toHaveValue('');

  // Removal is confirmed; a refusal explains which routes use it.
  fixture.state.failRemove = true;
  await page.getByRole('button', { name: 'Remove header-stamp' }).click();
  await page.getByRole('button', { name: 'Remove header-stamp' }).click();
  await expect(banner()).toContainText('GET /orders');
  await page.getByRole('button', { name: 'Remove header-stamp' }).click();
  await page.getByRole('button', { name: 'Remove header-stamp' }).click();
  await expect(table.getByText('wasm:header-stamp')).toBeHidden();
  await audit('plugin marketplace installed');
  await page.setViewportSize({ width: 390, height: 844 });
  await audit('plugin marketplace mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  return {
    catalogInstall: true,
    runtimeStatus: true,
    uploadRefusalAndSuccess: true,
    confirmedRemovalWithRefusal: true,
    desktopMobileAccessibility: true,
  };
}
