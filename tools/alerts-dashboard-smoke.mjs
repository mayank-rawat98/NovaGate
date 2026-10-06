import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';

/** Real production browser flows; fixture APIs never send external notifications. */
export async function verifyAlertsDashboard({
  page,
  context,
  base,
  tenant,
  audit,
  artifacts,
  onFixtureError,
}) {
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const now = () => new Date().toISOString();
  const availability = { webhook: true, slack: true, email: false };
  let enabled = true,
    failRead = false,
    failHistory = false,
    failWrite = false,
    conflict = false;
  const writes = [];
  let channels = [
    {
      id: uuid(1),
      name: 'On-call fixture',
      type: 'webhook',
      destination: 'https://receiver.example.test',
      hasSecret: true,
      enabled: true,
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    },
  ];
  let rules = ['firing', 'no_data', 'ok', null].map((state, index) => ({
    id: uuid(10 + index),
    name: [
      'Checkout errors',
      'Missing gateway reports',
      'Healthy traffic',
      'Paused latency',
    ][index],
    metric: index === 3 ? 'p95_latency_ms' : 'error_rate',
    operator: '>',
    threshold: index === 3 ? 1000 : 0.05,
    windowMinutes: 1,
    minRequests: 20,
    channelIds: index === 0 ? [uuid(1)] : [],
    enabled: index !== 3,
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
    notifiedState: index < 2 ? 'firing' : 'ok',
    cooldownUntil:
      index === 0 ? new Date(Date.now() + 240000).toISOString() : null,
    evaluation: state
      ? {
          state,
          value: state === 'no_data' ? null : state === 'firing' ? 0.12 : 0.01,
          requestCount: state === 'no_data' ? 3 : 100,
          coverage: state === 'no_data' ? 0.4 : 1,
          evaluatedAt: now(),
        }
      : null,
  }));
  const events = [
    {
      id: uuid(20),
      ruleId: uuid(10),
      ruleName: 'Checkout errors',
      metric: 'error_rate',
      operator: '>',
      threshold: 0.05,
      windowMinutes: 1,
      state: 'firing',
      value: 0.12,
      createdAt: now(),
      deliveries: [
        'queued',
        'processing',
        'delivered',
        'failed',
        'cancelled',
      ].map((status, index) => ({
        id: uuid(30 + index),
        channelId: uuid(1),
        channelName: `Delivery fixture ${index}`,
        type: 'webhook',
        status,
        attempts: index === 2 ? 1 : 2,
        lastError:
          status === 'failed'
            ? 'Alert destination is temporarily unavailable.'
            : null,
        nextAttemptAt: status === 'queued' ? now() : null,
        completedAt: status === 'delivered' ? now() : null,
      })),
    },
  ];
  let next = 100;
  const handler = async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    assert.equal(
      url.search,
      '',
      'Alert sessions and credentials never appear in URLs',
    );
    const other = !url.pathname.startsWith(`/api/tenants/${tenant}/alerts`);
    const path = url.pathname.split('/alerts')[1];
    const method = request.method();
    let status = 200,
      body;
    if (method === 'GET') {
      if ((path === '' && failRead) || (path === '/history' && failHistory)) {
        status = 503;
        body = { message: 'Fixture read outage' };
      } else
        body =
          path === '/history'
            ? other
              ? []
              : events
            : {
                rules: other ? [] : rules,
                channels: other ? [] : channels,
                deliveryEnabled: enabled,
                deliveryAvailability: enabled
                  ? availability
                  : { webhook: false, slack: false, email: false },
              };
    } else {
      const dto = request.postDataJSON();
      writes.push({ path, method, dto });
      if (failWrite || conflict) {
        status = conflict ? 409 : 503;
        body = {
          message: conflict
            ? 'This rule changed. Refresh before editing it.'
            : 'Fixture save outage',
        };
      } else if (method === 'POST' && path === '/channels') {
        body = {
          id: uuid(next++),
          name: dto.name,
          type: dto.type,
          enabled: dto.enabled,
          destination:
            dto.type === 'email'
              ? dto.address
              : new URL(dto.url ?? dto.webhookUrl).origin,
          hasSecret: dto.type !== 'email',
          revision: 1,
          createdAt: now(),
          updatedAt: now(),
        };
        channels.push(body);
      } else if (method === 'POST' && path === '/rules') {
        body = {
          ...dto,
          id: uuid(next++),
          revision: 1,
          evaluation: null,
          notifiedState: 'ok',
          cooldownUntil: null,
          createdAt: now(),
          updatedAt: now(),
        };
        rules.push(body);
      } else if (method === 'PUT' && path.startsWith('/channels/')) {
        const channel = channels.find(
          (item) => item.id === path.split('/').at(-1),
        );
        assert.equal(dto.revision, channel.revision);
        Object.assign(channel, {
          name: dto.name,
          enabled: dto.enabled,
          revision: channel.revision + 1,
          updatedAt: now(),
        });
        body = channel;
      } else if (method === 'PUT' && path.startsWith('/rules/')) {
        const rule = rules.find((item) => item.id === path.split('/').at(-1));
        assert.equal(dto.revision, rule.revision);
        Object.assign(rule, dto, { revision: rule.revision + 1 });
        body = rule;
      } else if (method === 'DELETE') {
        assert.deepEqual(Object.keys(dto), ['revision']);
        if (path.startsWith('/channels/'))
          channels = channels.filter(
            (item) => item.id !== path.split('/').at(-1),
          );
        else rules = rules.filter((item) => item.id !== path.split('/').at(-1));
        body = { success: true };
      } else
        throw new Error(`Unexpected alert fixture method ${method} ${path}`);
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  };
  const otherWorkspaceUrl = `**/api/tenants/${uuid(500)}`;
  const otherWorkspaceHandler = async (route) => {
    assert.equal(
      route.request().headers().authorization,
      'Bearer browser-verification-token',
    );
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: uuid(500),
        name: 'Second workspace',
        email: 'second@example.test',
        planId: 'free',
        gatewayConfigVersion: 1,
        createdAt: now(),
      }),
    });
  };
  const checkedHandler = (callback) => async (route) => {
    try {
      await callback(route);
    } catch (error) {
      onFixtureError(
        `Alert fixture ${route.request().url()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      await route
        .fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"message":"Browser fixture contract failed"}',
        })
        .catch(() => undefined);
    }
  };
  const checkedOtherWorkspaceHandler = checkedHandler(otherWorkspaceHandler);
  const checkedAlertHandler = checkedHandler(handler);
  const idleUrl = `${base}/__verification/idle`;
  const idleHandler = (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>Verification finished</title></head><body>Verification finished.</body></html>',
    });
  const checkedIdleHandler = checkedHandler(idleHandler);
  await context.route(idleUrl, checkedIdleHandler);
  await context.route(otherWorkspaceUrl, checkedOtherWorkspaceHandler);
  await context.route('**/api/tenants/*/alerts**', checkedAlertHandler);
  let completed = false;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(`${base}/alerts`);
      await expect(
        page.getByRole('button', {
          name: 'Edit rule Checkout errors',
          exact: true,
        }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole('heading', { name: 'Alerts', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Checkout errors', { exact: true }),
    ).toHaveCount(2);
    await expect(page.getByText('No data', { exact: true })).toBeVisible();
    await expect(page.getByText('Healthy', { exact: true })).toBeVisible();
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Firing cooldown ends', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText('Email delivery is unavailable.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText('Accepted by destination', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Alert destination is temporarily unavailable.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(artifacts, 'alerts-desktop.png'),
      fullPage: true,
    });
    await audit('alerts desktop states and history');
    rules[2].evaluation.evaluatedAt = new Date(
      Date.now() - 60000,
    ).toISOString();
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByText('Evaluation stale', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Healthy', { exact: true })).not.toBeVisible();
    rules[2].evaluation.evaluatedAt = now();
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(page.getByText('Healthy', { exact: true })).toBeVisible();
    failRead = true;
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByText('Alert configuration could not be loaded.', {
        exact: false,
      }),
    ).toBeVisible();
    failRead = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByText('Alert configuration could not be loaded.', {
        exact: false,
      }),
    ).not.toBeVisible();
    const add = page.getByRole('button', { name: 'Add rule', exact: true });
    await add.click();
    let form = page.getByRole('dialog', {
      name: 'Create alert rule',
      exact: true,
    });
    await form
      .getByLabel('Rule name', { exact: true })
      .fill('Browser rate rule');
    await form.getByLabel('Threshold (%)', { exact: true }).fill('12.5');
    await form.getByLabel('Window (minutes)', { exact: true }).fill('2');
    await form.getByLabel('Minimum requests', { exact: true }).fill('25');
    await form
      .getByRole('checkbox', { name: 'On-call fixture', exact: false })
      .check();
    await audit('alert rule create desktop');
    failWrite = true;
    await form
      .getByRole('button', { name: 'Create rule', exact: true })
      .click();
    await expect(form.getByRole('alert')).toHaveText('Fixture save outage');
    await expect(form.getByLabel('Threshold (%)', { exact: true })).toHaveValue(
      '12.5',
    );
    failWrite = false;
    await form
      .getByRole('button', { name: 'Create rule', exact: true })
      .click();
    await expect(form).not.toBeVisible();
    const created = writes.at(-1).dto;
    assert.equal(created.threshold, 0.125);
    assert.equal(created.windowMinutes, 2);
    assert.equal(created.minRequests, 25);
    assert.deepEqual(created.channelIds, [uuid(1)]);
    await expect(
      page.getByRole('button', {
        name: 'Edit rule Browser rate rule',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Edit rule Browser rate rule', exact: true })
      .click();
    form = page.getByRole('dialog', { name: 'Edit alert rule', exact: true });
    await expect(form.getByLabel('Threshold (%)', { exact: true })).toHaveValue(
      '12.5',
    );
    conflict = true;
    await form.getByRole('button', { name: 'Save rule', exact: true }).click();
    await expect(form.getByRole('alert')).toHaveText(
      'This rule changed. Refresh before editing it.',
    );
    conflict = false;
    await form
      .getByLabel('Metric', { exact: true })
      .selectOption('downstream_timeout_rate');
    await form.getByLabel('Threshold (%)', { exact: true }).fill('2');
    await form.getByLabel('Condition', { exact: true }).selectOption('>=');
    await form.getByRole('button', { name: 'Save rule', exact: true }).click();
    assert.equal(writes.at(-1).dto.threshold, 0.02);
    assert.equal(writes.at(-1).dto.operator, '>=');
    assert.equal(writes.at(-1).dto.revision, 1);
    await page
      .getByRole('button', { name: 'Add channel', exact: true })
      .click();
    form = page.getByRole('dialog', {
      name: 'Create notification channel',
      exact: true,
    });
    await expect(
      form
        .getByLabel('Channel type', { exact: true })
        .locator('option[value="email"]'),
    ).toBeDisabled();
    await form
      .getByLabel('Channel name', { exact: true })
      .fill('Browser webhook');
    await form
      .getByLabel('Webhook URL', { exact: true })
      .fill('https://receiver.example.test/secret-fixture-only-path');
    await form
      .getByLabel('Signing secret', { exact: true })
      .fill('browser-fixture-only-secret-at-least-32-bytes');
    await expect(
      form.getByLabel('Signing secret', { exact: true }),
    ).toHaveAttribute('type', 'password');
    await form
      .getByRole('button', { name: 'Show credentials', exact: true })
      .click();
    await expect(
      form.getByLabel('Signing secret', { exact: true }),
    ).toHaveAttribute('type', 'text');
    await form
      .getByRole('button', { name: 'Hide credentials', exact: true })
      .click();
    await form
      .getByRole('button', { name: 'Create channel', exact: true })
      .click();
    await expect(form).not.toBeVisible();
    assert.equal(writes.at(-1).dto.type, 'webhook');
    await expect(
      page.getByText('secret-fixture-only-path', { exact: false }),
    ).not.toBeVisible();
    await page
      .getByRole('button', {
        name: 'Edit channel Browser webhook',
        exact: true,
      })
      .click();
    form = page.getByRole('dialog', {
      name: 'Edit notification channel',
      exact: true,
    });
    await expect(
      form.getByLabel('Webhook URL', { exact: true }),
    ).not.toBeVisible();
    await expect(
      form.getByLabel('Channel type', { exact: true }),
    ).toBeDisabled();
    await form
      .getByLabel('Channel name', { exact: true })
      .fill('Renamed webhook');
    await form
      .getByRole('button', { name: 'Save channel', exact: true })
      .click();
    assert.equal(Object.hasOwn(writes.at(-1).dto, 'credentials'), false);
    await page
      .getByRole('button', {
        name: 'Edit channel Renamed webhook',
        exact: true,
      })
      .click();
    form = page.getByRole('dialog', {
      name: 'Edit notification channel',
      exact: true,
    });
    await form.getByLabel('Replace saved credentials', { exact: true }).check();
    await expect(form.getByLabel('Webhook URL', { exact: true })).toHaveValue(
      '',
    );
    await form
      .getByLabel('Webhook URL', { exact: true })
      .fill('https://receiver.example.test/new-private-path');
    await form
      .getByLabel('Signing secret', { exact: true })
      .fill('replacement-fixture-only-secret-at-least-32-bytes');
    failWrite = true;
    await form
      .getByRole('button', { name: 'Save channel', exact: true })
      .click();
    await expect(form.getByRole('alert')).toHaveText('Fixture save outage');
    await expect(
      form.getByLabel('Signing secret', { exact: true }),
    ).toHaveValue('replacement-fixture-only-secret-at-least-32-bytes');
    failWrite = false;
    await form
      .getByRole('button', { name: 'Save channel', exact: true })
      .click();
    assert.equal(writes.at(-1).dto.credentials.type, 'webhook');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Add rule', exact: true }).click();
    form = page.getByRole('dialog', { name: 'Create alert rule', exact: true });
    await form
      .getByLabel('Rule name', { exact: true })
      .fill('Low traffic rule');
    await form.getByLabel('Metric', { exact: true }).selectOption('rps');
    await form.getByLabel('Condition', { exact: true }).selectOption('<');
    await expect(
      form.getByLabel('Minimum requests', { exact: true }),
    ).toHaveValue('0');
    await form.getByLabel('Threshold (req/s)', { exact: true }).fill('1.25');
    await form
      .getByRole('button', { name: 'Create rule', exact: true })
      .focus();
    await page.keyboard.press('Tab');
    await expect(
      form.getByRole('button', { name: 'Close rule form', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(
      form.getByRole('button', { name: 'Create rule', exact: true }),
    ).toBeFocused();
    await audit('alert rule mobile keyboard');
    await form
      .getByRole('button', { name: 'Create rule', exact: true })
      .click();
    assert.equal(writes.at(-1).dto.threshold, 1.25);
    assert.deepEqual(writes.at(-1).dto.channelIds, []);
    await page.getByRole('button', { name: 'Add rule', exact: true }).click();
    form = page.getByRole('dialog', { name: 'Create alert rule', exact: true });
    await form
      .getByLabel('Metric', { exact: true })
      .selectOption('p95_latency_ms');
    await expect(
      form.getByLabel('Threshold (ms)', { exact: true }),
    ).toHaveValue('1000');
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
    await page
      .getByRole('button', { name: 'Add channel', exact: true })
      .click();
    form = page.getByRole('dialog', {
      name: 'Create notification channel',
      exact: true,
    });
    await form
      .getByLabel('Channel type', { exact: true })
      .selectOption('slack');
    await form
      .getByLabel('Channel name', { exact: true })
      .fill('Browser Slack');
    await form
      .getByLabel('Slack webhook URL', { exact: true })
      .fill('https://hooks.slack.com/services/FIXTURE/ONLY/NOTAREALSECRET');
    await audit('alert channel mobile');
    await form
      .getByRole('button', { name: 'Create channel', exact: true })
      .click();
    assert.equal(writes.at(-1).dto.type, 'slack');
    availability.email = true;
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByText('Email delivery is unavailable.', { exact: false }),
    ).not.toBeVisible();
    await page
      .getByRole('button', { name: 'Add channel', exact: true })
      .click();
    form = page.getByRole('dialog', {
      name: 'Create notification channel',
      exact: true,
    });
    await form
      .getByLabel('Channel type', { exact: true })
      .selectOption('email');
    await form
      .getByLabel('Channel name', { exact: true })
      .fill('Browser email');
    await form
      .getByLabel('Recipient email', { exact: true })
      .fill('fixture@example.test');
    await form
      .getByRole('button', { name: 'Create channel', exact: true })
      .click();
    assert.equal(writes.at(-1).dto.address, 'fixture@example.test');
    await page
      .getByRole('button', {
        name: 'Delete rule Low traffic rule',
        exact: true,
      })
      .click();
    form = page.getByRole('dialog', {
      name: 'Confirm alert deletion',
      exact: true,
    });
    await form.getByRole('button', { name: 'Keep it', exact: true }).click();
    await expect(
      page.getByRole('button', {
        name: 'Delete rule Low traffic rule',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Delete rule Low traffic rule',
        exact: true,
      })
      .click();
    form = page.getByRole('dialog', {
      name: 'Confirm alert deletion',
      exact: true,
    });
    failWrite = true;
    await form
      .getByRole('button', { name: 'Delete permanently', exact: true })
      .click();
    await expect(form.getByRole('alert')).toBeVisible();
    failWrite = false;
    await form
      .getByRole('button', { name: 'Delete permanently', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Delete rule Low traffic rule',
        exact: true,
      }),
    ).not.toBeVisible();
    await page
      .getByRole('button', {
        name: 'Delete channel Browser email',
        exact: true,
      })
      .click();
    form = page.getByRole('dialog', {
      name: 'Confirm alert deletion',
      exact: true,
    });
    await form
      .getByRole('button', { name: 'Delete permanently', exact: true })
      .click();
    assert.equal(writes.at(-1).method, 'DELETE');
    failHistory = true;
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByText('Alert history could not be loaded.', { exact: false }),
    ).toBeVisible();
    failHistory = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      page.getByText('Alert history could not be loaded.', { exact: false }),
    ).not.toBeVisible();
    enabled = false;
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Add channel', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Add rule', exact: true }),
    ).toBeEnabled();
    await audit('alerts delivery unavailable mobile');
    enabled = true;
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Add channel', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Add channel', exact: true })
      .click();
    form = page.getByRole('dialog', {
      name: 'Create notification channel',
      exact: true,
    });
    await form
      .getByLabel('Webhook URL', { exact: true })
      .fill('https://receiver.example.test/unsaved-private-value');
    await page.evaluate((other) => {
      localStorage.setItem('gw_tenant_id', other);
      window.dispatchEvent(new Event('novagate-session-change'));
    }, uuid(500));
    await expect(form).not.toBeVisible();
    await expect(
      page.getByText('Checkout errors', { exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByText('No channels yet.', { exact: false }),
    ).toBeVisible();
    await page.evaluate((tenant) => {
      localStorage.setItem('gw_tenant_id', tenant);
      window.dispatchEvent(new Event('storage'));
    }, tenant);
    await expect(
      page.getByRole('button', {
        name: 'Edit rule Checkout errors',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByLabel('Find a rule', { exact: true })
      .fill('does-not-exist');
    await expect(
      page.getByText('No rules match your search.', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('Find a rule', { exact: true }).fill('');
    await page.screenshot({
      path: resolve(artifacts, 'alerts-mobile.png'),
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await audit('alerts mobile final');
    const seedRule = rules[0],
      seedChannel = channels[0];
    rules = Array.from({ length: 100 }, (_, index) => ({
      ...seedRule,
      id: uuid(600 + index),
      name: `Capacity rule ${index}`,
    }));
    channels = Array.from({ length: 16 }, (_, index) => ({
      ...seedChannel,
      id: uuid(800 + index),
      name: `Capacity channel ${index}`,
    }));
    await page
      .getByRole('button', { name: 'Refresh alerts', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Add rule', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Add channel', exact: true }),
    ).toBeDisabled();
    completed = true;
  } finally {
    // Unmount polling before removing its fixture routes. Keep failed views
    // available for the parent screenshot and trace when verification throws.
    if (completed) await page.goto(idleUrl);
    await context.unroute('**/api/tenants/*/alerts**', checkedAlertHandler);
    await context.unroute(otherWorkspaceUrl, checkedOtherWorkspaceHandler);
    await context.unroute(idleUrl, checkedIdleHandler);
  }
}
