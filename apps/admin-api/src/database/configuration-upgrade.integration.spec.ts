import { AlertEvaluatorService } from '../alerts/alert-evaluator.service';
import { METRIC_LATENCY_BUCKETS } from '@api-gateway/shared-types';
import { AlertRulesService } from '../alerts/alert-rules.service';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { TracesService } from '../proxy-config/traces.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { MigrationService } from './migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { RoutesController } from '../proxy-config/routes.controller';
import { ServicesController } from '../proxy-config/services.controller';
import { ConsumersController } from '../proxy-config/consumers.controller';
import { ConfigPushService } from '../config-push/config-push.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Configuration upgrades and updates on PostgreSQL', () => {
  let root: DataSource;
  let ds: DataSource;
  let tenant: string;
  let schema: string;
  let legacy: string;
  let explicit: string;
  let service: string;
  const database = `novagate_upgrade_${randomUUID().replace(/-/g, '')}`;
  const publish = jest.fn().mockResolvedValue(undefined);
  const push = { triggerUpdate: publish } as unknown as ConfigPushService;

  beforeAll(async () => {
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${database}`;
    ds = new DataSource({ type: 'postgres', url: url.toString() });
    await ds.initialize();
    await ds.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    tenant = randomUUID();
    schema = tenantSchema(tenant);
    await ds.query(
      `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'Upgrade tenant', $2, 'free')`,
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(ds).provisionTenant(tenant);
    [{ id: service }] = await ds.query(
      `INSERT INTO ${schema}.services (name, targets) VALUES ('upstream', '[{"url":"http://upstream.test","weight":1}]') RETURNING id`,
    );
    await ds.query(
      `ALTER TABLE ${schema}.routes ADD COLUMN "maxBodyBytes" INTEGER, ADD COLUMN cors JSONB, ADD COLUMN "ipRestriction" JSONB`,
    );
    [{ id: legacy }] = await ds.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", "maxBodyBytes", cors, "ipRestriction", plugins)
      VALUES ('POST', '/legacy', $1, 1024, '{"origins":["https://app.example.test"]}', '{"deny":["203.0.113.0/24"]}', '[{"name":"request-transform","config":{}}]') RETURNING id`,
      [service],
    );
    [{ id: explicit }] = await ds.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", "maxBodyBytes", plugins)
      VALUES ('POST', '/explicit', $1, 1024, '[{"name":"request-size-limit","config":{"maxBodyBytes":99}}]') RETURNING id`,
      [service],
    );
    await new MigrationService(ds).onModuleInit();
  }, 30000);
  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
  }, 30000);
  beforeEach(() => publish.mockClear());

  it('upgrades trace storage and log correlation idempotently without losing existing logs or spans', async () => {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO ${schema}.request_logs (id, "responseTimeMs", timestamp) VALUES ($1, 2, NOW())`,
      [id],
    );
    await ds.query(
      `ALTER TABLE ${schema}.request_logs DROP COLUMN "traceId", DROP COLUMN "spanId"`,
    );
    await ds.query(`DROP TABLE ${schema}.trace_spans`);
    await new MigrationService(ds).onModuleInit();
    expect(
      (
        await ds.query(
          `SELECT "responseTimeMs", "traceId", "spanId" FROM ${schema}.request_logs WHERE id = $1`,
          [id],
        )
      )[0],
    ).toEqual({ responseTimeMs: 2, traceId: null, spanId: null });
    await ds.query(
      `INSERT INTO ${schema}.trace_spans ("traceId", "spanId", name, kind, timestamp, "durationMs", status, attributes) VALUES ('0123456789abcdef0123456789abcdef', '0123456789abcdef', 'Gateway request', 'server', NOW(), 1.25, 'ok', '{}')`,
    );
    await new MigrationService(ds).onModuleInit();
    expect(
      (await ds.query(`SELECT "durationMs" FROM ${schema}.trace_spans`))[0]
        .durationMs,
    ).toBe(1.25);
  });
  it('queries real trace waterfalls with tenant isolation, filtering and stable keyset pagination', async () => {
    await ds.query(`DELETE FROM ${schema}.trace_spans`);
    const first = '1123456789abcdef0123456789abcdef';
    const second = '2123456789abcdef0123456789abcdef';
    const requestId = randomUUID();
    const timestamp = new Date(Date.now() - 1000).toISOString();
    const attributes = JSON.stringify({
      'http.route': '/orders',
      'gateway.request.id': requestId,
    });
    for (const traceId of [first, second]) {
      await ds.query(
        `INSERT INTO ${schema}.trace_spans ("traceId", "spanId", "parentSpanId", name, kind, timestamp, "durationMs", status, attributes)
        VALUES ($1, '0123456789abcdef', NULL, 'Gateway request', 'server', $2, 2.125, 'ok', $3),
          ($1, '1123456789abcdef', '0123456789abcdef', 'upstream HTTP1', 'client', $2, 1.25, $4, $3)`,
        [traceId, timestamp, attributes, traceId === first ? 'error' : 'ok'],
      );
    }
    const queries = new TracesService(
      ds,
      new ConfigService({ traceQueries: { pageSize: 1 } }),
    );
    const page = await queries.list(tenant, { route: '/orders', requestId });
    expect(page.traces).toEqual([
      expect.objectContaining({
        traceId: second,
        spanCount: 2,
        durationMs: 2.125,
        status: 'ok',
        requestId,
        route: '/orders',
      }),
    ]);
    expect(page.nextCursor).not.toBeNull();
    const next = await queries.list(tenant, {
      route: '/orders',
      requestId,
      cursor: page.nextCursor,
    });
    expect(next.traces).toEqual([
      expect.objectContaining({ traceId: first, status: 'error' }),
    ]);
    expect(next.nextCursor).toBeNull();
    expect(
      (await queries.list(tenant, { errorsOnly: 'true' })).traces[0].traceId,
    ).toBe(first);
    expect((await queries.list(tenant, { route: '/missing' })).traces).toEqual(
      [],
    );
    const waterfall = await queries.detail(tenant, first);
    expect(waterfall.truncated).toBe(false);
    expect(waterfall.spans).toHaveLength(2);
    expect(waterfall.spans[0].parentSpanId).toBeUndefined();
    expect(waterfall.spans[1]).toMatchObject({
      parentSpanId: '0123456789abcdef',
      durationMs: 1.25,
      status: 'error',
    });
    await ds.query(
      `UPDATE ${schema}.trace_spans SET timestamp = NOW() - INTERVAL '8 days' WHERE "traceId" = $1`,
      [first],
    );
    await expect(queries.detail(tenant, first)).rejects.toThrow('not found');
    const wideQueries = new TracesService(
      ds,
      new ConfigService({ traceQueries: { maxRangeDays: 30 } }),
    );
    expect(
      (
        await wideQueries.list(tenant, {
          from: new Date(Date.now() - 10 * 86400000).toISOString(),
          to: new Date().toISOString(),
        })
      ).traces.map((trace) => trace.traceId),
    ).toEqual([second]);
    const other = randomUUID();
    await ds.query(`CREATE SCHEMA ${tenantSchema(other)}`);
    try {
      await ds.query(
        `CREATE TABLE ${tenantSchema(other)}.trace_spans (LIKE ${schema}.trace_spans INCLUDING ALL)`,
      );
      expect((await queries.list(other, {})).traces).toEqual([]);
      await expect(queries.detail(other, first)).rejects.toThrow('not found');
    } finally {
      await ds.query(`DROP SCHEMA ${tenantSchema(other)} CASCADE`);
    }
  });
  it('upgrades metric rates and UTC timestamps idempotently while preserving history', async () => {
    await ds.query(
      `ALTER TABLE ${schema}.metrics_snapshots DROP COLUMN "aggregateWindow"`,
    );
    await ds.query(
      `ALTER TABLE ${schema}.metrics_snapshots ALTER COLUMN rps TYPE INTEGER USING rps::integer, ALTER COLUMN timestamp TYPE TIMESTAMP USING timestamp AT TIME ZONE 'UTC'`,
    );
    await ds.query(
      `INSERT INTO ${schema}.metrics_snapshots (rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp) VALUES (2, 1, 2, 3, 0, '2026-01-01T00:00:00')`,
    );
    await new MigrationService(ds).onModuleInit();
    await ds.query(
      `INSERT INTO ${schema}.metrics_snapshots (rps, timestamp) VALUES (1.125, NOW())`,
    );
    await new MigrationService(ds).onModuleInit();
    const rows = await ds.query(
      `SELECT rps, timestamp, "aggregateWindow" FROM ${schema}.metrics_snapshots ORDER BY timestamp`,
    );
    expect(rows[0]).toMatchObject({
      rps: 2,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      aggregateWindow: null,
    });
    expect(rows.at(-1).rps).toBe(1.125);
  });
  it('creates alert storage idempotently with tenant-local references and lease constraints', async () => {
    const [channel] =
      await ds.query(`INSERT INTO ${schema}.alert_channels (name, type, destination, credentials)
      VALUES ('Fixture', 'webhook', 'https://example.test', '{"version":1,"keyId":"fixture","ciphertext":"encrypted-fixture"}') RETURNING id`);
    const [rule] =
      await ds.query(`INSERT INTO ${schema}.alert_rules (name, metric, operator, threshold, "windowMinutes", "minRequests")
      VALUES ('Errors', 'error_rate', '>', 0.1, 1, 1) RETURNING id`);
    await ds.query(
      `INSERT INTO ${schema}.alert_rule_channels ("ruleId", "channelId") VALUES ($1, $2)`,
      [rule.id, channel.id],
    );
    await ds.query(
      `INSERT INTO public.alert_rule_schedule ("tenantId", "ruleId") VALUES ($1, $2)`,
      [tenant, rule.id],
    );
    await new MigrationService(ds).onModuleInit();
    expect(
      (
        await ds.query(
          `SELECT revision FROM ${schema}.alert_rules WHERE id = $1`,
          [rule.id],
        )
      )[0].revision,
    ).toBe(1);
    expect(
      (
        await ds.query(
          `SELECT "channelId" FROM ${schema}.alert_rule_channels WHERE "ruleId" = $1`,
          [rule.id],
        )
      )[0].channelId,
    ).toBe(channel.id);
    await expect(
      ds.query(
        `INSERT INTO ${schema}.alert_rule_channels ("ruleId", "channelId") VALUES ($1, $2)`,
        [rule.id, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      ds.query(`UPDATE ${schema}.alert_rules SET threshold = 2 WHERE id = $1`, [
        rule.id,
      ]),
    ).rejects.toThrow();
    await expect(
      ds.query(
        `UPDATE public.alert_rule_schedule SET "leaseToken" = gen_random_uuid() WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      ),
    ).rejects.toThrow();
    const [event] = await ds.query(
      `INSERT INTO ${schema}.alert_events ("ruleId", "ruleName", metric, operator, threshold, "windowMinutes", state, value)
      VALUES ($1, 'Errors', 'error_rate', '>', 0.1, 1, 'firing', 0.5) RETURNING id`,
      [rule.id],
    );
    await ds.query(
      `INSERT INTO ${schema}.alert_deliveries ("eventId", "channelId", "channelName", type, "channelRevision")
      VALUES ($1, $2, 'Fixture', 'webhook', 1)`,
      [event.id, channel.id],
    );
    await ds.query(`DELETE FROM ${schema}.alert_channels WHERE id = $1`, [
      channel.id,
    ]);
    expect(
      await ds.query(
        `SELECT * FROM ${schema}.alert_rule_channels WHERE "ruleId" = $1`,
        [rule.id],
      ),
    ).toEqual([]);
    expect(
      (
        await ds.query(
          `SELECT "channelId", "channelName" FROM ${schema}.alert_deliveries WHERE "eventId" = $1`,
          [event.id],
        )
      )[0],
    ).toEqual({ channelId: null, channelName: 'Fixture' });
    await ds.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM public.alert_rule_schedule WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      );
      await manager.query(`DELETE FROM ${schema}.alert_rules WHERE id = $1`, [
        rule.id,
      ]);
    });
    expect(
      (
        await ds.query(
          `SELECT "ruleId" FROM ${schema}.alert_events WHERE id = $1`,
          [event.id],
        )
      )[0].ruleId,
    ).toBeNull();
    await ds.query(`DELETE FROM ${schema}.alert_events WHERE id = $1`, [
      event.id,
    ]);
    expect(
      await ds.query(
        `SELECT id FROM ${schema}.alert_deliveries WHERE "eventId" = $1`,
        [event.id],
      ),
    ).toEqual([]);
  });
  it('stores private channel credentials, detects concurrent revisions and cancels obsolete delivery work', async () => {
    const config = new ConfigService({
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 7).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    });
    const alerts = new AlertRulesService(ds, config);
    const replica = new AlertRulesService(ds, config);
    const input = {
      name: 'Operations',
      type: 'webhook',
      url: 'https://example.test/private-path?token=fixture-private-token',
      secret: 'fixture-signing-secret-at-least-32-bytes',
    };
    const created = await alerts.createChannel(tenant, input);
    expect(created).toMatchObject({
      destination: 'https://example.test',
      revision: 1,
      hasSecret: true,
    });
    expect(JSON.stringify(created)).not.toMatch(
      /private-path|private-token|signing-secret/,
    );
    const [stored] = await ds.query(
      `SELECT credentials FROM ${schema}.alert_channels WHERE id = $1`,
      [created.id],
    );
    expect(JSON.stringify(stored)).not.toMatch(
      /private-path|private-token|signing-secret/,
    );
    expect(
      alerts.credentialCipher.decrypt(tenant, created.id, stored.credentials),
    ).toEqual({ type: 'webhook', url: input.url, secret: input.secret });
    expect(
      (await alerts.listChannels(tenant)).find(
        (channel) => channel.id === created.id,
      ),
    ).toEqual(created);
    const [event] =
      await ds.query(`INSERT INTO ${schema}.alert_events ("ruleName", metric, operator, threshold, "windowMinutes", state, value)
      VALUES ('Errors', 'error_rate', '>', 0.1, 1, 'firing', 0.5) RETURNING id`);
    const [delivery] = await ds.query(
      `INSERT INTO ${schema}.alert_deliveries ("eventId", "channelId", "channelName", type, "channelRevision")
      VALUES ($1, $2, 'Operations', 'webhook', 1) RETURNING id`,
      [event.id, created.id],
    );
    await ds.query(
      `INSERT INTO public.alert_delivery_schedule ("tenantId", "deliveryId") VALUES ($1, $2)`,
      [tenant, delivery.id],
    );
    const results = await Promise.allSettled(
      [alerts, replica].map((service) =>
        service.updateChannel(tenant, created.id, {
          name: 'Updated',
          enabled: true,
          revision: 1,
        }),
      ),
    );
    if (results.every((result) => result.status === 'rejected'))
      throw (results[0] as PromiseRejectedResult).reason;
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (
        await ds.query(
          `SELECT credentials FROM ${schema}.alert_channels WHERE id = $1`,
          [created.id],
        )
      )[0].credentials,
    ).toEqual(stored.credentials);
    expect(
      (
        await ds.query(
          `SELECT status FROM ${schema}.alert_deliveries WHERE id = $1`,
          [delivery.id],
        )
      )[0].status,
    ).toBe('cancelled');
    expect(
      await ds.query(
        `SELECT * FROM public.alert_delivery_schedule WHERE "tenantId" = $1 AND "deliveryId" = $2`,
        [tenant, delivery.id],
      ),
    ).toEqual([]);
    const replaced = await alerts.updateChannel(tenant, created.id, {
      name: 'Updated',
      enabled: true,
      revision: 2,
      credentials: {
        type: 'webhook',
        url: 'https://replacement.example.test/new-secret-path',
        secret: input.secret,
      },
    });
    expect(replaced).toMatchObject({
      revision: 3,
      destination: 'https://replacement.example.test',
    });
    await expect(alerts.removeChannel(tenant, created.id, 2)).rejects.toThrow(
      'channel changed',
    );
    const other = randomUUID();
    await ds.query(
      `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'Other', $2, 'free')`,
      [other, `${other}@example.test`],
    );
    await new TenantProvisioningService(ds).provisionTenant(other);
    try {
      expect(await alerts.listChannels(other)).toEqual([]);
      await expect(
        alerts.updateChannel(other, created.id, {
          name: 'Stolen',
          enabled: true,
          revision: 3,
        }),
      ).rejects.toThrow('not found');
    } finally {
      await ds.query(`DROP SCHEMA ${tenantSchema(other)} CASCADE`);
      await ds.query(`DELETE FROM public.api_keys WHERE "tenantId" = $1`, [
        other,
      ]);
      await ds.query(`DELETE FROM public.tenants WHERE id = $1`, [other]);
    }
    await alerts.removeChannel(tenant, created.id, 3);
    expect(
      (
        await ds.query(
          `SELECT "channelId", "channelName" FROM ${schema}.alert_deliveries WHERE id = $1`,
          [delivery.id],
        )
      )[0],
    ).toEqual({ channelId: null, channelName: 'Operations' });
    await ds.query(`DELETE FROM ${schema}.alert_events WHERE id = $1`, [
      event.id,
    ]);
    await alerts.onModuleDestroy();
    await replica.onModuleDestroy();
  });
  it('enforces the channel capacity across concurrent replicas', async () => {
    const other = randomUUID();
    await ds.query(
      `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'Capacity fixture', $2, 'free')`,
      [other, `${other}@example.test`],
    );
    await new TenantProvisioningService(ds).provisionTenant(other);
    const config = new ConfigService({
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 8).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    });
    const replicas = [
      new AlertRulesService(ds, config),
      new AlertRulesService(ds, config),
    ];
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 18 }, (_, i) =>
          replicas[i % 2].createChannel(other, {
            name: `Fixture ${i}`,
            type: 'email',
            address: `fixture-${i}@example.test`,
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(16);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(2);
      expect(await replicas[0].listChannels(other)).toHaveLength(16);
    } finally {
      await Promise.all(replicas.map((service) => service.onModuleDestroy()));
      await ds.query(`DROP SCHEMA ${tenantSchema(other)} CASCADE`);
      await ds.query(`DELETE FROM public.api_keys WHERE "tenantId" = $1`, [
        other,
      ]);
      await ds.query(`DELETE FROM public.tenants WHERE id = $1`, [other]);
    }
  });
  it('persists rules and due work atomically, rejects stale edits and preserves cancelled event history', async () => {
    const config = new ConfigService({
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 9).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    });
    const alerts = new AlertRulesService(ds, config);
    const replica = new AlertRulesService(ds, config);
    const channel = await alerts.createChannel(tenant, {
      name: 'Fixture email',
      type: 'email',
      address: 'fixture@example.test',
    });
    const input = {
      name: 'Errors',
      metric: 'error_rate',
      operator: '>',
      threshold: 0.1,
      windowMinutes: 1,
      channelIds: [channel.id],
    };
    const rule = await alerts.createRule(tenant.toUpperCase(), input);
    expect(rule).toMatchObject({
      revision: 1,
      channelIds: [channel.id],
      enabled: true,
      evaluation: null,
    });
    expect(
      await ds.query(
        `SELECT "ruleId" FROM public.alert_rule_schedule WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      ),
    ).toEqual([{ ruleId: rule.id }]);
    const count = (
      await ds.query(`SELECT COUNT(*)::int AS count FROM ${schema}.alert_rules`)
    )[0].count;
    await expect(
      alerts.createRule(tenant, { ...input, channelIds: [randomUUID()] }),
    ).rejects.toThrow('from this workspace');
    expect(
      (
        await ds.query(
          `SELECT COUNT(*)::int AS count FROM ${schema}.alert_rules`,
        )
      )[0].count,
    ).toBe(count);
    await expect(
      alerts.updateRule(tenant, rule.id, {
        ...input,
        channelIds: [randomUUID()],
        revision: 1,
      }),
    ).rejects.toThrow('from this workspace');
    expect(
      (await alerts.configuration(tenant)).rules.find(
        (row) => row.id === rule.id,
      )?.revision,
    ).toBe(1);
    const [event] = await ds.query(
      `INSERT INTO ${schema}.alert_events ("ruleId", "ruleName", metric, operator, threshold, "windowMinutes", state, value)
      VALUES ($1, 'Errors', 'error_rate', '>', 0.1, 1, 'firing', 0.5) RETURNING id`,
      [rule.id],
    );
    const [delivery] = await ds.query(
      `INSERT INTO ${schema}.alert_deliveries ("eventId", "channelId", "channelName", type, "channelRevision")
      VALUES ($1, $2, 'Fixture email', 'email', 1) RETURNING id`,
      [event.id, channel.id],
    );
    await ds.query(
      `INSERT INTO public.alert_delivery_schedule ("tenantId", "deliveryId") VALUES ($1, $2)`,
      [tenant, delivery.id],
    );
    const results = await Promise.allSettled(
      [alerts, replica].map((service) =>
        service.updateRule(tenant, rule.id, {
          ...input,
          enabled: false,
          revision: 1,
        }),
      ),
    );
    if (results.every((result) => result.status === 'rejected'))
      throw (results[0] as PromiseRejectedResult).reason;
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await ds.query(
        `SELECT * FROM public.alert_rule_schedule WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      ),
    ).toEqual([]);
    expect(
      await ds.query(
        `SELECT * FROM public.alert_delivery_schedule WHERE "tenantId" = $1 AND "deliveryId" = $2`,
        [tenant, delivery.id],
      ),
    ).toEqual([]);
    const history = await alerts.history(tenant);
    expect(history.find((row) => row.id === event.id)).toMatchObject({
      ruleId: rule.id,
      ruleName: 'Errors',
      deliveries: [{ status: 'cancelled', attempts: 0, nextAttemptAt: null }],
    });
    expect(JSON.stringify(history)).not.toMatch(
      /credentials|ciphertext|eventId/,
    );
    const resumed = await alerts.updateRule(tenant, rule.id, {
      ...input,
      enabled: true,
      revision: 2,
    });
    expect(resumed.revision).toBe(3);
    await alerts.removeChannel(tenant, channel.id, 1);
    const changed = (await alerts.configuration(tenant)).rules.find(
      (row) => row.id === rule.id,
    );
    expect(changed).toMatchObject({ revision: 4, channelIds: [] });
    await expect(alerts.removeRule(tenant, rule.id, 3)).rejects.toThrow(
      'rule changed',
    );
    await alerts.removeRule(tenant, rule.id, 4);
    expect(
      (await alerts.history(tenant)).find((row) => row.id === event.id),
    ).toMatchObject({ ruleId: null, ruleName: 'Errors' });
    expect(
      await ds.query(
        `SELECT * FROM public.alert_rule_schedule WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      ),
    ).toEqual([]);
    await ds.query(`DELETE FROM ${schema}.alert_events WHERE id = $1`, [
      event.id,
    ]);
    await Promise.all([alerts.onModuleDestroy(), replica.onModuleDestroy()]);
  });
  it('enforces rule capacity across replicas and rejects cross-tenant rule references', async () => {
    const other = randomUUID();
    await ds.query(
      `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'Rule capacity fixture', $2, 'free')`,
      [other, `${other}@example.test`],
    );
    await new TenantProvisioningService(ds).provisionTenant(other);
    const otherSchema = tenantSchema(other);
    const config = new ConfigService({
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 10).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    });
    const replicas = [
      new AlertRulesService(ds, config),
      new AlertRulesService(ds, config),
    ];
    const input = {
      name: 'Traffic',
      metric: 'rps',
      operator: '<',
      threshold: 1,
      windowMinutes: 1,
      channelIds: [],
    };
    try {
      const foreignChannel = await replicas[0].createChannel(other, {
        name: 'Foreign fixture',
        type: 'email',
        address: 'fixture@example.test',
      });
      await expect(
        replicas[0].createRule(tenant, {
          ...input,
          channelIds: [foreignChannel.id],
        }),
      ).rejects.toThrow('from this workspace');
      await ds.query(`INSERT INTO ${otherSchema}.alert_rules (name, metric, operator, threshold, "windowMinutes", "minRequests", enabled)
        SELECT 'Seed fixture ' || i, 'rps', '<', 1, 1, 0, false FROM generate_series(1, 98) i`);
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          replicas[i % 2].createRule(other, input),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(2);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(2);
      const configuration = await replicas[0].configuration(other);
      expect(configuration.rules).toHaveLength(100);
      const created = results.find(
        (result) => result.status === 'fulfilled',
      ) as PromiseFulfilledResult<
        Awaited<ReturnType<AlertRulesService['createRule']>>
      >;
      await expect(
        replicas[0].updateRule(tenant, created.value.id, {
          ...input,
          revision: 1,
        }),
      ).rejects.toThrow('not found');
      await expect(
        replicas[0].removeRule(tenant, created.value.id, 1),
      ).rejects.toThrow('not found');
      expect(
        (await replicas[0].configuration(tenant)).rules.some(
          (rule) => rule.id === created.value.id,
        ),
      ).toBe(false);
      expect(
        await ds.query(
          `SELECT "ruleId" FROM public.alert_rule_schedule WHERE "tenantId" = $1`,
          [other],
        ),
      ).toHaveLength(2);
    } finally {
      await Promise.all(replicas.map((service) => service.onModuleDestroy()));
      await ds.query(`DROP SCHEMA ${otherSchema} CASCADE`);
      await ds.query(`DELETE FROM public.api_keys WHERE "tenantId" = $1`, [
        other,
      ]);
      await ds.query(`DELETE FROM public.tenants WHERE id = $1`, [other]);
    }
  });
  it('bounds recent alert history and immediately excludes expired events', async () => {
    const alerts = new AlertRulesService(ds, new ConfigService());
    try {
      await ds.query(`INSERT INTO ${schema}.alert_events ("ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt")
        SELECT 'History fixture', 'rps', '<', 1, 1, 'firing', 0.5, NOW() - make_interval(secs => i) FROM generate_series(1, 101) i`);
      await ds.query(`INSERT INTO ${schema}.alert_events ("ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt")
        VALUES ('Expired fixture', 'rps', '<', 1, 1, 'resolved', 1, NOW() - INTERVAL '31 days')`);
      const history = await alerts.history(tenant);
      expect(history).toHaveLength(100);
      expect(
        history.some((event) => event.ruleName === 'Expired fixture'),
      ).toBe(false);
      expect(history.every((event) => event.deliveries.length === 0)).toBe(
        true,
      );
      expect(history.map((event) => event.createdAt)).toEqual(
        history
          .map((event) => event.createdAt)
          .sort()
          .reverse(),
      );
    } finally {
      await ds.query(
        `DELETE FROM ${schema}.alert_events WHERE "ruleName" IN ('History fixture', 'Expired fixture')`,
      );
      await alerts.onModuleDestroy();
    }
  });
  it('reports delivery availability without revealing operator credentials', async () => {
    const keys = {
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 12).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    };
    const cases = [
      { config: {}, expected: { webhook: false, slack: false, email: false } },
      {
        config: { ...keys, SMTP_API_KEY: '' },
        expected: { webhook: true, slack: true, email: false },
      },
      {
        config: { ...keys, SMTP_API_KEY: 'local-mail-fixture' },
        expected: { webhook: true, slack: true, email: true },
      },
    ];
    for (const item of cases) {
      const alerts = new AlertRulesService(ds, new ConfigService(item.config));
      try {
        const configuration = await alerts.configuration(tenant);
        expect(configuration.deliveryAvailability).toEqual(item.expected);
        expect(configuration.deliveryEnabled).toBe(item.expected.webhook);
        expect(JSON.stringify(configuration)).not.toContain(
          'local-mail-fixture',
        );
        expect(JSON.stringify(configuration)).not.toContain(
          keys.ALERT_CHANNEL_KEYS,
        );
      } finally {
        await alerts.onModuleDestroy();
      }
    }
  });
  it('fences concurrent evaluation leases and atomically persists cooldown, resolution and delivery work', async () => {
    const config = new ConfigService({
      ALERT_CHANNEL_KEYS: JSON.stringify({
        fixture: Buffer.alloc(32, 12).toString('base64'),
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'fixture',
    });
    const alerts = new AlertRulesService(ds, config);
    const workers = [
      new AlertEvaluatorService(ds, alerts),
      new AlertEvaluatorService(ds, alerts),
    ];
    const channel = await alerts.createChannel(tenant, {
      name: 'Evaluator fixture',
      type: 'email',
      address: 'fixture@example.test',
    });
    const input = {
      name: 'Evaluator fixture',
      metric: 'error_rate',
      operator: '>',
      threshold: 0.1,
      windowMinutes: 1,
      channelIds: [channel.id],
    };
    const rule = await alerts.createRule(tenant, input);
    expect(rule.notifiedState).toBe('ok');
    expect(rule.cooldownUntil).toBeNull();
    async function metrics(errors: number) {
      await ds.query(`TRUNCATE ${schema}.metrics_snapshots`);
      const window = {
        windowMs: 1000,
        requestCount: 10,
        errorCount: errors,
        timeoutCount: errors ? 1 : 0,
        latencyCounts: METRIC_LATENCY_BUCKETS.map((bucket) =>
          bucket === 5 ? 10 : 0,
        ),
      };
      await ds.query(
        `INSERT INTO ${schema}.metrics_snapshots (rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp, "aggregateWindow")
        SELECT 10, 5, 5, 5, $1, clock_timestamp() - make_interval(secs => i) - INTERVAL '100 milliseconds', $2::jsonb FROM generate_series(0, 59) i`,
        [errors / 10, JSON.stringify(window)],
      );
    }
    async function evaluateDue() {
      await ds.query(
        `UPDATE public.alert_rule_schedule SET "dueAt" = NOW() WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      );
      const leases = await workers[0].claimDue();
      expect(leases).toHaveLength(1);
      expect(await workers[0].evaluateLease(leases[0])).toBe(true);
    }
    try {
      await metrics(5);
      await ds.query(
        `CREATE FUNCTION public.alert_due_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture due write failed'; END $$`,
      );
      await ds.query(
        `CREATE TRIGGER alert_due_failure_fixture BEFORE INSERT ON public.alert_delivery_schedule FOR EACH ROW EXECUTE FUNCTION public.alert_due_failure_fixture()`,
      );
      const [failedLease] = await workers[0].claimDue();
      await expect(workers[0].evaluateLease(failedLease)).rejects.toThrow(
        'fixture due write failed',
      );
      expect(
        await ds.query(
          `SELECT id FROM ${schema}.alert_events WHERE "ruleId" = $1`,
          [rule.id],
        ),
      ).toEqual([]);
      expect(
        (
          await ds.query(
            `SELECT evaluation, "notifiedState", "cooldownUntil" FROM ${schema}.alert_rules WHERE id = $1`,
            [rule.id],
          )
        )[0],
      ).toEqual({ evaluation: null, notifiedState: 'ok', cooldownUntil: null });
      await ds.query(
        `DROP TRIGGER alert_due_failure_fixture ON public.alert_delivery_schedule`,
      );
      await ds.query(`DROP FUNCTION public.alert_due_failure_fixture()`);
      await ds.query(
        `UPDATE public.alert_rule_schedule SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      );
      const claims = (
        await Promise.all(workers.map((worker) => worker.claimDue()))
      ).flat();
      expect(claims).toHaveLength(1);
      expect(
        (
          await Promise.all(
            workers.map((worker) => worker.evaluateLease(claims[0])),
          )
        ).sort(),
      ).toEqual([false, true]);
      let history = await alerts.history(tenant);
      expect(history.filter((event) => event.ruleId === rule.id)).toHaveLength(
        1,
      );
      expect(history.find((event) => event.ruleId === rule.id)).toMatchObject({
        state: 'firing',
        value: 0.5,
        deliveries: [{ channelId: channel.id, status: 'queued', attempts: 0 }],
      });
      expect(
        await ds.query(
          `SELECT "deliveryId" FROM public.alert_delivery_schedule WHERE "tenantId" = $1`,
          [tenant],
        ),
      ).toHaveLength(1);
      const firingRule = (await alerts.configuration(tenant)).rules.find(
        (row) => row.id === rule.id,
      );
      expect(firingRule?.notifiedState).toBe('firing');
      const storedCooldown = (
        await ds.query(
          `SELECT "cooldownUntil" FROM ${schema}.alert_rules WHERE id = $1`,
          [rule.id],
        )
      )[0].cooldownUntil as Date;
      expect(firingRule?.cooldownUntil).toBe(storedCooldown.toISOString());
      expect(storedCooldown.getTime()).toBeGreaterThan(Date.now());
      await evaluateDue();
      expect(
        (await alerts.history(tenant)).filter(
          (event) => event.ruleId === rule.id,
        ),
      ).toHaveLength(1);
      await ds.query(`TRUNCATE ${schema}.metrics_snapshots`);
      await evaluateDue();
      expect(
        (await alerts.configuration(tenant)).rules.find(
          (row) => row.id === rule.id,
        )?.evaluation?.state,
      ).toBe('no_data');
      expect(
        (await alerts.history(tenant)).filter(
          (event) => event.ruleId === rule.id,
        ),
      ).toHaveLength(1);
      await metrics(0);
      await evaluateDue();
      history = (await alerts.history(tenant)).filter(
        (event) => event.ruleId === rule.id,
      );
      expect(history.map((event) => event.state)).toEqual([
        'resolved',
        'firing',
      ]);
      await metrics(5);
      await evaluateDue();
      expect(
        (await alerts.history(tenant)).filter(
          (event) => event.ruleId === rule.id,
        ),
      ).toHaveLength(2);
      await ds.query(
        `UPDATE ${schema}.alert_rules SET "cooldownUntil" = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [rule.id],
      );
      await evaluateDue();
      expect(
        (await alerts.history(tenant)).filter(
          (event) => event.ruleId === rule.id,
        ),
      ).toHaveLength(3);
      await ds.query(
        `UPDATE public.alert_rule_schedule SET "dueAt" = NOW() WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      );
      const [obsolete] = await workers[0].claimDue();
      await alerts.updateRule(tenant, rule.id, {
        ...input,
        enabled: false,
        revision: 1,
      });
      expect(await workers[0].evaluateLease(obsolete)).toBe(false);
      expect(await workers[0].claimDue()).toEqual([]);
      expect(
        await ds.query(
          `SELECT * FROM public.alert_delivery_schedule WHERE "tenantId" = $1`,
          [tenant],
        ),
      ).toEqual([]);
      const enabled = await alerts.updateRule(tenant, rule.id, {
        ...input,
        enabled: true,
        revision: 2,
      });
      const [expired] = await workers[0].claimDue();
      await ds.query(
        `UPDATE public.alert_rule_schedule SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenant, rule.id],
      );
      const [replacement] = await workers[1].claimDue();
      expect(replacement.leaseToken).not.toBe(expired.leaseToken);
      expect(await workers[0].evaluateLease(expired)).toBe(false);
      expect(await workers[1].evaluateLease(replacement)).toBe(true);
      await alerts.removeRule(tenant, rule.id, enabled.revision);
    } finally {
      await ds.query(
        `DROP TRIGGER IF EXISTS alert_due_failure_fixture ON public.alert_delivery_schedule`,
      );
      await ds.query(
        `DROP FUNCTION IF EXISTS public.alert_due_failure_fixture()`,
      );
      await Promise.all(workers.map((worker) => worker.onModuleDestroy()));
      const [current] = await ds.query(
        `SELECT revision FROM ${schema}.alert_rules WHERE id = $1`,
        [rule.id],
      );
      if (current) await alerts.removeRule(tenant, rule.id, current.revision);
      await alerts.removeChannel(tenant, channel.id, 1);
      await ds.query(
        `DELETE FROM ${schema}.alert_events WHERE "ruleName" = 'Evaluator fixture'`,
      );
      await alerts.onModuleDestroy();
    }
  });
  it('cleans expired and excess idle alert events with their durable delivery work', async () => {
    const alerts = new AlertRulesService(ds, new ConfigService());
    const evaluator = new AlertEvaluatorService(ds, alerts);
    const other = randomUUID();
    await ds.query(
      `INSERT INTO public.tenants (id, name, email, "planId") VALUES ($1, 'Idle alert fixture', $2, 'free')`,
      [other, `${other}@example.test`],
    );
    await new TenantProvisioningService(ds).provisionTenant(other);
    const idleSchema = tenantSchema(other);
    try {
      await ds.query(`INSERT INTO ${idleSchema}.alert_events ("ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt")
        SELECT 'Idle fixture', 'rps', '<', 1, 1, 'firing', 0.5, NOW() - make_interval(secs => i) FROM generate_series(1, 1002) i`);
      const [expired] =
        await ds.query(`INSERT INTO ${idleSchema}.alert_events ("ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt")
        VALUES ('Expired idle fixture', 'rps', '<', 1, 1, 'firing', 0.5, NOW() - INTERVAL '31 days') RETURNING id`);
      const [delivery] = await ds.query(
        `INSERT INTO ${idleSchema}.alert_deliveries ("eventId", "channelName", type, "channelRevision")
        VALUES ($1, 'Deleted fixture channel', 'email', 1) RETURNING id`,
        [expired.id],
      );
      await ds.query(
        `INSERT INTO public.alert_delivery_schedule ("tenantId", "deliveryId") VALUES ($1, $2)`,
        [other, delivery.id],
      );
      await evaluator.cleanupExpired();
      expect(
        (
          await ds.query(
            `SELECT COUNT(*)::int AS count FROM ${idleSchema}.alert_events`,
          )
        )[0].count,
      ).toBe(1000);
      expect(
        await ds.query(
          `SELECT id FROM ${idleSchema}.alert_events WHERE id = $1`,
          [expired.id],
        ),
      ).toEqual([]);
      expect(
        await ds.query(
          `SELECT id FROM ${idleSchema}.alert_deliveries WHERE id = $1`,
          [delivery.id],
        ),
      ).toEqual([]);
      expect(
        await ds.query(
          `SELECT * FROM public.alert_delivery_schedule WHERE "tenantId" = $1`,
          [other],
        ),
      ).toEqual([]);
    } finally {
      await evaluator.onModuleDestroy();
      await alerts.onModuleDestroy();
      await ds.query(`DROP SCHEMA ${idleSchema} CASCADE`);
      await ds.query(`DELETE FROM public.api_keys WHERE "tenantId" = $1`, [
        other,
      ]);
      await ds.query(`DELETE FROM public.tenants WHERE id = $1`, [other]);
    }
  });
  it('retains all legacy protections alongside configured plugins', async () => {
    const [row] = await ds.query(
      `SELECT plugins FROM ${schema}.routes WHERE id = $1`,
      [legacy],
    );
    expect(row.plugins).toEqual([
      { name: 'request-transform', config: {} },
      { name: 'request-size-limit', config: { maxBodyBytes: 1024 } },
      { name: 'cors', config: { origins: ['https://app.example.test'] } },
      { name: 'ip-restriction', config: { deny: ['203.0.113.0/24'] } },
    ]);
  });
  it('preserves explicit policies and remains idempotent after restart', async () => {
    await new MigrationService(ds).onModuleInit();
    const [row] = await ds.query(
      `SELECT plugins FROM ${schema}.routes WHERE id = $1`,
      [explicit],
    );
    expect(row.plugins).toEqual([
      { name: 'request-size-limit', config: { maxBodyBytes: 99 } },
    ]);
    const columns = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='routes'`,
      [schema],
    );
    expect(
      columns.map((c: { column_name: string }) => c.column_name),
    ).not.toEqual(
      expect.arrayContaining(['maxBodyBytes', 'cors', 'ipRestriction']),
    );
  });
  it('round trips route updates as an object and differentiates omitted policies from null', async () => {
    const controller = new RoutesController(ds, push);
    const policy = { attempts: 2, on: [502], methods: ['GET'] };
    const updated = await controller.update(tenant, legacy, {
      method: 'GET',
      retry: policy,
      rateLimitOverride: 5,
      graphql: { maxDepth: 3 },
    });
    expect(updated).toMatchObject({
      id: legacy,
      method: 'GET',
      retry: policy,
      rateLimitOverride: 5,
      graphql: { maxDepth: 3 },
    });
    const omitted = await controller.update(tenant, legacy, { enabled: false });
    expect(omitted).toMatchObject({
      enabled: false,
      retry: policy,
      rateLimitOverride: 5,
    });
    const cleared = await controller.update(tenant, legacy, {
      retry: null,
      rateLimitOverride: null,
      graphql: null,
      plugins: null,
    });
    expect(cleared).toMatchObject({
      retry: null,
      rateLimitOverride: null,
      graphql: null,
      plugins: null,
    });
    expect(publish).toHaveBeenCalledTimes(3);
  });
  it('round trips service flags including false without returning a driver tuple', async () => {
    const controller = new ServicesController(ds, push);
    expect(
      await controller.update(tenant, service, { name: 'renamed', h2: true }),
    ).toMatchObject({ id: service, name: 'renamed', h2: true });
    expect(
      await controller.update(tenant, service, { h2: false }),
    ).toMatchObject({ id: service, h2: false });
  });
  it('migrates health defaults and preserves omitted settings across updates', async () => {
    const controller = new ServicesController(ds, push);
    expect(await controller.update(tenant, service, {})).toMatchObject({
      healthCheckIntervalMs: 10000,
      unhealthyFallback: false,
    });
    expect(
      await controller.update(tenant, service, {
        healthCheckIntervalMs: 1500,
        unhealthyFallback: true,
      }),
    ).toMatchObject({ healthCheckIntervalMs: 1500, unhealthyFallback: true });
    expect(
      await controller.update(tenant, service, { name: 'preserved' }),
    ).toMatchObject({ healthCheckIntervalMs: 1500, unhealthyFallback: true });
    expect(
      await controller.update(tenant, service, { unhealthyFallback: false }),
    ).toMatchObject({ healthCheckIntervalMs: 1500, unhealthyFallback: false });
    expect(
      await controller.create(tenant, {
        name: 'fresh',
        targets: [{ url: 'http://fresh:8080', weight: 1 }],
      }),
    ).toMatchObject({ healthCheckIntervalMs: 10000, unhealthyFallback: false });
  });
  it('migrates and round trips native health settings and protocol flags', async () => {
    const controller = new ServicesController(ds, push);
    expect(await controller.update(tenant, service, {})).toMatchObject({
      healthCheckProtocol: 'http',
      healthCheckService: '',
    });
    expect(
      await controller.update(tenant, service, {
        healthCheckProtocol: 'grpc',
        healthCheckService: 'test.Echo',
        h2: true,
        supportsWebSocket: true,
      }),
    ).toMatchObject({
      healthCheckProtocol: 'grpc',
      healthCheckService: 'test.Echo',
      h2: true,
      supportsWebSocket: true,
    });
    expect(
      await controller.update(tenant, service, { name: 'preserved-protocol' }),
    ).toMatchObject({
      healthCheckProtocol: 'grpc',
      healthCheckService: 'test.Echo',
      h2: true,
    });
    expect(
      await controller.update(tenant, service, {
        healthCheckService: '',
        supportsWebSocket: false,
      }),
    ).toMatchObject({ healthCheckService: '', supportsWebSocket: false });
  });
  it('migrates and preserves a service balancing policy through partial updates', async () => {
    const controller = new ServicesController(ds, push);
    expect(await controller.update(tenant, service, {})).toMatchObject({
      loadBalancing: 'weighted-round-robin',
    });
    expect(
      await controller.update(tenant, service, {
        loadBalancing: 'least-connections',
      }),
    ).toMatchObject({ loadBalancing: 'least-connections' });
    expect(
      await controller.update(tenant, service, { timeoutMs: 2500 }),
    ).toMatchObject({ loadBalancing: 'least-connections', timeoutMs: 2500 });
    expect(
      await controller.update(tenant, service, {
        loadBalancing: 'weighted-round-robin',
      }),
    ).toMatchObject({ loadBalancing: 'weighted-round-robin' });
    expect(
      await controller.create(tenant, {
        name: 'least-busy',
        targets: [{ url: 'http://least:8080', weight: 1 }],
        loadBalancing: 'least-connections',
      }),
    ).toMatchObject({ loadBalancing: 'least-connections' });
  });
  it('keeps consumer groups when omitted and returns the updated consumer without its key hash', async () => {
    const controller = new ConsumersController(ds, push);
    const consumer = await controller.create(tenant, {
      name: 'app',
      groups: ['admins'],
    });
    const omitted = await controller.update(tenant, consumer.id, {});
    expect(omitted).toMatchObject({ id: consumer.id, groups: ['admins'] });
    expect(omitted).not.toHaveProperty('keyHash');
    expect(
      await controller.update(tenant, consumer.id, { groups: [] }),
    ).toMatchObject({ groups: [] });
  });
  it('returns not found without publishing a nonexistent configuration update', async () => {
    await expect(
      new RoutesController(ds, push).update(tenant, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new ServicesController(ds, push).update(tenant, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new ConsumersController(ds, push).update(tenant, randomUUID(), {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(publish).not.toHaveBeenCalled();
  });
  it('rolls back a failed migration without removing original policies', async () => {
    await ds.query(
      `ALTER TABLE ${schema}.routes ADD COLUMN "maxBodyBytes" INTEGER, ADD COLUMN cors JSONB`,
    );
    await ds.query(
      `UPDATE ${schema}.routes SET "maxBodyBytes"=7, cors='{}', plugins='[]' WHERE id=$1`,
      [legacy],
    );
    await ds.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", cors, plugins) VALUES ('GET', '/malformed', $1, '{}', '{}')`,
      [service],
    );
    await expect(new MigrationService(ds).onModuleInit()).rejects.toThrow();
    const [row] = await ds.query(
      `SELECT "maxBodyBytes", cors, plugins FROM ${schema}.routes WHERE id=$1`,
      [legacy],
    );
    expect(row).toEqual({ maxBodyBytes: 7, cors: {}, plugins: [] });
  });
});
