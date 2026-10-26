import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

const CONSUMER = '56789012-1234-1234-1234-123456789abc';

const plans = [
  {
    id: 'free',
    name: 'Free',
    requestsPerMonth: 100000,
    consumersMax: 5,
    routesMax: 10,
    logRetentionDays: 30,
    priceMonthlyCents: 0,
    purchasable: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    requestsPerMonth: 10000000,
    consumersMax: 100,
    routesMax: 500,
    logRetentionDays: 90,
    priceMonthlyCents: 4900,
    purchasable: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    requestsPerMonth: null,
    consumersMax: null,
    routesMax: null,
    logRetentionDays: 90,
    priceMonthlyCents: null,
    purchasable: false,
  },
];

/** Stateful billing fixture; metering and Stripe are verified on PostgreSQL. */
export function billingBrowserFixture(base) {
  const state = {
    used: 85000,
    suspended: null,
    failCheckout: false,
    checkouts: [],
  };
  const overview = () => ({
    plan: plans[0],
    plans,
    month: '202610',
    resetsAt: '2026-11-01T00:00:00.000Z',
    requests: {
      used: state.used,
      limit: 100000,
      percent: Math.floor(state.used / 1000),
    },
    consumers: { used: 1, limit: 5, percent: 20 },
    routes: { used: 2, limit: 10, percent: 20 },
    logRetentionDays: { configured: 30, max: 30 },
    suspended: state.suspended,
    quotasEnforced: true,
    checkoutAvailable: true,
  });
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!/\/billing(\/|$)/.test(path)) return false;
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
    if (path.endsWith('/billing/consumer-quotas'))
      return (
        await reply(200, [
          {
            consumerId: CONSUMER,
            name: 'Storefront app',
            month: '202610',
            requests: 4950,
            monthlyQuota: 5000,
            percent: 99,
          },
        ]),
        true
      );
    if (path.endsWith('/billing/checkout')) {
      assert.equal(request.method(), 'POST');
      state.checkouts.push(request.postDataJSON());
      if (state.failCheckout) {
        state.failCheckout = false;
        return (
          await reply(503, {
            message: 'Checkout is unavailable right now. Try again shortly.',
          }),
          true
        );
      }
      // Stripe would return here after payment.
      return (
        await reply(200, { url: `${base}/billing?checkout=success` }),
        true
      );
    }
    return (await reply(200, overview()), true);
  }
  return { handle, state };
}

export async function verifyBillingDashboard({ page, base, audit, fixture }) {
  // Next's empty route announcer is also an alert.
  const banner = () => page.getByRole('alert').filter({ hasText: /\S/ });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/billing`);
  await expect(
    page.getByRole('heading', { name: 'Plan & usage', exact: true }),
  ).toBeVisible();
  // 80% warning before the quota pauses traffic.
  await expect(banner()).toContainText('85% of its monthly');
  await expect(
    page.getByRole('meter', { name: 'Requests this month used' }),
  ).toHaveAttribute('aria-valuenow', '85');
  const plansList = page.getByRole('region', { name: 'Plans' });
  await expect(plansList.getByText('Current plan')).toBeVisible();
  await expect(
    plansList.getByRole('link', { name: 'Contact sales about Enterprise' }),
  ).toBeVisible();
  await audit('billing overview warning');

  // A failed checkout keeps the page usable; the retry goes to Stripe.
  fixture.state.failCheckout = true;
  const upgrade = plansList.getByRole('button', { name: 'Switch to Pro' });
  await upgrade.click();
  await expect(plansList.getByRole('alert')).toContainText(
    'Checkout is unavailable',
  );
  await expect(upgrade).toBeEnabled();
  await upgrade.click();
  await expect(page).toHaveURL(/\/billing\?checkout=success$/);
  await expect(
    page.getByRole('status').filter({ hasText: 'Payment received' }),
  ).toBeVisible();
  assert.deepEqual(fixture.state.checkouts, [
    { planId: 'pro' },
    { planId: 'pro' },
  ]);

  // 98% is critical; a suspension says when traffic resumes.
  fixture.state.used = 98500;
  await page.goto(`${base}/billing`);
  await expect(banner()).toContainText('98%');
  fixture.state.used = 100000;
  fixture.state.suspended = {
    reason: 'QUOTA_EXCEEDED',
    until: '2026-11-01T00:00:00.000Z',
  };
  await page.goto(`${base}/billing`);
  const paused = banner();
  await expect(paused).toContainText('Traffic is paused');
  await expect(paused).toContainText('November 1, 2026');
  await expect(paused).toContainText('Upgrade to resume now');
  await audit('billing suspended');
  await page.setViewportSize({ width: 390, height: 844 });
  await audit('billing suspended mobile');
  await page.setViewportSize({ width: 1440, height: 960 });

  // Consumers show this month's usage against their own quotas.
  await page.goto(`${base}/consumers`);
  const meter = page.getByRole('meter', {
    name: 'Storefront app monthly quota used',
  });
  await expect(meter).toHaveAttribute('aria-valuenow', '99');
  await expect(page.getByText('4,950 / 5,000')).toBeVisible();
  await expect(page.getByText('Almost exhausted')).toBeVisible();
  await page.getByRole('button', { name: 'Edit Storefront app' }).click();
  const dialog = page.getByRole('dialog', { name: 'Consumer form' });
  const quota = dialog.getByLabel('Monthly request quota (optional)');
  await expect(quota).toHaveValue('');
  await quota.fill('0');
  await dialog.getByRole('button', { name: /^Save/ }).click();
  // The browser refuses out-of-range input before anything is sent.
  assert.equal(
    await quota.evaluate((input) => input.validity.rangeUnderflow),
    true,
  );
  await audit('consumer quota form');
  await page.keyboard.press('Escape');
  return {
    usageWarnings: true,
    checkoutFailureAndRedirect: true,
    suspension: true,
    consumerQuotaUsage: true,
    quotaInputValidation: true,
    desktopMobileAccessibility: true,
  };
}
