import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { AlertRulesService } from './alert-rules.service';
import {
  aggregateAlertWindow,
  MAX_ALERT_WINDOW_SAMPLES,
  type AlertMetricSample,
} from './alert-aggregation';
import { tenantSchema } from '../tenants/tenant-schema';
import type {
  AlertRuleConfig,
  AlertChannelType,
} from '@api-gateway/shared-types';

export const ALERT_EVALUATION_INTERVAL_MS = 15000;
export const ALERT_FIRING_COOLDOWN_MS = 300000;
export const ALERT_EVALUATION_LEASE_MS = 30000;
export interface AlertEvaluationLease {
  tenantId: string;
  ruleId: string;
  leaseToken: string;
}
interface StoredRule extends Omit<AlertRuleConfig, 'channelIds'> {
  id: string;
  revision: number;
  notifiedState: 'ok' | 'firing';
  cooldownUntil: Date | null;
}

@Injectable()
export class AlertEvaluatorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AlertEvaluatorService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private retentionCursor: string | null = null;
  private nextRetentionAt = performance.now() + 60000;
  private retentionRunning?: Promise<void>;
  constructor(
    private readonly dataSource: DataSource,
    private readonly rules: AlertRulesService,
  ) {}
  onApplicationBootstrap(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      if (this.running || this.stopping) return;
      void this.tick().catch(() =>
        this.logger.warn('Alert evaluation tick failed.'),
      );
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(
      [this.running, this.retentionRunning].filter(
        (task): task is Promise<void> => !!task,
      ),
    );
  }
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.running) return this.running;
    const work = this.runBatch();
    this.running = work;
    try {
      await work;
    } finally {
      if (this.running === work) this.running = undefined;
    }
  }
  async claimDue(): Promise<AlertEvaluationLease[]> {
    if (this.stopping) return [];
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
      );
      return manager.query<AlertEvaluationLease[]>(
        `WITH due AS (
        SELECT "tenantId", "ruleId" FROM public.alert_rule_schedule
        WHERE "dueAt" <= clock_timestamp() AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp())
        ORDER BY "dueAt", "tenantId", "ruleId" LIMIT 16 FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE public.alert_rule_schedule q SET "leaseToken" = gen_random_uuid(),
          "leaseUntil" = clock_timestamp() + make_interval(secs => $1)
        FROM due WHERE q."tenantId" = due."tenantId" AND q."ruleId" = due."ruleId"
        RETURNING q."tenantId", q."ruleId", q."leaseToken"
      ) SELECT * FROM claimed`,
        [ALERT_EVALUATION_LEASE_MS / 1000],
      );
    });
  }
  private async runBatch(): Promise<void> {
    const leases = await this.claimDue();
    for (let i = 0; i < leases.length && !this.stopping; i += 4) {
      const results = await Promise.allSettled(
        leases.slice(i, i + 4).map((lease) => this.evaluateLease(lease)),
      );
      for (const result of results)
        if (result.status === 'rejected')
          this.logger.warn(
            'An alert evaluation failed; its lease will expire for retry.',
          );
    }
    if (!this.stopping && performance.now() >= this.nextRetentionAt) {
      this.nextRetentionAt = performance.now() + 60000;
      await this.cleanupExpired();
    }
  }
  async cleanupExpired(): Promise<void> {
    if (this.stopping) return;
    if (this.retentionRunning) return this.retentionRunning;
    const work = this.cleanupPage();
    this.retentionRunning = work;
    try {
      await work;
    } finally {
      if (this.retentionRunning === work) this.retentionRunning = undefined;
    }
  }
  private async cleanupPage(): Promise<void> {
    const tenants = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
      );
      return manager.query<Array<{ id: string }>>(
        `SELECT id FROM public.tenants WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 64`,
        [this.retentionCursor],
      );
    });
    for (const tenant of tenants) {
      if (this.stopping) break;
      const schema = tenantSchema(tenant.id);
      try {
        await this.rules.withTenantTransaction(tenant.id, (manager) =>
          this.pruneTenant(manager, schema, tenant.id),
        );
      } catch {
        this.logger.warn(
          'Alert retention failed for a tenant; continuing the bounded sweep.',
        );
      }
      this.retentionCursor = tenant.id;
    }
    if (tenants.length < 64) this.retentionCursor = null;
  }
  async evaluateLease(lease: AlertEvaluationLease): Promise<boolean> {
    // Validate identifiers even for internal due-queue work before SQL interpolation.
    tenantSchema(lease.tenantId);
    for (const id of [lease.ruleId, lease.leaseToken])
      if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
        throw new Error('Invalid alert evaluation lease.');
    if (this.stopping) return false;
    return this.rules.withTenantTransaction(
      lease.tenantId,
      async (manager, schema) => {
        const [claim] = await manager.query<Array<{ leaseToken: string }>>(
          `SELECT "leaseToken" FROM public.alert_rule_schedule
        WHERE "tenantId" = $1 AND "ruleId" = $2 AND "leaseToken" = $3 AND "leaseUntil" > clock_timestamp() FOR UPDATE`,
          [lease.tenantId.toLowerCase(), lease.ruleId, lease.leaseToken],
        );
        if (!claim) return false;
        const [rule] = await manager.query<StoredRule[]>(
          `SELECT id, name, metric, operator, threshold, "windowMinutes", "minRequests", enabled,
        revision, "notifiedState", "cooldownUntil" FROM ${schema}.alert_rules WHERE id = $1 FOR UPDATE`,
          [lease.ruleId],
        );
        if (!rule?.enabled) {
          await manager.query(
            `DELETE FROM public.alert_rule_schedule WHERE "tenantId" = $1 AND "ruleId" = $2 AND "leaseToken" = $3`,
            [lease.tenantId.toLowerCase(), lease.ruleId, lease.leaseToken],
          );
          return false;
        }
        const [{ now }] = await manager.query<Array<{ now: Date }>>(
          `SELECT clock_timestamp() AS now`,
        );
        const samples = await manager.query<AlertMetricSample[]>(
          `SELECT timestamp, "aggregateWindow" FROM ${schema}.metrics_snapshots
        WHERE timestamp > $1::timestamptz - make_interval(mins => $2) AND timestamp <= $1::timestamptz
        ORDER BY timestamp DESC LIMIT $3`,
          [now, rule.windowMinutes, MAX_ALERT_WINDOW_SAMPLES + 1],
        );
        const evaluation = aggregateAlertWindow(
          { ...rule, channelIds: [] },
          samples,
          now,
        );
        const firing =
          evaluation.state === 'firing' &&
          (!rule.cooldownUntil ||
            rule.cooldownUntil.getTime() <= now.getTime());
        const resolved =
          evaluation.state === 'ok' && rule.notifiedState === 'firing';
        if (firing || resolved) {
          const [{ id: eventId }] = await manager.query<Array<{ id: string }>>(
            `INSERT INTO ${schema}.alert_events
          ("ruleId", "ruleName", metric, operator, threshold, "windowMinutes", state, value, "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              rule.id,
              rule.name,
              rule.metric,
              rule.operator,
              rule.threshold,
              rule.windowMinutes,
              firing ? 'firing' : 'resolved',
              evaluation.value,
              now,
            ],
          );
          const channels = await manager.query<
            Array<{
              id: string;
              name: string;
              type: AlertChannelType;
              revision: number;
            }>
          >(
            `SELECT c.id, c.name, c.type, c.revision
          FROM ${schema}.alert_channels c JOIN ${schema}.alert_rule_channels rc ON rc."channelId" = c.id
          WHERE rc."ruleId" = $1 AND c.enabled = true ORDER BY c.id LIMIT 5`,
            [rule.id],
          );
          for (const channel of channels) {
            const [{ id: deliveryId }] = await manager.query<
              Array<{ id: string }>
            >(
              `INSERT INTO ${schema}.alert_deliveries
            ("eventId", "channelId", "channelName", type, "channelRevision", "nextAttemptAt") VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [
                eventId,
                channel.id,
                channel.name,
                channel.type,
                channel.revision,
                now,
              ],
            );
            await manager.query(
              `INSERT INTO public.alert_delivery_schedule ("tenantId", "deliveryId", "dueAt") VALUES ($1, $2, $3)`,
              [lease.tenantId.toLowerCase(), deliveryId, now],
            );
          }
        }
        await manager.query(
          `UPDATE ${schema}.alert_rules SET evaluation = $2::jsonb,
        "notifiedState" = CASE WHEN $3 THEN 'firing' WHEN $4 THEN 'ok' ELSE "notifiedState" END,
        "cooldownUntil" = CASE WHEN $3 THEN $5::timestamptz + make_interval(secs => $6) ELSE "cooldownUntil" END WHERE id = $1`,
          [
            rule.id,
            JSON.stringify(evaluation),
            firing,
            resolved,
            now,
            ALERT_FIRING_COOLDOWN_MS / 1000,
          ],
        );
        await this.pruneTenant(manager, schema, lease.tenantId);
        await manager.query(
          `UPDATE public.alert_rule_schedule SET "dueAt" = $4::timestamptz + make_interval(secs => $5), "leaseToken" = NULL, "leaseUntil" = NULL
        WHERE "tenantId" = $1 AND "ruleId" = $2 AND "leaseToken" = $3`,
          [
            lease.tenantId.toLowerCase(),
            lease.ruleId,
            lease.leaseToken,
            now,
            ALERT_EVALUATION_INTERVAL_MS / 1000,
          ],
        );
        return true;
      },
    );
  }
  async pruneTenant(
    manager: EntityManager,
    schema: string,
    tenantId: string,
  ): Promise<void> {
    if (schema !== tenantSchema(tenantId))
      throw new Error('Invalid alert retention tenant.');
    const expired = `e."createdAt" < clock_timestamp() - INTERVAL '720 hours' OR e.id IN
      (SELECT id FROM ${schema}.alert_events ORDER BY "createdAt" DESC, id DESC OFFSET 1000)`;
    await manager.query(
      `DELETE FROM public.alert_delivery_schedule q USING ${schema}.alert_deliveries d, ${schema}.alert_events e
      WHERE q."tenantId" = $1 AND q."deliveryId" = d.id AND d."eventId" = e.id AND (${expired})`,
      [tenantId.toLowerCase()],
    );
    await manager.query(
      `DELETE FROM ${schema}.alert_events e WHERE ${expired}`,
    );
  }
}
