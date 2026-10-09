import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';

/** Display-safe fixture responses. Credentials exist only in write assertions. */
export function exportDestinationsBrowserFixture() {
  const states = new Map();
  const writes = [];
  const controls = {
    available: true,
    failRead: false,
    failWrite: false,
    conflict: false,
    holdWrite: null,
  };
  function rows(tenant) {
    if (!states.has(tenant)) states.set(tenant, []);
    return states.get(tenant);
  }
  return {
    controls,
    writes,
    rows,
    async handle(route) {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/');
      const at = parts.indexOf('log-export-destinations');
      if (at < 0) return false;
      assert.equal(
        route.request().headers().authorization,
        'Bearer browser-verification-token',
      );
      const tenant = parts[parts.indexOf('tenants') + 1];
      const method = route.request().method();
      let status = 200,
        body;
      let heldRequest = false;
      const current = rows(tenant);
      if (method === 'GET') {
        if (controls.failRead) {
          status = 503;
          body = { message: 'Destination list unavailable.' };
        } else
          body = {
            configurationAvailable: controls.available,
            deliveryAvailable: false,
            limit: 10,
            destinations: current.map((row) => ({
              ...row,
              credentialStatus: controls.available
                ? row.credentialStatus
                : 'unavailable',
            })),
          };
      } else {
        const dto = route.request().postDataJSON();
        const id = parts[at + 1];
        const row = current.find((row) => row.id === id);
        const rotation = parts.at(-1) === 'rotate-key';
        if (controls.holdWrite) {
          heldRequest = true;
          await controls.holdWrite;
        }
        if (controls.failWrite) {
          status = 503;
          body = { message: 'Destination save unavailable. Try again.' };
        } else if (
          controls.conflict ||
          (id && dto.expectedRevision !== row?.revision)
        ) {
          status = 409;
          body = {
            message: 'The export destination changed. Refresh before saving.',
          };
        } else {
          writes.push({ method, tenant, id, rotation, dto });
          if (method === 'DELETE') {
            assert.deepEqual(Object.keys(dto), ['expectedRevision']);
            current.splice(current.indexOf(row), 1);
            status = 204;
          } else if (rotation) {
            assert.deepEqual(Object.keys(dto), ['expectedRevision']);
            row.revision = randomUUID();
            row.updatedAt = new Date().toISOString();
            body = row;
          } else {
            assert.equal(typeof dto.name, 'string');
            assert.ok(
              Object.keys(dto).every((field) =>
                ['name', 'credentials', 'expectedRevision'].includes(field),
              ),
            );
            const connection = dto.credentials;
            if (connection) {
              assert.equal(controls.available, true);
              if (connection.type === 's3') {
                assert.ok(connection.endpoint.startsWith('https://'));
                assert.equal(typeof connection.forcePathStyle, 'boolean');
                assert.ok(
                  connection.bucket &&
                    connection.region &&
                    connection.accessKeyId &&
                    connection.secretAccessKey,
                );
              } else if (connection.type === 'webhook') {
                assert.ok(connection.url.startsWith('https://'));
                assert.ok(Buffer.byteLength(connection.signingSecret) >= 32);
              } else {
                assert.equal(connection.type, 'datadog');
                assert.ok(connection.site);
                assert.match(connection.apiKey, /^[a-f\d]{32}$/i);
              }
              if (row) assert.equal(connection.type, row.type);
            }
            const saved = {
              ...(row ?? {
                id: randomUUID(),
                createdAt: new Date().toISOString(),
              }),
              name: dto.name,
              type: connection?.type ?? row.type,
              destination: connection
                ? connection.type === 'datadog'
                  ? connection.site
                  : new URL(
                      connection.type === 's3'
                        ? connection.endpoint
                        : connection.url,
                    ).origin
                : row.destination,
              revision: randomUUID(),
              updatedAt: new Date().toISOString(),
              credentialStatus: connection ? 'available' : row.credentialStatus,
              state: 'draft',
            };
            if (row) current.splice(current.indexOf(row), 1, saved);
            else {
              assert.ok(connection);
              assert.ok(current.length < 10);
              current.push(saved);
              status = 201;
            }
            body = {
              ...saved,
              credentialStatus: controls.available
                ? saved.credentialStatus
                : 'unavailable',
            };
          }
        }
      }
      try {
        await route.fulfill({
          status,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          ...(status === 204 ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // These deliberately held writes are canceled by the browser below.
        // A server may still commit: test cancellation, never promise rollback.
        if (
          !heldRequest ||
          route.request().failure()?.errorText !== 'net::ERR_ABORTED'
        )
          throw error;
      }
      return true;
    },
  };
}

export async function verifyExportDestinationsDashboard({
  page,
  base,
  tenant,
  audit,
  artifacts,
  fixture,
}) {
  const { controls, writes, rows } = fixture;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/settings`);
  const panel = page.getByRole('region', {
    name: 'External export destinations',
    exact: true,
  });
  const add = panel.getByRole('button', {
    name: 'Add destination',
    exact: true,
  });
  const refresh = panel.getByRole('button', {
    name: 'Refresh destinations',
    exact: true,
  });
  const save = (form) =>
    form.getByRole('button', { name: 'Save destination draft', exact: true });
  const dialog = () =>
    page.getByRole('dialog', { name: /export destination$/ });
  await expect(add).toBeEnabled();
  await expect(
    panel.getByText('No external destinations yet.', { exact: false }),
  ).toBeVisible();
  await audit('export destinations empty desktop');
  await add.click();
  let form = dialog();
  await form.getByLabel('Destination name', { exact: true }).fill('Browser S3');
  await form
    .getByLabel('S3 endpoint', { exact: true })
    .fill('https://s3.example.com');
  await form.getByLabel('Bucket name', { exact: true }).fill('browser-logs');
  await form
    .getByLabel('Access key ID', { exact: true })
    .fill('browser-private-access');
  await form
    .getByLabel('Secret access key', { exact: true })
    .fill('browser-private-secret');
  await form
    .getByLabel('Session token (optional)', { exact: true })
    .fill('browser-private-session');
  for (const label of [
    'Access key ID',
    'Secret access key',
    'Session token (optional)',
  ])
    await expect(form.getByLabel(label, { exact: true })).toHaveAttribute(
      'type',
      'password',
    );
  await form
    .getByLabel('Use path-style bucket addresses', { exact: true })
    .uncheck();
  await audit('S3 destination form desktop');
  controls.failWrite = true;
  await save(form).click();
  await expect(form.getByRole('alert')).toContainText('save unavailable');
  await expect(
    form.getByLabel('Secret access key', { exact: true }),
  ).toHaveValue('browser-private-secret');
  controls.failWrite = false;
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.equal(writes.at(-1).dto.credentials.forcePathStyle, false);
  assert.equal(
    writes.at(-1).dto.credentials.sessionToken,
    'browser-private-session',
  );
  await expect(
    panel.getByRole('heading', { name: 'Browser S3', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('https://s3.example.com', { exact: true }),
  ).toBeVisible();
  await add.click();
  form = dialog();
  await form
    .getByLabel('Destination provider', { exact: true })
    .selectOption('webhook');
  await form
    .getByLabel('Destination name', { exact: true })
    .fill('Browser webhook');
  await form
    .getByLabel('Webhook URL', { exact: true })
    .fill(
      'https://receiver.example.com/private-fixture-path?token=private-query',
    );
  await form
    .getByLabel('Webhook signing secret', { exact: true })
    .fill('browser-private-signing-secret-at-least-32-bytes');
  await expect(form.getByLabel('Webhook URL', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await expect(
    form.getByLabel('Webhook signing secret', { exact: true }),
  ).toHaveAttribute('type', 'password');
  await save(form).click();
  await expect(form).not.toBeVisible();
  await expect(
    panel.getByText('https://receiver.example.com', { exact: true }),
  ).toBeVisible();
  await expect(panel).not.toContainText('private-fixture-path');
  await expect(panel).not.toContainText('private-query');
  await add.click();
  form = dialog();
  await form
    .getByLabel('Destination provider', { exact: true })
    .selectOption('datadog');
  await form
    .getByLabel('Destination name', { exact: true })
    .fill('Browser Datadog');
  await form
    .getByLabel('Datadog site', { exact: true })
    .selectOption('datadoghq.eu');
  await form
    .getByLabel('Datadog API key', { exact: true })
    .fill('b'.repeat(32));
  await expect(
    form.getByLabel('Datadog API key', { exact: true }),
  ).toHaveAttribute('type', 'password');
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.equal(writes.at(-1).dto.credentials.site, 'datadoghq.eu');
  await expect(
    panel.getByText('Draft · not sending', { exact: true }),
  ).toHaveCount(3);
  await page.reload();
  await panel
    .getByRole('button', { name: 'Edit Browser S3', exact: true })
    .click();
  form = dialog();
  await expect(
    form.getByLabel('Destination provider', { exact: true }),
  ).toBeDisabled();
  await expect(form.getByLabel('Access key ID', { exact: true })).toHaveCount(
    0,
  );
  await form.getByLabel('Destination name', { exact: true }).fill('S3 renamed');
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.ok(!Object.hasOwn(writes.at(-1).dto, 'credentials'));
  await panel
    .getByRole('button', { name: 'Edit Browser webhook', exact: true })
    .click();
  form = dialog();
  await form.getByLabel('Replace saved credentials', { exact: true }).check();
  await expect(form.getByLabel('Webhook URL', { exact: true })).toHaveValue('');
  await form
    .getByLabel('Webhook URL', { exact: true })
    .fill('https://next.example.com/private-replacement?token=private-query');
  await form
    .getByLabel('Webhook signing secret', { exact: true })
    .fill('browser-private-replacement-secret-at-least-32-bytes');
  controls.conflict = true;
  // Concurrent saved metadata changes must be loaded without discarding typed secrets.
  rows(tenant).find((row) => row.type === 'webhook').revision = randomUUID();
  await save(form).click();
  await expect(form.getByRole('alert')).toContainText('destination changed');
  controls.conflict = false;
  await form
    .getByRole('button', { name: 'Reload latest revision', exact: true })
    .click();
  await expect(form.getByRole('status')).toContainText(
    'Your unsaved input is kept',
  );
  await expect(
    form.getByLabel('Webhook signing secret', { exact: true }),
  ).toHaveValue('browser-private-replacement-secret-at-least-32-bytes');
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.equal(
    writes.at(-1).dto.credentials.url,
    'https://next.example.com/private-replacement?token=private-query',
  );
  const rotation = panel.getByRole('button', {
    name: 'Re-encrypt Browser webhook',
    exact: true,
  });
  await rotation.click();
  form = page.getByRole('dialog', {
    name: 'Re-encrypt saved credentials',
    exact: true,
  });
  await expect(
    form.getByText('Its provider credentials stay the same.', { exact: false }),
  ).toBeVisible();
  await audit('destination re-encryption desktop');
  await form
    .getByRole('button', { name: 'Re-encrypt credentials', exact: true })
    .click();
  await expect(form).not.toBeVisible();
  assert.equal(writes.at(-1).rotation, true);
  assert.deepEqual(Object.keys(writes.at(-1).dto), ['expectedRevision']);
  await expect(rotation).toBeFocused();
  controls.failRead = true;
  await refresh.click();
  await expect(panel.getByRole('alert')).toContainText('could not be loaded');
  await expect(add).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: 'Edit S3 renamed', exact: true }),
  ).toBeDisabled();
  controls.failRead = false;
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(add).toBeEnabled();
  rows(tenant).find((row) => row.type === 'datadog').credentialStatus =
    'unavailable';
  await refresh.click();
  await expect(
    panel.getByRole('button', {
      name: 'Re-encrypt Browser Datadog',
      exact: true,
    }),
  ).toBeDisabled();
  await panel
    .getByRole('button', { name: 'Edit Browser Datadog', exact: true })
    .click();
  form = dialog();
  await form.getByLabel('Replace saved credentials', { exact: true }).check();
  await expect(form.getByLabel('Datadog API key', { exact: true })).toHaveValue(
    '',
  );
  await form
    .getByLabel('Datadog API key', { exact: true })
    .fill('c'.repeat(32));
  await save(form).click();
  await expect(form).not.toBeVisible();
  await expect(
    panel.getByRole('button', {
      name: 'Re-encrypt Browser Datadog',
      exact: true,
    }),
  ).toBeEnabled();
  controls.available = false;
  await refresh.click();
  await expect(add).toBeDisabled();
  await expect(
    panel.getByText('Secure destination setup is unavailable', {
      exact: false,
    }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Edit S3 renamed', exact: true })
    .click();
  form = dialog();
  await expect(
    form.getByLabel('Replace saved credentials', { exact: true }),
  ).toBeDisabled();
  await form
    .getByLabel('Destination name', { exact: true })
    .fill('Unavailable S3');
  await save(form).click();
  await expect(form).not.toBeVisible();
  controls.available = true;
  await refresh.click();
  await expect(add).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await add.click();
  form = dialog();
  await form
    .getByLabel('Destination provider', { exact: true })
    .selectOption('webhook');
  await form
    .getByLabel('Destination name', { exact: true })
    .fill('Unsaved workspace secret');
  await form
    .getByLabel('Webhook URL', { exact: true })
    .fill('https://receiver.example.com/private-unsaved');
  await form
    .getByLabel('Webhook signing secret', { exact: true })
    .fill('browser-private-unsaved-secret-at-least-32-bytes');
  await audit('webhook destination form mobile');
  await form.screenshot({
    path: resolve(artifacts, 'export-destination-webhook-mobile.png'),
  });
  // Native focus wrapping and Escape restoration, followed by discarded secrets.
  await save(form).focus();
  await page.keyboard.press('Tab');
  await expect(
    form.getByRole('button', { name: 'Close destination editor', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).not.toBeVisible();
  await expect(add).toBeFocused();
  await add.click();
  form = dialog();
  await form
    .getByLabel('Destination provider', { exact: true })
    .selectOption('webhook');
  await expect(
    form.getByLabel('Webhook signing secret', { exact: true }),
  ).toHaveValue('');
  await form
    .getByLabel('Destination name', { exact: true })
    .fill('Cross-workspace unsaved');
  await form
    .getByLabel('Webhook signing secret', { exact: true })
    .fill('browser-private-cross-workspace-secret-at-least-32-bytes');
  const other = '99999999-1234-1234-1234-123456789abc';
  await page.evaluate((other) => {
    localStorage.setItem('gw_tenant_id', other);
    window.dispatchEvent(new Event('novagate-session-change'));
  }, other);
  await expect(form).not.toBeVisible();
  await expect(
    panel.getByText('No external destinations yet.', { exact: false }),
  ).toBeVisible();
  await page.evaluate((tenant) => {
    localStorage.setItem('gw_tenant_id', tenant);
    window.dispatchEvent(new Event('storage'));
  }, tenant);
  await expect(
    panel.getByRole('heading', { name: 'Browser webhook', exact: true }),
  ).toBeVisible();
  await add.click();
  form = dialog();
  await expect(
    form.getByLabel('Destination name', { exact: true }),
  ).toHaveValue('');
  await form
    .getByLabel('Destination provider', { exact: true })
    .selectOption('datadog');
  await audit('Datadog destination form mobile');
  await page.keyboard.press('Escape');
  await add.click();
  form = dialog();
  await audit('S3 destination form mobile');
  await form.screenshot({
    path: resolve(artifacts, 'export-destination-s3-mobile.png'),
  });
  await page.keyboard.press('Escape');
  const remove = panel.getByRole('button', {
    name: 'Remove Browser Datadog',
    exact: true,
  });
  await remove.click();
  form = page.getByRole('dialog', {
    name: 'Remove export destination',
    exact: true,
  });
  controls.failWrite = true;
  await form
    .getByRole('button', { name: 'Remove destination', exact: true })
    .click();
  await expect(form.getByRole('alert')).toContainText('save unavailable');
  controls.failWrite = false;
  await audit('destination removal mobile');
  await form
    .getByRole('button', { name: 'Remove destination', exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'Browser Datadog', exact: true }),
  ).toHaveCount(0);
  await expect(add).toBeFocused();
  for (const mode of ['close', 'workspace']) {
    await add.click();
    form = dialog();
    const name = `Interrupted ${mode} fixture`;
    await form.getByLabel('Destination name', { exact: true }).fill(name);
    await form
      .getByLabel('Destination provider', { exact: true })
      .selectOption('datadog');
    await form
      .getByLabel('Datadog API key', { exact: true })
      .fill('d'.repeat(32));
    let release;
    controls.holdWrite = new Promise((resolve) => {
      release = resolve;
    });
    const isHeld = (request) =>
      request.method() === 'POST' &&
      request.url().endsWith(`/tenants/${tenant}/log-export-destinations`) &&
      request.postDataJSON().name === name;
    const sent = page.waitForRequest(isHeld);
    const aborted = page.waitForEvent('requestfailed', { predicate: isHeld });
    const beforeWrites = writes.length;
    try {
      await save(form).click();
      await sent;
      if (mode === 'close')
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      else
        await page.evaluate(() => {
          localStorage.setItem(
            'gw_tenant_id',
            '10101010-1234-1234-1234-123456789abc',
          );
          window.dispatchEvent(new Event('novagate-session-change'));
        });
      const failed = await aborted;
      assert.equal(failed.failure().errorText, 'net::ERR_ABORTED');
      await expect(form).not.toBeVisible();
      if (mode === 'workspace') {
        await expect(
          panel.getByText('No external destinations yet.', { exact: false }),
        ).toBeVisible();
        await expect(panel).not.toContainText(name);
      } else await expect(add).toBeFocused();
    } finally {
      release();
      controls.holdWrite = null;
    }
    // The held fixture server commits after transport cancellation. Its response
    // must not restore the dialog, announce success or affect another workspace.
    await expect.poll(() => writes.length).toBe(beforeWrites + 1);
    await expect(panel.getByRole('status')).toHaveCount(0);
    const index = rows(tenant).findIndex((row) => row.name === name);
    assert.ok(index >= 0);
    rows(tenant).splice(index, 1);
    if (mode === 'workspace')
      await page.evaluate((tenant) => {
        localStorage.setItem('gw_tenant_id', tenant);
        window.dispatchEvent(new Event('storage'));
      }, tenant);
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(add).toBeEnabled();
  }
  // Capacity prevents admission while preserving existing rows and their actions.
  const original = [...rows(tenant)];
  for (let i = original.length; i < 10; i++)
    rows(tenant).push({
      ...original[0],
      id: randomUUID(),
      name: `Capacity ${i}`,
    });
  await refresh.click();
  await expect(add).toBeDisabled();
  await expect(
    panel.getByText('Remove a destination to add another.', { exact: false }),
  ).toBeVisible();
  fixture.rows(tenant).splice(0, 10, ...original);
  await refresh.click();
  await expect(add).toBeEnabled();
  await audit('export destination cards mobile');
  await panel.screenshot({
    path: resolve(artifacts, 'export-destinations-mobile.png'),
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await audit('export destination cards desktop');
  await panel.screenshot({
    path: resolve(artifacts, 'export-destinations-desktop.png'),
  });
  assert.doesNotMatch(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
    /browser-private|private-query|private-fixture|private-unsaved/,
  );
  assert.doesNotMatch(
    await panel.innerText(),
    /browser-private|private-query|private-fixture|private-unsaved/,
  );
  return {
    writes: writes.length,
    providers: ['s3', 'webhook', 'datadog'],
    secretSafeReads: true,
    revisionReloadPreservesInput: true,
    workspaceReset: true,
    interruptedWrites: 2,
    focusRestoration: true,
  };
}
