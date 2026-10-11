import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';

/** Production UI with controlled failures; real reconciliation is verified in PostgreSQL. */
export async function verifyConfigImportDashboard({
  page,
  context,
  base,
  tenant,
  audit,
  artifacts,
}) {
  const source = JSON.stringify(
    {
      version: 1,
      services: [
        {
          name: 'browser-api',
          targets: [{ url: 'https://api.example.test', weight: 100 }],
        },
      ],
      routes: [],
      consumers: [],
    },
    null,
    2,
  );
  const revision = `1791739999.${'a'.repeat(64)}`;
  const key = 'gw_browser_config_import_verification_only_key';
  let failExport = true,
    failPreview = true,
    failApply = true,
    holding = false,
    holdingApply = false,
    releaseApply,
    release,
    held = 0;
  const requests = [];
  const errors = [];
  const jobs = new Set();
  const pattern = '**/api/tenants/*/{import*,export}';
  const handle = async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push({
      path: url.pathname,
      dryRun: url.searchParams.get('dryRun'),
    });
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    if (url.pathname.endsWith('/export')) {
      await route.fulfill({
        status: failExport ? 503 : 200,
        contentType: failExport ? 'application/json' : 'application/yaml',
        body: failExport
          ? JSON.stringify({ message: 'Export temporarily unavailable' })
          : source,
      });
      return;
    }
    assert.equal(request.headers()['content-type'], 'application/yaml');
    const document = request.postData();
    if (url.searchParams.get('dryRun') === 'true') {
      if (holding) {
        held++;
        await new Promise((done) => {
          release = done;
        });
      }
      await route
        .fulfill({
          status: failPreview ? 400 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            failPreview
              ? {
                  message:
                    'Invalid configuration. Fix the document and preview again.',
                }
              : {
                  dryRun: true,
                  revision,
                  expiresAt: new Date(Date.now() + 600000).toISOString(),
                  configVersion: 12,
                  unchanged: 2,
                  changes: [
                    {
                      resource: 'service',
                      key: 'browser-api',
                      action: 'create',
                      fields: ['targets'],
                    },
                    {
                      resource: 'route',
                      key: 'GET /v1/products',
                      action: 'update',
                      fields: ['plugins'],
                    },
                    {
                      resource: 'consumer',
                      key: 'obsolete-client',
                      action: 'remove',
                      fields: [],
                    },
                  ],
                  warnings: [],
                },
          ),
        })
        .catch((error) => {
          if (!holding) throw error;
        });
      return;
    }
    assert.equal(url.searchParams.get('dryRun'), 'false');
    assert.equal(document, source);
    assert.equal(request.headers()['if-match'], `"${revision}"`);
    if (holdingApply)
      await new Promise((done) => {
        releaseApply = done;
      });
    await route
      .fulfill({
        status: failApply ? 409 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          failApply
            ? {
                message:
                  'Configuration changed. Preview again before applying.',
              }
            : {
                dryRun: false,
                changed: 3,
                configVersion: 13,
                delivery: 'queued',
                consumerKeys: [
                  { id: 'new-consumer', name: 'New mobile app', apiKey: key },
                ],
              },
        ),
      })
      .catch((error) => {
        if (!holdingApply) throw error;
      });
  };
  const handler = (route) => {
    const work = handle(route)
      .catch((error) => {
        errors.push(error);
        throw error;
      })
      .finally(() => jobs.delete(work));
    jobs.add(work);
    return work;
  };
  await context.route(pattern, handler);
  const opener = () =>
    page.getByRole('button', { name: 'Import configuration', exact: true });
  const dialog = () =>
    page.getByRole('dialog', { name: 'Import configuration', exact: true });
  try {
    await page.goto(`${base}/settings`);
    const panel = page.getByRole('region', {
      name: 'Configuration import and export',
    });
    await panel
      .getByRole('button', { name: 'Export configuration', exact: true })
      .click();
    await expect(panel.getByRole('alert')).toHaveText(
      'Export temporarily unavailable',
    );
    failExport = false;
    const downloading = page.waitForEvent('download');
    await panel
      .getByRole('button', { name: 'Export configuration', exact: true })
      .click();
    const downloaded = await downloading;
    assert.equal(downloaded.suggestedFilename(), 'novagate-config.yaml');
    const path = await downloaded.path();
    assert.equal(readFileSync(path, 'utf8'), source);
    await opener().click();
    await expect(dialog()).toBeVisible();
    const editor = () => dialog().getByLabel('YAML or JSON configuration');
    await editor().fill('broken document');
    await dialog()
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await expect(dialog().getByRole('alert')).toContainText(
      'Invalid configuration',
    );
    await expect(editor()).toHaveValue('broken document');
    failPreview = false;
    await editor().fill(source);
    await dialog()
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await expect(
      dialog().getByRole('region', { name: 'Configuration preview' }),
    ).toBeVisible();
    await expect(
      dialog().getByRole('button', {
        name: 'Apply reviewed configuration',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      dialog().getByRole('cell', { name: 'Revoke', exact: true }),
    ).toBeVisible();
    await audit('configuration preview desktop');
    await editor().fill(`${source}\n`);
    await expect(
      dialog().getByRole('region', { name: 'Configuration preview' }),
    ).toHaveCount(0);
    await editor().fill(source);
    await dialog()
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await dialog()
      .getByLabel(
        'I reviewed these changes, including deletions and revoked keys.',
      )
      .check();
    const applyButton = dialog().getByRole('button', {
      name: 'Apply reviewed configuration',
      exact: true,
    });
    const closeButton = dialog().getByRole('button', {
      name: 'Close configuration import',
      exact: true,
    });
    await applyButton.focus();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(applyButton).toBeFocused();
    await dialog()
      .getByRole('button', {
        name: 'Apply reviewed configuration',
        exact: true,
      })
      .click();
    await expect(dialog().getByRole('alert')).toContainText(
      'Configuration changed',
    );
    await expect(editor()).toHaveValue(source);
    await expect(
      dialog().getByRole('region', { name: 'Configuration preview' }),
    ).toHaveCount(0);
    failApply = false;
    await dialog()
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await dialog()
      .getByLabel(
        'I reviewed these changes, including deletions and revoked keys.',
      )
      .check();
    await dialog()
      .getByRole('button', {
        name: 'Apply reviewed configuration',
        exact: true,
      })
      .click();
    await expect(dialog().getByRole('status')).toContainText(
      'Gateway update queued',
    );
    await expect(dialog().getByLabel('New mobile app API key')).toHaveValue(
      key,
    );
    await audit('configuration new consumer key');
    const storage = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    );
    assert(!storage.includes(key));
    assert(!storage.includes('browser-api'));
    await dialog().getByRole('button', { name: 'Done', exact: true }).click();
    await expect(opener()).toBeFocused();
    await opener().click();
    await expect(editor()).toHaveValue('');
    await expect(dialog().getByLabel('New mobile app API key')).toHaveCount(0);
    await dialog()
      .getByLabel('Configuration file')
      .setInputFiles({
        name: 'configuration.json',
        mimeType: 'application/json',
        buffer: Buffer.from(source),
      });
    await expect(editor()).toHaveValue(source);
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog()
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await expect(
      dialog().getByRole('region', { name: 'Configuration preview' }),
    ).toBeVisible();
    await audit('configuration preview mobile');
    await page.screenshot({
      path: resolve(artifacts, 'config-import-mobile.png'),
      fullPage: false,
    });
    await page.keyboard.press('Escape');
    await expect(dialog()).toHaveCount(0);
    await expect(opener()).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 960 });
    await opener().click();
    await editor().fill(source);
    holding = true;
    await dialog()
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await expect.poll(() => held).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog()).toHaveCount(0);
    release();
    await opener().click();
    await expect(editor()).toHaveValue('');
    await expect(dialog().getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await Promise.allSettled([...jobs]);
    holding = false;
    for (const mode of ['close', 'workspace']) {
      await opener().click();
      await editor().fill(source);
      await dialog()
        .getByRole('button', { name: 'Preview changes', exact: true })
        .click();
      await dialog()
        .getByLabel(
          'I reviewed these changes, including deletions and revoked keys.',
        )
        .check();
      holdingApply = true;
      const isApply = (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).searchParams.get('dryRun') === 'false';
      const aborted = page.waitForEvent('requestfailed', {
        predicate: isApply,
      });
      void aborted.catch(() => undefined);
      try {
        await dialog()
          .getByRole('button', {
            name: 'Apply reviewed configuration',
            exact: true,
          })
          .click();
        await expect.poll(() => typeof releaseApply).toBe('function');
        if (mode === 'close') await page.keyboard.press('Escape');
        else
          await page.evaluate(() => {
            localStorage.setItem(
              'gw_tenant_id',
              '47474747-1234-1234-1234-123456789abc',
            );
            window.dispatchEvent(new Event('novagate-session-change'));
          });
        assert.equal((await aborted).failure().errorText, 'net::ERR_ABORTED');
        await expect(dialog()).toHaveCount(0);
      } finally {
        releaseApply?.();
        await Promise.allSettled([...jobs]);
        holdingApply = false;
        releaseApply = undefined;
      }
      await opener().click();
      await expect(editor()).toHaveValue('');
      await expect(dialog().getByLabel('New mobile app API key')).toHaveCount(
        0,
      );
      await expect(dialog().getByRole('status')).toHaveCount(0);
      await page.keyboard.press('Escape');
      if (mode === 'workspace')
        await page.evaluate((tenant) => {
          localStorage.setItem('gw_tenant_id', tenant);
          window.dispatchEvent(new Event('novagate-session-change'));
        }, tenant);
    }
    assert.equal(errors.length, 0);
    assert(
      requests.every((request) =>
        request.path.startsWith(`/api/tenants/${tenant}/`),
      ),
    );
    return {
      exportDownload: true,
      previewFailureRetainsDocument: true,
      editingInvalidatesPreview: true,
      explicitReviewedApply: true,
      revisionConflictRequiresPreview: true,
      oneTimeKeyNoBrowserPersistence: true,
      fileImport: true,
      desktopMobileAccessibility: true,
      escapeFocusRestoration: true,
      keyboardTabContainment: true,
      interruptedPreviewDiscarded: true,
      interruptedAppliesDiscarded: 2,
      workspaceReset: true,
    };
  } finally {
    release?.();
    releaseApply?.();
    await page.keyboard.press('Escape');
    await Promise.allSettled([...jobs]);
    await context.unroute(pattern, handler);
  }
}
