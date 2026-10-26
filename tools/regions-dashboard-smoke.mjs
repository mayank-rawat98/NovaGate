import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Stateful region fixture; failover itself is verified on real processes. */
export function regionsBrowserFixture() {
  const now = Date.now();
  const state = {
    failSave: false,
    saves: [],
    body: {
      regions: ['us-east', 'eu-west'],
      preferredRegion: null,
      configVersion: 12,
      gateways: [
        {
          instanceId: '11111111-2222-4333-8444-555555555555',
          name: 'edge-fra-1',
          region: 'eu-west',
          connectedAt: new Date(now - 3600000).toISOString(),
          lastSeenAt: new Date(now - 10000).toISOString(),
          disconnectedAt: null,
          configVersion: 12,
          online: true,
        },
        {
          instanceId: '66666666-7777-4888-8999-000000000000',
          name: 'edge-nyc-1',
          region: 'us-east',
          connectedAt: new Date(now - 7200000).toISOString(),
          lastSeenAt: new Date(now - 300000).toISOString(),
          disconnectedAt: null,
          configVersion: 11,
          online: false,
        },
      ],
    },
  };
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/control-plane')) return false;
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
    if (request.method() === 'GET') return (await reply(200, state.body), true);
    const dto = request.postDataJSON();
    state.saves.push(dto);
    if (state.failSave) {
      state.failSave = false;
      return (
        await reply(503, { message: 'Region settings are unavailable.' }),
        true
      );
    }
    state.body = { ...state.body, preferredRegion: dto.preferredRegion };
    return (await reply(200, state.body), true);
  }
  return { handle, state };
}

export async function verifyRegionsDashboard({ page, base, audit, fixture }) {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/settings`);
  const panel = page.getByRole('region', { name: 'Control plane regions' });
  await panel.scrollIntoViewIfNeeded();
  const table = panel.getByRole('region', { name: 'Connected gateways table' });
  const live = table.getByRole('row').filter({ hasText: 'edge-fra-1' });
  await expect(live.getByText('Connected', { exact: true })).toBeVisible();
  const stale = table.getByRole('row').filter({ hasText: 'edge-nyc-1' });
  await expect(stale.getByText('Offline', { exact: true })).toBeVisible();
  await expect(stale.getByText('Behind version 12')).toBeVisible();
  const select = panel.getByLabel('Preferred region');
  const save = panel.getByRole('button', { name: 'Save preferred region' });
  await expect(save).toBeDisabled();
  await select.selectOption('eu-west');
  fixture.state.failSave = true;
  await save.click();
  await expect(panel.getByRole('alert')).toContainText('unavailable');
  // The choice survives the failure; retry saves it.
  await expect(select).toHaveValue('eu-west');
  await save.click();
  await expect(panel.getByRole('status')).toContainText('eu-west');
  assert.deepEqual(fixture.state.saves, [
    { preferredRegion: 'eu-west' },
    { preferredRegion: 'eu-west' },
  ]);
  await expect(save).toBeDisabled();
  await audit('settings control plane regions');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await audit('settings control plane regions mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  return {
    gatewayStates: true,
    behindVersion: true,
    preferredRegionFailureAndRetry: true,
    desktopMobileAccessibility: true,
  };
}
