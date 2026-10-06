import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  ALERT_METRICS,
  ALERT_OPERATORS,
  MAX_ALERT_MIN_REQUESTS,
  MAX_ALERT_CHANNELS_PER_TENANT,
  MAX_ALERT_RULES_PER_TENANT,
  type AlertRule,
  type AlertConfiguration,
  type AlertEvent,
  type AlertDelivery,
  type AlertChannel,
  MAX_ALERT_NAME_LENGTH,
  MAX_ALERT_WINDOW_MINUTES,
  MAX_CHANNELS_PER_ALERT_RULE,
  MAX_METRIC_LATENCY_MS,
  MAX_METRIC_RATE,
  type AlertMetric,
  type AlertOperator,
  type AlertRuleConfig,
} from '@api-gateway/shared-types';

import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { tenantSchema } from '../tenants/tenant-schema';
import { AlertCredentialCipher } from './alert-credentials';
import { alertTrustedOrigins } from './alert-egress-policy';
import {
  alertChannelEnabled,
  alertChannelName,
  normalizeAlertChannel,
  normalizeAlertCredentials,
} from './alert-channel-input';

type StoredChannel = Omit<AlertChannel, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};
const CHANNEL_COLUMNS = `id, name, type, destination, (type <> 'email') AS "hasSecret", enabled, revision, "createdAt", "updatedAt"`;

type StoredRule = Omit<
  AlertRule,
  'createdAt' | 'updatedAt' | 'cooldownUntil'
> & {
  createdAt: Date;
  updatedAt: Date;
  cooldownUntil: Date | null;
};
const RULE_COLUMNS = `r.id, r.name, r.metric, r.operator, r.threshold, r."windowMinutes", r."minRequests",
  r.enabled, r.revision, r.evaluation, r."notifiedState", r."cooldownUntil", r."createdAt", r."updatedAt"`;

