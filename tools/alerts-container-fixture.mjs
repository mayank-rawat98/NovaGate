import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

// Disposable receiver only. No real destinations, recipients or credentials.
export async function startAlertFixture() {
  const signingSecret = randomBytes(32).toString('hex');
  const mailKey = randomBytes(24).toString('hex');
  const received = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 16384);
        chunks.push(chunk);
      }
      assert.equal(request.method, 'POST');
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString('utf8'));
      const deliveryId = request.headers['x-novagate-delivery-id'];
      assert.match(deliveryId, /^[\da-f-]{36}$/);
      let state;
      if (request.url === '/webhook/private-fixture-path') {
        const timestamp = request.headers['x-novagate-timestamp'];
        assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 10);
        assert.equal(
          request.headers['x-novagate-signature'],
          `v1=${createHmac('sha256', signingSecret).update(timestamp).update('.').update(raw).digest('hex')}`,
        );
        assert.equal(body.deliveryId, deliveryId);
        assert.deepEqual(Object.keys(body).sort(), [
          'deliveryId',
          'event',
          'tenantId',
          'version',
        ]);
        assert.deepEqual(Object.keys(body.event).sort(), [
          'createdAt',
          'id',
          'metric',
          'operator',
          'ruleId',
          'ruleName',
          'state',
          'threshold',
          'value',
          'windowMinutes',
        ]);
        assert.equal(body.version, 1);
        state = body.event.state;
      } else if (request.url === '/slack/private-fixture-path') {
        assert.equal(body.mrkdwn, false);
        assert.equal(body.unfurl_links, false);
        assert.equal(body.unfurl_media, false);
        assert.equal(body.blocks[0].text.type, 'plain_text');
        assert.ok(body.text.includes('&lt;fixture&gt;'));
        state = body.blocks[0].text.text.includes('alert firing:')
          ? 'firing'
          : 'resolved';
      } else {
        assert.equal(request.url, '/api/v1/emails/send');
        assert.equal(request.headers.authorization, `Bearer ${mailKey}`);
        assert.equal(request.headers['idempotency-key'], deliveryId);
        assert.equal(body.from, 'NovaGate fixture <sender@example.test>');
        assert.deepEqual(body.to, ['recipient@example.test']);
        assert.ok(body.html.includes('&lt;fixture&gt;'));
        assert.ok(!body.html.includes('<fixture>'));
        state = body.subject.includes('alert firing:') ? 'firing' : 'resolved';
      }
      const previous = received.filter(
        (item) => item.deliveryId === deliveryId,
      );
      if (previous.length) assert.equal(previous[0].raw, raw.toString('utf8'));
      const status =
        request.url.startsWith('/webhook/') &&
        state === 'firing' &&
        !previous.length
          ? 503
          : 202;
      received.push({
        path: request.url,
        deliveryId,
        state,
        status,
        raw: raw.toString('utf8'),
        receivedAt: Date.now(),
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"accepted":true}');
    } catch (error) {
      errors.push(error);
      response.writeHead(400);
      response.end('Fixture rejected payload');
    }
  });
  await new Promise((done) => server.listen(0, '0.0.0.0', done));
  const origin = `http://host.docker.internal:${server.address().port}`;
  const environment = [
    `ALERT_CHANNEL_KEYS=${JSON.stringify({ fixture: randomBytes(32).toString('base64') })}`,
    'ALERT_CHANNEL_ACTIVE_KEY=fixture',
    `ALERT_HTTP_TRUSTED_ORIGINS=${JSON.stringify([origin])}`,
    `SMTP_API_KEY=${mailKey}`,
    `SMTP_API_BASE_URL=${origin}`,
    'SMTP_FROM=NovaGate fixture <sender@example.test>',
  ];
  return {
    environment,
    async configure(adminUrl, headers, tenant) {
      const base = `${adminUrl}/tenants/${tenant}/alerts`;
      assert.equal((await fetch(base)).status, 401);
      assert.equal(
        (await fetch(`${adminUrl}/tenants/${randomUUID()}/alerts`, { headers }))
          .status,
        403,
      );
      const call = async (path, method = 'GET', body, expected = 200) => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { ...headers, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, expected, `${method} alert ${path}`);
        return response.json();
      };
      const channels = [];
      for (const dto of [
        {
          name: 'Webhook fixture',
          type: 'webhook',
          url: `${origin}/webhook/private-fixture-path`,
          secret: signingSecret,
        },
        {
          name: 'Slack fixture',
          type: 'slack',
          webhookUrl: `${origin}/slack/private-fixture-path`,
        },
        {
          name: 'Mailtr fixture',
          type: 'email',
          address: 'recipient@example.test',
        },
      ])
        channels.push(await call('/channels', 'POST', dto, 201));
      const rule = await call(
        '/rules',
        'POST',
        {
          name: 'Gateway errors <fixture>',
          metric: 'error_rate',
          operator: '>',
          threshold: 0.05,
          windowMinutes: 1,
          minRequests: 20,
          channelIds: channels.map((channel) => channel.id),
        },
        201,
      );
      assert.equal(rule.notifiedState, 'ok');
      assert.equal(rule.cooldownUntil, null);
      const configuration = await call('');
      assert.deepEqual(configuration.deliveryAvailability, {
        webhook: true,
        slack: true,
        email: true,
      });
      assert.equal(configuration.deliveryEnabled, true);
      const serialized = JSON.stringify(configuration);
      for (const value of [
        signingSecret,
        mailKey,
        '/private-fixture-path',
        'credentials',
        'webhookUrl',
      ])
        assert.ok(
          !serialized.includes(value),
          'Public alert reads must redact credential fields and paths',
        );
      return { rule, channels, call };
    },
    async verify({
      configuration,
      gatewayUrl,
      db,
      schema,
      tenant,
      until,
      trafficStartedAt,
    }) {
      const { rule, channels, call } = configuration;
      let healthyRequests = 0;
      let traffic;
      let stopped = false;
      // Fresh healthy traffic keeps real measured intervals available through recovery.
      const work = (async () => {
        while (!stopped && healthyRequests < 150) {
          const response = await fetch(`${gatewayUrl}/traffic/success`, {
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          healthyRequests++;
          await new Promise((done) => {
            traffic = setTimeout(done, 1000);
          });
        }
      })();
      void work.catch((error) => errors.push(error));
      const started = Date.now();
      try {
        await until(
          async () => {
            if (errors.length) throw errors[0];
            const history = (await call('/history')).filter(
              (event) => event.ruleId === rule.id,
            );
            return ['firing', 'resolved'].every((state) =>
              history.some(
                (event) =>
                  event.state === state &&
                  event.deliveries.length === 3 &&
                  event.deliveries.every(
                    (delivery) => delivery.status === 'delivered',
                  ),
              ),
            );
          },
          'Production firing, durable retry and recovery delivery',
          120000,
        );
        if (errors.length) throw errors[0];
        const history = (await call('/history')).filter(
          (event) => event.ruleId === rule.id,
        );
        assert.deepEqual(
          history.map((event) => event.state),
          ['resolved', 'firing'],
        );
        for (const event of history) {
          for (const delivery of event.deliveries) {
            assert.equal(
              delivery.attempts,
              event.state === 'firing' && delivery.type === 'webhook' ? 2 : 1,
            );
            assert.equal(delivery.lastError, null);
            assert.ok(
              received.some(
                (item) =>
                  item.deliveryId === delivery.id &&
                  item.state === event.state &&
                  item.status === 202,
              ),
            );
          }
        }
        assert.equal(received.length, 7);
        const firstFiringAcceptance = Math.min(
          ...received
            .filter((item) => item.state === 'firing' && item.status === 202)
            .map((item) => item.receivedAt),
        );
        const timeToFiringAcceptanceMs =
          firstFiringAcceptance - trafficStartedAt;
        assert.ok(
          timeToFiringAcceptanceMs < 90000,
          'Measured threshold breach must reach a local receiver within 90 seconds',
        );
        const retry = received.filter(
          (item) =>
            item.path.startsWith('/webhook/') && item.state === 'firing',
        );
        assert.equal(retry.length, 2);
        assert.equal(retry[0].deliveryId, retry[1].deliveryId);
        assert.ok(retry[1].receivedAt - retry[0].receivedAt >= 4900);
        const publicState = (await call('')).rules.find(
          (item) => item.id === rule.id,
        );
        assert.equal(publicState.notifiedState, 'ok');
        assert.equal(publicState.evaluation.state, 'ok');
        assert.ok(Date.parse(publicState.cooldownUntil) > Date.now());
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int AS count FROM public.alert_delivery_schedule WHERE "tenantId" = $1',
              [tenant],
            )
          ).rows[0].count,
          0,
        );
        const encrypted = await db.query(
          `SELECT credentials FROM ${schema}.alert_channels`,
        );
        assert.ok(!JSON.stringify(encrypted.rows).includes(signingSecret));
        await call(
          `/rules/${rule.id}`,
          'PUT',
          { ...rule, revision: rule.revision + 1 },
          400,
        );
        await call(
          `/rules/${rule.id}`,
          'PUT',
          {
            name: rule.name,
            metric: rule.metric,
            operator: rule.operator,
            threshold: rule.threshold,
            windowMinutes: rule.windowMinutes,
            minRequests: rule.minRequests,
            channelIds: rule.channelIds,
            enabled: rule.enabled,
            revision: rule.revision + 1,
          },
          409,
        );
        await call(
          `/rules/${rule.id}`,
          'DELETE',
          { revision: rule.revision + 1 },
          409,
        );
        await call(`/channels/${channels[0].id}`, 'DELETE', {
          revision: channels[0].revision,
        });
        const updated = (await call('')).rules.find(
          (item) => item.id === rule.id,
        );
        assert.equal(updated.revision, rule.revision + 1);
        assert.ok(!updated.channelIds.includes(channels[0].id));
        assert.equal(
          (await call('/history')).filter((event) => event.ruleId === rule.id)
            .length,
          2,
        );
        return {
          healthyRequests,
          elapsedMs: Date.now() - started,
          timeToFiringAcceptanceMs,
          eventStates: history.map((event) => event.state),
          acceptedDeliveries: 6,
          webhookFiringAttempts: 2,
          checks: [
            'real-gateway-window-firing-and-recovery',
            'three-live-local-receiver-formats',
            'signed-redacted-webhooks',
            'durable-five-second-retry-stable-delivery-id',
            'worker-bootstrap-after-migration',
            'tenant-auth-revision-conflicts-and-retained-history',
          ],
        };
      } finally {
        stopped = true;
        // Let the bounded pending fetch/delay settle before shutting down fixtures.
        await work;
        clearTimeout(traffic);
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
