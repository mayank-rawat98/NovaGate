import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

/** Stateful workspace-side portal fixture; real behaviour is verified in PostgreSQL. */
export function developerPortalBrowserFixture() {
  const state = {
    failSave: false,
    requests: [],
    settings: new Map(),
    developers: new Map(),
  };
  const initial = () => ({
    enabled: false,
    title: 'Bluebird Studio API',
    customDomain: null,
    apiBaseUrl: null,
    signup: 'open',
    defaultGroups: [],
    maxKeysPerDeveloper: 5,
    revision: '00000000-0000-0000-0000-000000000000',
    updatedAt: null,
  });
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/');
    const tenant = parts[parts.indexOf('tenants') + 1];
    const settingsPath = url.pathname.endsWith('/portal-settings');
    const developersPath = url.pathname.includes('/portal/developers');
    if (!settingsPath && !developersPath) return false;
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    state.requests.push({ method: request.method(), path: url.pathname });
    const reply = (status, body) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (settingsPath) {
      const current = state.settings.get(tenant) ?? initial();
      state.settings.set(tenant, current);
      if (request.method() === 'GET') return (await reply(200, current), true);
      const dto = request.postDataJSON();
      assert.deepEqual(Object.keys(dto).sort(), [
        'apiBaseUrl',
        'customDomain',
        'defaultGroups',
        'enabled',
        'expectedRevision',
        'maxKeysPerDeveloper',
        'signup',
        'title',
      ]);
      if (state.failSave) {
        state.failSave = false;
        return (
          await reply(409, {
            message:
              'Portal settings changed. Reload the current settings before saving.',
          }),
          true
        );
      }
      assert.equal(dto.expectedRevision, current.revision);
      const { expectedRevision: _ignored, ...rest } = dto;
      const saved = {
        ...rest,
        revision: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      state.settings.set(tenant, saved);
      return (await reply(200, saved), true);
    }
    const list = state.developers.get(tenant) ?? [
      {
        id: randomUUID(),
        email: 'dana@example.test',
        name: 'Dana Developer',
        status: 'active',
        createdAt: '2026-10-20T10:00:00.000Z',
        lastLoginAt: '2026-10-24T10:00:00.000Z',
        activeKeys: 2,
      },
    ];
    state.developers.set(tenant, list);
    if (request.method() === 'GET') return (await reply(200, list), true);
    const developer = list.find((entry) => entry.id === parts.at(-1));
    assert.ok(developer, 'Status change targets a listed developer');
    const { status } = request.postDataJSON();
    const revokedKeys = status === 'suspended' ? developer.activeKeys : 0;
    developer.status = status;
    if (status === 'suspended') developer.activeKeys = 0;
    return (await reply(200, { status, revokedKeys }), true);
  }
  return { handle, state };
}

export async function verifyDeveloperPortalDashboard({
  page,
  context,
  base,
  tenant,
  audit,
  fixture,
}) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/settings`);
  const panel = page.getByRole('region', { name: 'Developer portal' });
  await expect(panel.getByText('Not published')).toBeVisible();
  await expect(
    panel.getByText(`http://localhost:3004/w/${tenant}`),
  ).toBeVisible();
  const opener = panel.getByRole('button', { name: 'Edit portal settings' });
  await opener.click();
  const dialog = page.getByRole('dialog', {
    name: 'Edit developer portal settings',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Publish the portal/ }).check();
  await dialog
    .getByLabel('Custom domain (optional)')
    .fill('portal.bluebird.test');
  await dialog
    .getByLabel('Gateway address for examples (optional)')
    .fill('https://api.bluebird.test');
  await dialog
    .getByLabel('Groups for new developer keys (comma-separated)')
    .fill('partners, beta');
  await dialog.getByLabel('Active keys per developer').fill('3');
  await audit('developer portal settings form');
  fixture.state.failSave = true;
  await dialog.getByRole('button', { name: 'Save portal settings' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Reload the current');
  await expect(dialog.getByLabel('Custom domain (optional)')).toHaveValue(
    'portal.bluebird.test',
  );
  await dialog.getByRole('button', { name: 'Save portal settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(panel.getByText('Published', { exact: true })).toBeVisible();
  await expect(
    panel.getByRole('link', { name: 'https://portal.bluebird.test' }),
  ).toBeVisible();
  const saved = fixture.state.settings.get(tenant);
  assert.deepEqual(saved.defaultGroups, ['partners', 'beta']);
  assert.equal(saved.maxKeysPerDeveloper, 3);

  const developers = panel.getByRole('region', {
    name: 'Portal developer list',
  });
  await developers
    .getByRole('button', { name: 'Suspend dana@example.test' })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Suspend developer' });
  await expect(confirm.getByText(/revokes all 2 active keys/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Suspend developer' }).click();
  await expect(developers).toBeFocused();
  await expect(panel.getByRole('status')).toHaveText(
    'dana@example.test suspended; 2 keys revoked.',
  );
  await expect(
    developers.getByRole('button', { name: 'Activate dana@example.test' }),
  ).toBeVisible();

  // Route editor publishes portal metadata alongside the existing route DTO.
  let published;
  const handler = async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    published = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'r1', ...published }),
    });
  };
  const pattern = '**/api/tenants/*/routes/r1';
  await context.route(pattern, handler);
  try {
    await page.goto(`${base}/routes`);
    await page.getByRole('button', { name: 'Edit GET /v1/products' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByRole('button', { name: 'advanced' }).click();
    await editor
      .getByRole('switch', { name: 'Publish in developer portal' })
      .click();
    await editor.getByLabel('Summary').fill('List products');
    await editor
      .getByLabel('Description (plain text)')
      .fill('Returns the catalog.\nPaginate with ?page.');
    await audit('route developer portal metadata');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor).toBeHidden();
  } finally {
    await context.unroute(pattern, handler);
  }
  assert.deepEqual(published.portal, {
    visible: true,
    summary: 'List products',
    description: 'Returns the catalog.\nPaginate with ?page.',
  });
  assert.ok(Array.isArray(published.plugins));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/settings`);
  await page
    .getByRole('region', { name: 'Developer portal' })
    .scrollIntoViewIfNeeded();
  await audit('developer portal panel mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  return {
    publishWithCustomDomain: true,
    revisionConflictRetainsInput: true,
    focusRestoration: true,
    developerSuspensionRevokesKeys: true,
    routePortalMetadata: true,
    desktopMobileAccessibility: true,
  };
}
