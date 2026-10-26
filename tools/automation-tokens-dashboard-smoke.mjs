import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

/** Stateful production-UI fixture; real authorization is verified in PostgreSQL. */
export function automationTokensBrowserFixture() {
  const tokens = new Map();
  const state = { failCreate: false, failRevoke: false, requests: [] };
  const secrets = [];
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/');
    const index = parts.indexOf('automation-tokens');
    if (index < 0) return false;
    const tenant = parts[parts.indexOf('tenants') + 1];
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    state.requests.push({ method: request.method(), path: url.pathname });
    const list = tokens.get(tenant) ?? [];
    tokens.set(tenant, list);
    const reply = (status, body) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (request.method() === 'GET') {
      await reply(200, list);
      return true;
    }
    if (request.method() === 'POST') {
      const dto = request.postDataJSON();
      assert.deepEqual(Object.keys(dto).sort(), [
        'expiresInDays',
        'name',
        'scopes',
      ]);
      assert.ok(Array.isArray(dto.scopes) && dto.scopes.length > 0);
      if (state.failCreate) {
        state.failCreate = false;
        await reply(503, { message: 'Token service temporarily unavailable' });
        return true;
      }
      const token = `ngat_${randomUUID().replaceAll('-', '')}browserfixturevalue1`;
      secrets.push(token);
      const createdAt = new Date().toISOString();
      const summary = {
        id: randomUUID(),
        name: dto.name,
        scopes: [...dto.scopes].sort(),
        displayPrefix: token.slice(0, 11),
        createdAt,
        expiresAt: new Date(
          Date.now() + dto.expiresInDays * 86400000,
        ).toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      list.unshift(summary);
      await reply(201, { ...summary, token });
      return true;
    }
    if (request.method() === 'DELETE') {
      if (state.failRevoke) {
        state.failRevoke = false;
        await reply(503, { message: 'Revocation temporarily unavailable' });
        return true;
      }
      const entry = list.find((token) => token.id === parts[index + 1]);
      if (!entry) {
        await reply(404, { message: 'Token not found' });
        return true;
      }
      entry.revokedAt ??= new Date().toISOString();
      await reply(200, entry);
      return true;
    }
    return false;
  }
  return { handle, state, secrets };
}

export async function verifyAutomationTokensDashboard({
  page,
  base,
  tenant,
  audit,
  fixture,
}) {
  const firstRequest = fixture.state.requests.length;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/settings`);
  const panel = page.getByRole('region', { name: 'Automation tokens' });
  await expect(panel.getByText('No tokens yet.')).toBeVisible();
  const opener = panel.getByRole('button', { name: 'Create token' });
  await opener.click();
  let dialog = page.getByRole('dialog', { name: 'Create automation token' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  dialog = page.getByRole('dialog', { name: 'Create automation token' });
  await dialog.getByLabel('Token name').fill('GitHub deploy');
  await dialog.getByRole('button', { name: 'Create token' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Choose at least one scope.',
  );
  await dialog.getByRole('checkbox', { name: /routes:read/ }).check();
  await dialog.getByRole('checkbox', { name: /config:write/ }).check();
  await dialog.getByLabel('Expires after (days)').fill('30');
  await audit('automation token form desktop');
  fixture.state.failCreate = true;
  await dialog.getByRole('button', { name: 'Create token' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Token service temporarily unavailable',
  );
  await expect(dialog.getByLabel('Token name')).toHaveValue('GitHub deploy');
  await expect(
    dialog.getByRole('checkbox', { name: /config:write/ }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: 'Create token' }).click();

  const saved = page.getByRole('dialog', {
    name: 'Save your automation token',
  });
  await expect(saved).toBeVisible();
  const secret = fixture.secrets.at(-1);
  await expect(saved.getByLabel('Automation token value')).toHaveText(secret);
  await audit('automation token one-time secret');
  const persisted = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  assert.ok(!persisted.includes(secret), 'Token secret must not persist');
  await saved.getByRole('button', { name: 'I saved the token' }).click();
  await expect(saved).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(panel.getByRole('status')).toHaveText(
    'Token GitHub deploy created.',
  );
  const list = panel.getByRole('region', { name: 'Automation token list' });
  await expect(list.getByRole('row', { name: /GitHub deploy/ })).toBeVisible();
  await expect(list.getByText(`${secret.slice(0, 11)}…`)).toBeVisible();
  assert.ok(
    !(await panel.innerText()).includes(secret),
    'List must not show the secret',
  );

  const revoke = list.getByRole('button', { name: 'Revoke GitHub deploy' });
  await revoke.click();
  const confirm = page.getByRole('dialog', { name: 'Revoke automation token' });
  fixture.state.failRevoke = true;
  await confirm.getByRole('button', { name: 'Revoke token' }).click();
  await expect(confirm.getByRole('alert')).toHaveText(
    'Revocation temporarily unavailable',
  );
  await confirm.getByRole('button', { name: 'Revoke token' }).click();
  await expect(confirm).toBeHidden();
  await expect(list).toBeFocused();
  await expect(list.getByText('Revoked')).toBeVisible();
  await expect(
    list.getByRole('button', { name: 'Revoke GitHub deploy' }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await audit('automation tokens mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.ok(
    fixture.state.requests
      .slice(firstRequest)
      .every((request) =>
        request.path.startsWith(`/api/tenants/${tenant}/automation-tokens`),
      ),
  );
  return {
    emptyState: true,
    escapeFocusRestoration: true,
    validationBeforeRequest: true,
    failedCreateRetainsInput: true,
    oneTimeSecretNoBrowserPersistence: true,
    listOmitsSecret: true,
    failedRevokeRetried: true,
    revokedStatus: true,
    desktopMobileAccessibility: true,
  };
}
