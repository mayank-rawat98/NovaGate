import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';

/** Read-safe HTTP contract fixture. Real PostgreSQL/worker checks run separately. */
export function exportDeliveryBrowserFixture({ rows, destinationControls }) {
  const schedules = new Map(),
    writes = [],
    reads = [];
  const controls = {
    failRead: false,
    failHistory: false,
    failWrite: false,
    conflict: false,
    holdWrite: null,
    holdRead: null,
  };
  const privacy = { clientIp: 'omit', userAgent: 'omit' };
  const coverage = {
    scope: 'workspace',
    retentionHours: 168,
    scheduledTerminalLimit: 1000,
    readLimit: 50,
    prunedScheduledBatches: {
      delivered: '9007199254740993',
      failed: '2',
      expired: '3',
    },
    prunedScheduledRecords: {
      delivered: '9007199254740999',
      failed: '12',
      expired: '7',
    },
  };
  function history(id) {
    return {
      coverage,
      deliveries: [
        'queued',
        'processing',
        'delivered',
        'failed',
        'expired',
      ].map((status, index) => ({
        id: randomUUID(),
        destinationId: id,
        source: index % 2 ? 'selected_records' : 'scheduled',
        status,
        attempts: index,
        recordCount: index + 1,
        createdAt: '2026-10-11T10:00:00Z',
        expiresAt: '2026-10-12T10:00:00Z',
        nextAttemptAt: '2026-10-11T10:00:05Z',
        ...(status === 'failed' ? { error: 'attempts_exhausted' } : {}),
        ...(status === 'expired' ? { error: 'schedule_removed' } : {}),
      })),
    };
  }
  return {
    controls,
    writes,
    reads,
    schedules,
    async handle(route) {
      assert.equal(
        route.request().headers().authorization,
        'Bearer browser-verification-token',
      );
      const parts = new URL(route.request().url()).pathname.split('/');
      const tenant = parts[parts.indexOf('tenants') + 1],
        id = parts[parts.indexOf('log-export-destinations') + 1];
      const row = rows(tenant).find((row) => row.id === id),
        key = `${tenant}:${id}`;
      const method = route.request().method();
      let status = 200,
        body,
        held = false;
      if (!row) {
        status = 404;
        body = { message: 'Export destination not found.' };
      } else if (method === 'GET') {
        const isHistory = parts.at(-1) === 'history';
        if (!isHistory && controls.holdRead) {
          held = true;
          await controls.holdRead;
        }
        reads.push({ tenant, id, history: isHistory });
        if (isHistory ? controls.failHistory : controls.failRead) {
          status = 503;
          body = { message: 'Delivery read unavailable.' };
        } else
          body = isHistory
            ? history(id)
            : {
                available:
                  destinationControls.available &&
                  row.credentialStatus === 'available',
                credentialStatus: destinationControls.available
                  ? row.credentialStatus
                  : 'unavailable',
                destinationRevision: row.revision,
                schedule: schedules.has(key)
                  ? { ...schedules.get(key), destinationRevision: row.revision }
                  : null,
                tenantPrivacy: privacy,
                retentionDays: 30,
                receiptFloor: '2026-09-11T10:00:00Z',
                pendingBatches: 2,
                processingBatches: 1,
                limits: {
                  pendingBatches: 20,
                  settlementSeconds: 15,
                  maxAttempts: 6,
                  payloadLifetimeHours: 24,
                },
              };
      } else {
        const dto = route.request().postDataJSON(),
          current = schedules.get(key);
        if (controls.holdWrite) {
          held = true;
          await controls.holdWrite;
        }
        if (controls.failWrite) {
          status = 503;
          body = { message: 'Delivery save unavailable. Try again.' };
        } else if (
          controls.conflict ||
          dto.expectedDestinationRevision !== row.revision ||
          dto.expectedRevision !== (current?.revision ?? null)
        ) {
          status = 409;
          body = {
            message: 'Delivery settings changed. Refresh before saving.',
          };
        } else {
          assert.ok(
            Object.keys(dto).every((field) =>
              [
                'enabled',
                'cadence',
                'filter',
                'payloadPrivacy',
                'expectedRevision',
                'expectedDestinationRevision',
              ].includes(field),
            ),
          );
          writes.push({ tenant, id, method, dto });
          if (method === 'DELETE') {
            assert.deepEqual(Object.keys(dto).sort(), [
              'expectedDestinationRevision',
              'expectedRevision',
            ]);
            assert.ok(current);
            schedules.delete(key);
            row.state = 'draft';
            body = { removed: true };
          } else {
            assert.equal(method, 'PUT');
            assert.equal(typeof dto.enabled, 'boolean');
            assert.ok(['near_real_time', 'hourly'].includes(dto.cadence));
            assert.ok(
              Object.keys(dto.filter).every((key) =>
                ['pathPrefix', 'consumerId', 'minStatusCode'].includes(key),
              ),
            );
            assert.ok(
              Object.keys(dto.payloadPrivacy).every((key) =>
                ['clientIp', 'userAgent', 'redactedFields'].includes(key),
              ),
            );
            if (dto.enabled) assert.equal(destinationControls.available, true);
            if (
              !current ||
              JSON.stringify(current.payloadPrivacy) !==
                JSON.stringify(dto.payloadPrivacy)
            )
              row.revision = randomUUID();
            const startedAt = current?.startedAt ?? new Date().toISOString();
            body = {
              destinationId: id,
              destinationRevision: row.revision,
              revision: randomUUID(),
              enabled: dto.enabled,
              cadence: dto.cadence,
              filter: dto.filter,
              payloadPrivacy: dto.payloadPrivacy,
              startedAt,
              cursor: current?.cursor ?? startedAt,
              nextWindowAt: startedAt,
              admittedRecords: 12,
              filteredRecords: 3,
              invalidRecords: 1,
              retentionSkippedSeconds: 60,
              error: 'queue_full',
            };
            schedules.set(key, body);
            row.state = dto.enabled ? 'enabled' : 'paused';
          }
        }
      }
      try {
        await route.fulfill({
          status,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (
          !held ||
          route.request().failure()?.errorText !== 'net::ERR_ABORTED'
        )
          throw error;
      }
      return true;
    },
  };
}

export async function verifyExportDeliveryDashboard({
  page,
  tenant,
  audit,
  artifacts,
  fixture,
}) {
  const { rows, controls: destinationControls, delivery } = fixture;
  const { controls, writes, schedules } = delivery;
  const panel = page.getByRole('region', {
    name: 'External export destinations',
    exact: true,
  });
  // Destination creation for each provider is verified by the preceding suite.
  // Restore a display-safe Datadog row removed by its deletion check.
  rows(tenant).push({
    ...rows(tenant)[0],
    id: randomUUID(),
    name: 'Delivery Datadog',
    type: 'datadog',
    destination: 'datadoghq.eu',
    state: 'draft',
  });
  await panel
    .getByRole('button', { name: 'Refresh destinations', exact: true })
    .click();
  const selected = rows(tenant).filter((row) =>
    ['s3', 'webhook', 'datadog'].includes(row.type),
  );
  assert.equal(selected.length, 3);
  const first = selected[0];
  const open = (row) =>
    panel.getByRole('button', {
      name: `Delivery for ${row.name}`,
      exact: true,
    });
  const dialog = (row = first) =>
    page.getByRole('dialog', {
      name: `Delivery and history for ${row.name}`,
      exact: true,
    });
  const save = (form) =>
    form.getByRole('button', { name: 'Save delivery settings', exact: true });
  const enable = (form) =>
    form.getByLabel('Enable automatic delivery', { exact: true });
  const key = (row) => `${tenant}:${row.id}`;
  controls.failRead = true;
  controls.failHistory = true;
  await open(first).click();
  let form = dialog();
  await expect(
    form.getByText('Delivery settings could not be loaded.', { exact: false }),
  ).toBeVisible();
  await expect(
    form.getByText('Delivery history could not be loaded.', { exact: false }),
  ).toBeVisible();
  await expect(save(form)).toHaveCount(0);
  controls.failRead = false;
  controls.failHistory = false;
  await form
    .getByRole('alert')
    .filter({ hasText: 'Delivery settings could not be loaded' })
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await form
    .getByRole('alert')
    .filter({ hasText: 'Delivery history could not be loaded' })
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
  await expect(enable(form)).not.toBeChecked();
  await expect(form).toContainText('earlier logs are not backfilled');
  await expect(form).toContainText('9007199254740993 acknowledged');
  await expect(form).toContainText('9007199254740999 acknowledged');
  await expect(
    form.getByRole('region', { name: 'Recent delivery batches' }),
  ).toBeVisible();
  await audit('external delivery settings and history desktop');
  await form
    .getByLabel('Delivery cadence', { exact: true })
    .selectOption('hourly');
  await form.getByLabel('Minimum status code', { exact: true }).fill('400');
  await form
    .getByLabel('Literal path prefix (optional)', { exact: true })
    .fill('/delivery/');
  const consumer = randomUUID();
  await form
    .getByLabel('Consumer ID (optional)', { exact: true })
    .fill(consumer);
  await form
    .getByLabel('Client IP addresses', { exact: true })
    .selectOption('retain');
  await form.getByLabel('User agents', { exact: true }).selectOption('retain');
  for (const name of [
    'request paths',
    'service names',
    'request IDs',
    'consumer IDs',
    'trace IDs',
    'span IDs',
  ])
    await form
      .getByLabel(`Omit ${name.toLowerCase()}`, { exact: true })
      .check();
  await enable(form).check();
  controls.failWrite = true;
  await save(form).click();
  await expect(form.getByRole('alert')).toContainText('save unavailable');
  await expect(enable(form)).toBeChecked();
  await expect(
    form.getByLabel('Literal path prefix (optional)', { exact: true }),
  ).toHaveValue('/delivery/');
  controls.failWrite = false;
  controls.conflict = true;
  await save(form).click();
  await expect(form.getByRole('alert')).toContainText('settings changed');
  first.revision = randomUUID();
  controls.conflict = false;
  await form
    .getByRole('button', { name: 'Reload delivery revisions', exact: true })
    .click();
  await expect(form.getByRole('status')).toContainText(
    'Your selections are kept',
  );
  await expect(
    form.getByLabel('Delivery cadence', { exact: true }),
  ).toHaveValue('hourly');
  await expect(form.getByLabel('Omit span ids', { exact: true })).toBeChecked();
  const refreshedDestinationRevision = first.revision;
  await save(form).click();
  await expect(form).not.toBeVisible();
  await expect(open(first)).toBeFocused();
  assert.equal(
    writes.at(-1).dto.expectedDestinationRevision,
    refreshedDestinationRevision,
  );
  assert.deepEqual(writes.at(-1).dto.filter, {
    minStatusCode: 400,
    pathPrefix: '/delivery/',
    consumerId: consumer,
  });
  assert.equal(writes.at(-1).dto.payloadPrivacy.redactedFields.length, 6);
  const initialStart = schedules.get(key(first)).startedAt;
  await expect(panel).toContainText('Enabled · automatic');
  // Reconstruct browser state and check persisted selections, then pause/resume.
  await page.reload();
  await open(first).click();
  form = dialog();
  await expect(enable(form)).toBeChecked();
  await expect(
    form.getByLabel('Delivery cadence', { exact: true }),
  ).toHaveValue('hourly');
  await expect(
    form.getByLabel('Consumer ID (optional)', { exact: true }),
  ).toHaveValue(consumer);
  await expect(form).toContainText('Admitted records: 12');
  await expect(form).toContainText('number of lost records is unknown');
  await expect(form).toContainText('Waiting for queue space');
  await enable(form).uncheck();
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.equal(schedules.get(key(first)).cursor, initialStart);
  await expect(panel).toContainText('Paused · queued batches may finish');
  await open(first).click();
  form = dialog();
  await enable(form).check();
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.equal(schedules.get(key(first)).startedAt, initialStart);
  for (const row of selected.slice(1)) {
    await open(row).click();
    form = dialog(row);
    await expect(enable(form)).not.toBeChecked();
    await enable(form).check();
    await save(form).click();
    await expect(form).not.toBeVisible();
    assert.equal(schedules.get(key(row)).enabled, true);
  }
  const webhook = selected.find((row) => row.type === 'webhook');
  assert.ok(webhook);
  await panel
    .getByRole('button', { name: `Edit ${webhook.name}`, exact: true })
    .click();
  const destinationEditor = page.getByRole('dialog', {
    name: 'Edit export destination',
    exact: true,
  });
  await destinationEditor
    .getByRole('button', { name: 'Save destination', exact: true })
    .click();
  await expect(destinationEditor).not.toBeVisible();
  await expect(panel).toContainText('previous version were cancelled');
  await open(webhook).click();
  form = dialog(webhook);
  await expect(enable(form)).toBeChecked();
  await page.keyboard.press('Escape');
  destinationControls.available = false;
  await page.reload();
  await open(first).click();
  form = dialog();
  await expect(form).toContainText('Pause and removal remain available');
  await expect(save(form)).toBeDisabled();
  await enable(form).uncheck();
  await expect(save(form)).toBeEnabled();
  await save(form).click();
  await expect(form).not.toBeVisible();
  await open(first).click();
  form = dialog();
  await expect(enable(form)).toBeDisabled();
  await form
    .getByRole('button', { name: 'Remove automatic delivery', exact: true })
    .click();
  await expect(form).toContainText('external copies cannot be recalled');
  await form
    .getByRole('button', { name: 'Keep automatic delivery', exact: true })
    .click();
  await expect(
    form.getByRole('button', {
      name: 'Confirm remove automatic delivery',
      exact: true,
    }),
  ).toHaveCount(0);
  await form
    .getByRole('button', { name: 'Remove automatic delivery', exact: true })
    .click();
  controls.failWrite = true;
  await form
    .getByRole('button', {
      name: 'Confirm remove automatic delivery',
      exact: true,
    })
    .click();
  await expect(form.getByRole('alert')).toContainText('save unavailable');
  controls.failWrite = false;
  await form
    .getByRole('button', {
      name: 'Confirm remove automatic delivery',
      exact: true,
    })
    .click();
  await expect(form).not.toBeVisible();
  await expect(open(first)).toBeFocused();
  assert.equal(schedules.has(key(first)), false);
  destinationControls.available = true;
  await page.reload();
  await open(first).click();
  form = dialog();
  await expect(enable(form)).not.toBeChecked();
  await enable(form).check();
  await save(form).click();
  await expect(form).not.toBeVisible();
  assert.ok(
    Date.parse(schedules.get(key(first)).startedAt) > Date.parse(initialStart),
  );
  // Cancellation must suppress late success even when the fixture server commits.
  for (const mode of ['close', 'workspace']) {
    await open(first).click();
    form = dialog();
    await enable(form).uncheck();
    let release;
    controls.holdWrite = new Promise((resolve) => {
      release = resolve;
    });
    const heldRequest = (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith(`/${first.id}/delivery`);
    const sent = page.waitForRequest(heldRequest),
      aborted = page.waitForEvent('requestfailed', { predicate: heldRequest });
    // Keep the original failure visible if teardown rejects a pending wait.
    void sent.catch(() => undefined);
    void aborted.catch(() => undefined);
    const count = writes.length;
    try {
      await save(form).click();
      await sent;
      if (mode === 'close')
        await form
          .getByRole('button', { name: 'Close delivery settings', exact: true })
          .click();
      else
        await page.evaluate(() => {
          localStorage.setItem(
            'gw_tenant_id',
            '45454545-1234-1234-1234-123456789abc',
          );
          window.dispatchEvent(new Event('novagate-session-change'));
        });
      assert.equal((await aborted).failure().errorText, 'net::ERR_ABORTED');
      await expect(form).not.toBeVisible();
      if (mode === 'close') await expect(open(first)).toBeFocused();
      else await expect(panel).toContainText('No external destinations yet');
    } finally {
      release();
      controls.holdWrite = null;
    }
    await expect.poll(() => writes.length).toBe(count + 1);
    await expect(panel.getByRole('status')).toHaveCount(0);
    await page.evaluate((tenant) => {
      localStorage.setItem('gw_tenant_id', tenant);
      window.dispatchEvent(new Event('storage'));
    }, tenant);
    await panel
      .getByRole('button', { name: 'Refresh destinations', exact: true })
      .click();
    await open(first).click();
    form = dialog();
    await expect(enable(form)).not.toBeChecked();
    await enable(form).check();
    await save(form).click();
    await expect(form).not.toBeVisible();
  }
  for (const mode of ['close', 'workspace']) {
    let release;
    controls.holdRead = new Promise((resolve) => {
      release = resolve;
    });
    const isHeld = (request) =>
      request.method() === 'GET' &&
      request.url().endsWith(`/${first.id}/delivery`);
    const sent = page.waitForRequest(isHeld),
      aborted = page.waitForEvent('requestfailed', { predicate: isHeld });
    void sent.catch(() => undefined);
    void aborted.catch(() => undefined);
    const count = delivery.reads.filter(
      (read) => read.id === first.id && !read.history,
    ).length;
    try {
      await open(first).click();
      form = dialog();
      await sent;
      await expect(enable(form)).toHaveCount(0);
      await expect(form).toContainText('Loading delivery settings');
      if (mode === 'close')
        await form
          .getByRole('button', { name: 'Close delivery settings', exact: true })
          .click();
      else
        await page.evaluate(() => {
          localStorage.setItem(
            'gw_tenant_id',
            '46464646-1234-1234-1234-123456789abc',
          );
          window.dispatchEvent(new Event('novagate-session-change'));
        });
      assert.equal((await aborted).failure().errorText, 'net::ERR_ABORTED');
      await expect(form).not.toBeVisible();
      if (mode === 'workspace')
        await expect(panel).toContainText('No external destinations yet');
    } finally {
      release();
      controls.holdRead = null;
    }
    await expect
      .poll(
        () =>
          delivery.reads.filter((read) => read.id === first.id && !read.history)
            .length,
      )
      .toBe(count + 1);
    await expect(form).not.toBeVisible();
    await page.evaluate((tenant) => {
      localStorage.setItem('gw_tenant_id', tenant);
      window.dispatchEvent(new Event('storage'));
    }, tenant);
    await panel
      .getByRole('button', { name: 'Refresh destinations', exact: true })
      .click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open(first).click();
  form = dialog();
  await audit('external delivery settings and history mobile');
  await form.screenshot({
    path: resolve(artifacts, 'external-delivery-mobile.png'),
  });
  await form
    .getByRole('button', { name: 'Close delivery settings', exact: true })
    .focus();
  await page.keyboard.press('Shift+Tab');
  await expect(
    form.getByRole('region', { name: 'Recent delivery batches', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    form.getByRole('button', { name: 'Close delivery settings', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).not.toBeVisible();
  await expect(open(first)).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 960 });
  await open(first).click();
  form = dialog();
  await audit('enabled external delivery desktop');
  await form.screenshot({
    path: resolve(artifacts, 'external-delivery-desktop.png'),
  });
  await page.keyboard.press('Escape');
  assert.doesNotMatch(
    await panel.innerText(),
    /browser-private|private-query|private-fixture/,
  );
  assert.doesNotMatch(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
    /browser-private|private-query|private-fixture/,
  );
  return {
    providers: selected.map((row) => row.type),
    writes: writes.length,
    explicitActivation: true,
    revisionReloadPreservesInput: true,
    pauseResumePreservesCursor: true,
    unavailableCredentialsCanStop: true,
    removalRecreation: true,
    exactCoverage: true,
    interruptedWrites: 2,
    interruptedReads: 2,
    workspaceReset: true,
    focusRestoration: true,
  };
}