@Injectable()
export class AlertRulesService implements OnModuleDestroy {
  readonly credentialCipher: AlertCredentialCipher;
  private readonly trustedOrigins: ReadonlySet<string>;
  private readonly emailAvailable: boolean;
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.credentialCipher = new AlertCredentialCipher({
      ALERT_CHANNEL_KEYS: config.get('ALERT_CHANNEL_KEYS'),
      ALERT_CHANNEL_ACTIVE_KEY: config.get('ALERT_CHANNEL_ACTIVE_KEY'),
    });
    this.trustedOrigins = alertTrustedOrigins(
      config.get('ALERT_HTTP_TRUSTED_ORIGINS'),
    );
    const mailKey = config.get<unknown>('SMTP_API_KEY');
    this.emailAvailable = typeof mailKey === 'string' && mailKey.length > 0;
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
  }
  async withTenantTransaction<T>(
    tenantId: string,
    fn: (manager: EntityManager, schema: string) => Promise<T>,
  ): Promise<T> {
    const schema = tenantSchema(tenantId);
    if (this.stopping || this.pending.size >= 32)
      throw new ServiceUnavailableException(
        'Alert storage is busy. Try again shortly.',
      );
    const pending = Promise.resolve().then(() =>
      this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
        );
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`alert-tenant:${tenantId.toLowerCase()}`],
        );
        return fn(manager, schema);
      }),
    );
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }
  private id(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
    )
      throw new BadRequestException('Choose a valid alert entry.');
    return value.toLowerCase();
  }
  private revision(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value >= 2147483647
    )
      throw new BadRequestException('Provide the current alert revision.');
    return value;
  }
  private channelDto(row: StoredChannel): AlertChannel {
    return {
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
  async listChannels(tenantId: string): Promise<AlertChannel[]> {
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const rows = await manager.query<StoredChannel[]>(
        `SELECT ${CHANNEL_COLUMNS} FROM ${schema}.alert_channels ORDER BY "createdAt", id LIMIT 16`,
      );
      return rows.map((row) => this.channelDto(row));
    });
  }
  async createChannel(tenantId: string, input: unknown): Promise<AlertChannel> {
    tenantSchema(tenantId);
    const channel = normalizeAlertChannel(input, this.trustedOrigins);
    const id = randomUUID();
    const encrypted = this.credentialCipher.encrypt(
      tenantId,
      id,
      channel.credentials,
    );
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const [{ count }] = await manager.query<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM ${schema}.alert_channels`,
      );
      if (count >= MAX_ALERT_CHANNELS_PER_TENANT)
        throw new ConflictException(
          'This workspace has reached its channel limit.',
        );
      const [row] = await manager.query<StoredChannel[]>(
        `INSERT INTO ${schema}.alert_channels (id, name, type, destination, credentials, enabled)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${CHANNEL_COLUMNS}`,
        [
          id,
          channel.name,
          channel.type,
          channel.destination,
          JSON.stringify(encrypted),
          channel.enabled,
        ],
      );
      return this.channelDto(row);
    });
  }
  private async cancelChannelWork(
    manager: EntityManager,
    schema: string,
    tenantId: string,
    channelId: string,
  ): Promise<void> {
    await manager.query(
      `DELETE FROM public.alert_delivery_schedule q USING ${schema}.alert_deliveries d
      WHERE q."tenantId" = $1 AND q."deliveryId" = d.id AND d."channelId" = $2 AND d.status IN ('queued', 'processing')`,
      [tenantId.toLowerCase(), channelId],
    );
    await manager.query(
      `UPDATE ${schema}.alert_deliveries SET status = 'cancelled', "nextAttemptAt" = NULL,
      "completedAt" = NOW(), "lastError" = 'Channel configuration changed.'
      WHERE "channelId" = $1 AND status IN ('queued', 'processing')`,
      [channelId],
    );
  }
  async updateChannel(
    tenantId: string,
    channelId: string,
    input: unknown,
  ): Promise<AlertChannel> {
    const id = this.id(channelId);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Provide a channel update.');
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !['name', 'enabled', 'revision', 'credentials'].includes(key),
      )
    )
      throw new BadRequestException(
        'Channel updates contain an unsupported field.',
      );
    const name = alertChannelName(value.name);
    if (value.enabled === undefined)
      throw new BadRequestException('Provide a channel enabled state.');
    const enabled = alertChannelEnabled(value.enabled);
    const revision = this.revision(value.revision);
    const replacement = Object.hasOwn(value, 'credentials')
      ? normalizeAlertCredentials(value.credentials, this.trustedOrigins)
      : undefined;
    const encrypted = replacement
      ? this.credentialCipher.encrypt(tenantId, id, replacement.credentials)
      : undefined;
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const [current] = await manager.query<
        Array<{ revision: number; type: string }>
      >(
        `SELECT revision, type FROM ${schema}.alert_channels WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current) throw new NotFoundException('Channel not found.');
      if (current.revision !== revision)
        throw new ConflictException(
          'This channel changed. Refresh before editing it.',
        );
      if (replacement && replacement.type !== current.type)
        throw new BadRequestException(
          'Create a new channel to use a different channel type.',
        );
      await this.cancelChannelWork(manager, schema, tenantId, id);
      const [row] = await manager.query<StoredChannel[]>(
        `WITH updated AS (UPDATE ${schema}.alert_channels SET name = $2, enabled = $3,
        destination = CASE WHEN $4 THEN $5 ELSE destination END,
        credentials = CASE WHEN $4 THEN $6::jsonb ELSE credentials END,
        revision = revision + 1, "updatedAt" = NOW() WHERE id = $1 RETURNING ${CHANNEL_COLUMNS}) SELECT * FROM updated`,
        [
          id,
          name,
          enabled,
          !!replacement,
          replacement?.destination ?? null,
          encrypted ? JSON.stringify(encrypted) : null,
        ],
      );
      return this.channelDto(row);
    });
  }
  async removeChannel(
    tenantId: string,
    channelId: string,
    expectedRevision: unknown,
  ): Promise<{ success: true }> {
    const id = this.id(channelId);
    const revision = this.revision(expectedRevision);
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const [current] = await manager.query<Array<{ revision: number }>>(
        `SELECT revision FROM ${schema}.alert_channels WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current) throw new NotFoundException('Channel not found.');
      if (current.revision !== revision)
        throw new ConflictException(
          'This channel changed. Refresh before deleting it.',
        );
      await this.cancelChannelWork(manager, schema, tenantId, id);
      await manager.query(
        `UPDATE ${schema}.alert_rules SET revision = revision + 1, "updatedAt" = NOW()
        WHERE id IN (SELECT "ruleId" FROM ${schema}.alert_rule_channels WHERE "channelId" = $1)`,
        [id],
      );
      await manager.query(
        `DELETE FROM ${schema}.alert_channels WHERE id = $1`,
        [id],
      );
      return { success: true };
    });
  }

  private ruleSelect(schema: string): string {
    return `SELECT ${RULE_COLUMNS}, ARRAY(SELECT c."channelId" FROM ${schema}.alert_rule_channels c
      WHERE c."ruleId" = r.id ORDER BY c."channelId" LIMIT 5) AS "channelIds" FROM ${schema}.alert_rules r`;
  }
  private ruleDto(row: StoredRule): AlertRule {
    return {
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      cooldownUntil: row.cooldownUntil
        ? new Date(row.cooldownUntil).toISOString()
        : null,
    };
  }
  private async readRule(
    manager: EntityManager,
    schema: string,
    id: string,
  ): Promise<AlertRule> {
    const [row] = await manager.query<StoredRule[]>(
      `${this.ruleSelect(schema)} WHERE r.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Alert rule not found.');
    return this.ruleDto(row);
  }
  async configuration(tenantId: string): Promise<AlertConfiguration> {
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const rules = await manager.query<StoredRule[]>(
        `${this.ruleSelect(schema)} ORDER BY r."createdAt", r.id LIMIT 100`,
      );
      const channels = await manager.query<StoredChannel[]>(
        `SELECT ${CHANNEL_COLUMNS} FROM ${schema}.alert_channels ORDER BY "createdAt", id LIMIT 16`,
      );
      return {
        rules: rules.map((row) => this.ruleDto(row)),
        channels: channels.map((row) => this.channelDto(row)),
        deliveryEnabled: this.credentialCipher.enabled,
        deliveryAvailability: {
          webhook: this.credentialCipher.enabled,
          slack: this.credentialCipher.enabled,
          email: this.credentialCipher.enabled && this.emailAvailable,
        },
      };
    });
  }
  private async ruleChannels(
    manager: EntityManager,
    schema: string,
    id: string,
    channels: string[],
  ): Promise<void> {
    if (channels.length) {
      const rows = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM ${schema}.alert_channels WHERE id = ANY($1::uuid[])`,
        [channels],
      );
      if (rows.length !== channels.length)
        throw new BadRequestException(
          'Choose delivery channels from this workspace.',
        );
    }
    await manager.query(
      `DELETE FROM ${schema}.alert_rule_channels WHERE "ruleId" = $1`,
      [id],
    );
    if (channels.length)
      await manager.query(
        `INSERT INTO ${schema}.alert_rule_channels ("ruleId", "channelId") SELECT $1::uuid, unnest($2::uuid[])`,
        [id, channels],
      );
  }
  private async scheduleRule(
    manager: EntityManager,
    tenantId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<void> {
    if (enabled) {
      await manager.query(
        `INSERT INTO public.alert_rule_schedule ("tenantId", "ruleId", "dueAt") VALUES ($1, $2, NOW())
        ON CONFLICT ("tenantId", "ruleId") DO UPDATE SET "dueAt" = NOW(), "leaseToken" = NULL, "leaseUntil" = NULL`,
        [tenantId.toLowerCase(), ruleId],
      );
    } else {
      await manager.query(
        `DELETE FROM public.alert_rule_schedule WHERE "tenantId" = $1 AND "ruleId" = $2`,
        [tenantId.toLowerCase(), ruleId],
      );
    }
  }
  private async cancelRuleWork(
    manager: EntityManager,
    schema: string,
    tenantId: string,
    id: string,
  ): Promise<void> {
    await manager.query(
      `DELETE FROM public.alert_delivery_schedule q USING ${schema}.alert_deliveries d, ${schema}.alert_events e
      WHERE q."tenantId" = $1 AND q."deliveryId" = d.id AND d."eventId" = e.id AND e."ruleId" = $2 AND d.status IN ('queued', 'processing')`,
      [tenantId.toLowerCase(), id],
    );
    await manager.query(
      `UPDATE ${schema}.alert_deliveries d SET status = 'cancelled', "nextAttemptAt" = NULL,
      "completedAt" = NOW(), "lastError" = 'Alert rule configuration changed.' FROM ${schema}.alert_events e
      WHERE d."eventId" = e.id AND e."ruleId" = $1 AND d.status IN ('queued', 'processing')`,
      [id],
    );
  }
  async createRule(tenantId: string, input: unknown): Promise<AlertRule> {
    const rule = this.normalizeRule(input);
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const [{ count }] = await manager.query<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM ${schema}.alert_rules`,
      );
      if (count >= MAX_ALERT_RULES_PER_TENANT)
        throw new ConflictException(
          'This workspace has reached its alert rule limit.',
        );
      const [{ id }] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO ${schema}.alert_rules
        (name, metric, operator, threshold, "windowMinutes", "minRequests", enabled) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          rule.name,
          rule.metric,
          rule.operator,
          rule.threshold,
          rule.windowMinutes,
          rule.minRequests,
          rule.enabled,
        ],
      );
      await this.ruleChannels(manager, schema, id, rule.channelIds);
      await this.scheduleRule(manager, tenantId, id, rule.enabled);
      return this.readRule(manager, schema, id);
    });
  }
  async updateRule(
    tenantId: string,
    ruleId: string,
    input: unknown,
  ): Promise<AlertRule> {
    const id = this.id(ruleId);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Provide an alert rule update.');
    const { revision: expected, ...configuration } = input as Record<
      string,
      unknown
    >;
    const revision = this.revision(expected);
    const rule = this.normalizeRule(configuration);
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const [current] = await manager.query<Array<{ revision: number }>>(
        `SELECT revision FROM ${schema}.alert_rules WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current) throw new NotFoundException('Alert rule not found.');
      if (current.revision !== revision)
        throw new ConflictException(
          'This rule changed. Refresh before editing it.',
        );
      await this.ruleChannels(manager, schema, id, rule.channelIds);
      await this.cancelRuleWork(manager, schema, tenantId, id);
      await manager.query(
        `UPDATE ${schema}.alert_rules SET name = $2, metric = $3, operator = $4, threshold = $5,
        "windowMinutes" = $6, "minRequests" = $7, enabled = $8, revision = revision + 1,
        evaluation = NULL, "notifiedState" = 'ok', "cooldownUntil" = NULL, "updatedAt" = NOW() WHERE id = $1`,
        [
          id,
          rule.name,
          rule.metric,
          rule.operator,
          rule.threshold,
          rule.windowMinutes,
          rule.minRequests,
          rule.enabled,
        ],
      );
      await this.scheduleRule(manager, tenantId, id, rule.enabled);
      return this.readRule(manager, schema, id);
    });
  }
  async removeRule(
    tenantId: string,
    ruleId: string,
    expectedRevision: unknown,
  ): Promise<{ success: true }> {
    const id = this.id(ruleId);
    const revision = this.revision(expectedRevision);
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      const [current] = await manager.query<Array<{ revision: number }>>(
        `SELECT revision FROM ${schema}.alert_rules WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!current) throw new NotFoundException('Alert rule not found.');
      if (current.revision !== revision)
        throw new ConflictException(
          'This rule changed. Refresh before deleting it.',
        );
      await this.cancelRuleWork(manager, schema, tenantId, id);
      await this.scheduleRule(manager, tenantId, id, false);
      await manager.query(`DELETE FROM ${schema}.alert_rules WHERE id = $1`, [
        id,
      ]);
      return { success: true };
    });
  }
  async history(tenantId: string): Promise<AlertEvent[]> {
    return this.withTenantTransaction(tenantId, async (manager, schema) => {
      type StoredEvent = Omit<AlertEvent, 'createdAt' | 'deliveries'> & {
        createdAt: Date;
      };
      type StoredDelivery = Omit<
        AlertDelivery,
        'nextAttemptAt' | 'completedAt'
      > & {
        eventId: string;
        nextAttemptAt: Date | null;
        completedAt: Date | null;
      };
      const events = await manager.query<
        StoredEvent[]
      >(`SELECT id, "ruleId", "ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt"
        FROM ${schema}.alert_events WHERE "createdAt" >= NOW() - INTERVAL '30 days' ORDER BY "createdAt" DESC, id DESC LIMIT 100`);
      if (!events.length) return [];
      const deliveries = await manager.query<StoredDelivery[]>(
        `SELECT id, "eventId", "channelId", "channelName", type, status, attempts, "lastError", "nextAttemptAt", "completedAt"
        FROM ${schema}.alert_deliveries WHERE "eventId" = ANY($1::uuid[]) ORDER BY id LIMIT 500`,
        [events.map((event) => event.id)],
      );
      return events.map((event) => ({
        ...event,
        createdAt: new Date(event.createdAt).toISOString(),
        deliveries: deliveries
          .filter((delivery) => delivery.eventId === event.id)
          .map(({ eventId: _eventId, ...delivery }) => ({
            ...delivery,
            nextAttemptAt: delivery.nextAttemptAt
              ? new Date(delivery.nextAttemptAt).toISOString()
              : null,
            completedAt: delivery.completedAt
              ? new Date(delivery.completedAt).toISOString()
              : null,
          })),
      }));
    });
  }

  /** Normalize the complete rule configuration before any tenant/database work. */
  normalizeRule(input: unknown): AlertRuleConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Provide an alert rule configuration.');
    const value = input as Record<string, unknown>;
    const fields = [
      'name',
      'metric',
      'operator',
      'threshold',
      'windowMinutes',
      'minRequests',
      'channelIds',
      'enabled',
    ];
    if (Object.keys(value).some((key) => !fields.includes(key)))
      throw new BadRequestException(
        'Alert rules contain an unsupported field.',
      );
    if (typeof value.name !== 'string')
      throw new BadRequestException('Provide a name for this alert rule.');
    const name = value.name.trim();
    if (
      !name ||
      name.length > MAX_ALERT_NAME_LENGTH ||
      Array.from(name).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new BadRequestException(
        `Use an alert name of 1–${MAX_ALERT_NAME_LENGTH} characters without control characters.`,
      );
    if (
      typeof value.metric !== 'string' ||
      !ALERT_METRICS.includes(value.metric as AlertMetric)
    )
      throw new BadRequestException('Choose a supported alert metric.');
    const metric = value.metric as AlertMetric;
    if (
      typeof value.operator !== 'string' ||
      !ALERT_OPERATORS.includes(value.operator as AlertOperator)
    )
      throw new BadRequestException('Choose a supported comparison.');
    const operator = value.operator as AlertOperator;
    const threshold = value.threshold;
    const maximum =
      metric === 'rps'
        ? MAX_METRIC_RATE
        : metric === 'p95_latency_ms'
          ? MAX_METRIC_LATENCY_MS
          : 1;
    if (
      typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > maximum
    )
      throw new BadRequestException(
        `Choose a threshold between 0 and ${maximum}.`,
      );
    const windowMinutes = value.windowMinutes;
    if (
      typeof windowMinutes !== 'number' ||
      !Number.isSafeInteger(windowMinutes) ||
      windowMinutes < 1 ||
      windowMinutes > MAX_ALERT_WINDOW_MINUTES
    )
      throw new BadRequestException(
        `Choose a whole-minute window between 1 and ${MAX_ALERT_WINDOW_MINUTES}.`,
      );
    const minRequests =
      value.minRequests === undefined
        ? metric === 'rps'
          ? 0
          : 1
        : value.minRequests;
    if (
      typeof minRequests !== 'number' ||
      !Number.isSafeInteger(minRequests) ||
      minRequests < 0 ||
      minRequests > MAX_ALERT_MIN_REQUESTS
    )
      throw new BadRequestException(
        `Choose a minimum request count between 0 and ${MAX_ALERT_MIN_REQUESTS}.`,
      );
    if (
      !Array.isArray(value.channelIds) ||
      value.channelIds.length > MAX_CHANNELS_PER_ALERT_RULE
    )
      throw new BadRequestException(
        `Choose up to ${MAX_CHANNELS_PER_ALERT_RULE} delivery channels.`,
      );
    const channelIds: string[] = [];
    for (const id of value.channelIds) {
      if (
        typeof id !== 'string' ||
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)
      )
        throw new BadRequestException('Choose valid delivery channels.');
      channelIds.push(id.toLowerCase());
    }
    if (new Set(channelIds).size !== channelIds.length)
      throw new BadRequestException(
        'Each delivery channel can be selected only once.',
      );
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
      throw new BadRequestException(
        'Alert enabled state must be true or false.',
      );
    return {
      name,
      metric,
      operator,
      threshold,
      windowMinutes,
      minRequests,
      channelIds,
      enabled: value.enabled === undefined ? true : (value.enabled as boolean),
    };
  }
}
