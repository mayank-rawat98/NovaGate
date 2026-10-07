import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type {
  AlertWebhookPayload,
  AlertChannelType,
} from '@api-gateway/shared-types';
import { AlertRulesService } from './alert-rules.service';
import {
  AlertTransportService,
  ALERT_DELIVERY_DEADLINE_MS,
} from './alert-transport.service';
import { AlertTransportError } from './alert-http';
import { tenantSchema } from '../tenants/tenant-schema';

export const ALERT_DELIVERY_LEASE_MS = 30000;
export const ALERT_DELIVERY_RETRY_MS = [5000, 20000] as const;
export const ALERT_DELIVERY_CHECK_MS = 250;
export interface AlertDeliveryLease {
  tenantId: string;
  deliveryId: string;
  leaseToken: string;
}
interface DeliveryJob {
  credentials: unknown;
  payload: AlertWebhookPayload;
  attempt: number;
}
interface StoredJob extends Omit<AlertWebhookPayload['event'], 'createdAt'> {
  createdAt: Date;
  expired: boolean;
  attempts: number;
  type: AlertChannelType;
  channelType: AlertChannelType | null;
  channelEnabled: boolean | null;
  channelRevision: number;
  currentRevision: number | null;
  channelId: string | null;
  credentials: unknown;
}

@Injectable()
export class AlertDeliveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AlertDeliveryService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private readonly active = new Map<Promise<boolean>, AbortController>();
  constructor(
    private readonly dataSource: DataSource,
    private readonly rules: AlertRulesService,
    private readonly transport: AlertTransportService,
  ) {}
  onApplicationBootstrap(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      if (this.running || this.stopping) return;
      void this.tick().catch(() =>
        this.logger.warn('Alert delivery tick failed.'),
      );
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([
      ...this.active.keys(),
      ...(this.running ? [this.running] : []),
    ]);
  }
  async tick(): Promise<void> {
    if (this.stopping || !this.rules.credentialCipher.enabled) return;
    if (this.running) return this.running;
    const work = this.runBatch();
    this.running = work;
    try {
      await work;
    } finally {
      if (this.running === work) this.running = undefined;
    }
  }
  async claimDue(): Promise<AlertDeliveryLease[]> {
    if (this.stopping || !this.rules.credentialCipher.enabled) return [];
    return this.dataSource.transaction(async (manager) => {
      await this.bounds(manager);
      return manager.query<AlertDeliveryLease[]>(
        `WITH due AS (
        SELECT "tenantId", "deliveryId" FROM public.alert_delivery_schedule
        WHERE "dueAt" <= clock_timestamp() AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp())
        ORDER BY "dueAt", "tenantId", "deliveryId" LIMIT 16 FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE public.alert_delivery_schedule q SET "leaseToken" = gen_random_uuid(), "leaseStarted" = false,
          "leaseUntil" = clock_timestamp() + make_interval(secs => $1)
        FROM due WHERE q."tenantId" = due."tenantId" AND q."deliveryId" = due."deliveryId"
        RETURNING q."tenantId", q."deliveryId", q."leaseToken"
      ) SELECT * FROM claimed`,
        [ALERT_DELIVERY_LEASE_MS / 1000],
      );
    });
  }
  private bounds(manager: EntityManager): Promise<unknown> {
    return manager.query(
      `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
    );
  }
  private async runBatch(): Promise<void> {
    const leases = await this.claimDue();
    for (let i = 0; i < leases.length && !this.stopping; i += 4) {
      const results = await Promise.allSettled(
        leases.slice(i, i + 4).map((lease) => this.deliverLease(lease)),
      );
      for (const result of results)
        if (result.status === 'rejected')
          this.logger.warn(
            'Alert delivery work failed; its lease will recover after expiry.',
          );
    }
  }
  private validLease(lease: AlertDeliveryLease): void {
    tenantSchema(lease.tenantId);
    for (const value of [lease.deliveryId, lease.leaseToken])
      if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value))
        throw new Error('Invalid alert delivery lease.');
  }
  async deliverLease(lease: AlertDeliveryLease): Promise<boolean> {
    this.validLease(lease);
    if (this.stopping || this.active.size >= 4) return false;
    const controller = new AbortController();
    const work = Promise.resolve().then(() =>
      this.performDelivery(lease, controller),
    );
    this.active.set(work, controller);
    try {
      return await work;
    } finally {
      this.active.delete(work);
    }
  }
  private async removeSchedule(
    manager: EntityManager,
    lease: AlertDeliveryLease,
  ): Promise<void> {
    await manager.query(
      `DELETE FROM public.alert_delivery_schedule WHERE "tenantId"=$1 AND "deliveryId"=$2 AND "leaseToken"=$3`,
      [lease.tenantId.toLowerCase(), lease.deliveryId, lease.leaseToken],
    );
  }
  private async prepare(
    lease: AlertDeliveryLease,
  ): Promise<DeliveryJob | null> {
    return this.rules.withTenantTransaction(
      lease.tenantId,
      async (manager, schema) => {
        const [owned] = await manager.query<Array<{ leaseToken: string }>>(
          `SELECT "leaseToken" FROM public.alert_delivery_schedule
        WHERE "tenantId"=$1 AND "deliveryId"=$2 AND "leaseToken"=$3
        AND "leaseStarted" = false AND "leaseUntil" > clock_timestamp() + make_interval(secs => $4) FOR UPDATE`,
          [
            lease.tenantId.toLowerCase(),
            lease.deliveryId,
            lease.leaseToken,
            (ALERT_DELIVERY_DEADLINE_MS + 1000) / 1000,
          ],
        );
        if (!owned) return null;
        const [row] = await manager.query<StoredJob[]>(
          `SELECT e.id, e."ruleId", e."ruleName", e.metric, e.operator, e.threshold,
        (e."createdAt" < clock_timestamp() - INTERVAL '720 hours') AS expired,
        e."windowMinutes", e.state, e.value, e."createdAt", d.attempts, d.type, d."channelId", d."channelRevision",
        c.type AS "channelType", c.revision AS "currentRevision", c.enabled AS "channelEnabled", c.credentials
        FROM ${schema}.alert_deliveries d JOIN ${schema}.alert_events e ON e.id=d."eventId"
        LEFT JOIN ${schema}.alert_channels c ON c.id=d."channelId"
        WHERE d.id=$1 AND d.status IN ('queued','processing') FOR UPDATE OF d`,
          [lease.deliveryId],
        );
        if (
          !row ||
          row.expired ||
          !row.channelId ||
          !row.channelEnabled ||
          row.currentRevision !== row.channelRevision ||
          row.type !== row.channelType
        ) {
          await manager.query(
            `UPDATE ${schema}.alert_deliveries SET status='cancelled', "nextAttemptAt"=NULL,
          "completedAt"=clock_timestamp(), "lastError"='Alert configuration changed.' WHERE id=$1 AND status IN ('queued','processing')`,
            [lease.deliveryId],
          );
          await this.removeSchedule(manager, lease);
          return null;
        }
        if (row.attempts >= 3) {
          await manager.query(
            `UPDATE ${schema}.alert_deliveries SET status='failed', "nextAttemptAt"=NULL,
          "completedAt"=clock_timestamp(), "lastError"='Alert delivery exhausted its retry limit.' WHERE id=$1`,
            [lease.deliveryId],
          );
          await this.removeSchedule(manager, lease);
          return null;
        }
        let credentials: unknown;
        try {
          credentials = this.rules.credentialCipher.decrypt(
            lease.tenantId,
            row.channelId,
            row.credentials,
          );
        } catch {
          await manager.query(
            `UPDATE ${schema}.alert_deliveries SET status='failed', "nextAttemptAt"=NULL,
          "completedAt"=clock_timestamp(), "lastError"='Alert channel credentials are unavailable.' WHERE id=$1`,
            [lease.deliveryId],
          );
          await this.removeSchedule(manager, lease);
          return null;
        }
        await manager.query(
          `UPDATE ${schema}.alert_deliveries SET status='processing', attempts=attempts+1,
        "nextAttemptAt"=NULL, "lastError"=NULL WHERE id=$1`,
          [lease.deliveryId],
        );
        await manager.query(
          `UPDATE public.alert_delivery_schedule SET "leaseStarted"=true WHERE "tenantId"=$1 AND "deliveryId"=$2 AND "leaseToken"=$3`,
          [lease.tenantId.toLowerCase(), lease.deliveryId, lease.leaseToken],
        );
        return {
          credentials,
          attempt: row.attempts + 1,
          payload: {
            version: 1,
            deliveryId: lease.deliveryId,
            tenantId: lease.tenantId.toLowerCase(),
            event: {
              id: row.id,
              ruleId: row.ruleId,
              ruleName: row.ruleName,
              metric: row.metric,
              operator: row.operator,
              threshold: row.threshold,
              windowMinutes: row.windowMinutes,
              state: row.state,
              value: row.value,
              createdAt: new Date(row.createdAt).toISOString(),
            },
          },
        };
      },
    );
  }
  private async stillOwned(
    lease: AlertDeliveryLease,
    attempt: number,
  ): Promise<boolean> {
    const schema = tenantSchema(lease.tenantId);
    return this.dataSource.transaction(async (manager) => {
      await this.bounds(manager);
      const [row] = await manager.query<Array<{ owned: boolean }>>(
        `SELECT true AS owned FROM public.alert_delivery_schedule q
        JOIN ${schema}.alert_deliveries d ON d.id=q."deliveryId"
        JOIN ${schema}.alert_channels c ON c.id=d."channelId"
        WHERE q."tenantId"=$1 AND q."deliveryId"=$2 AND q."leaseToken"=$3 AND q."leaseUntil">clock_timestamp() AND q."leaseStarted"=true
        AND d.status='processing' AND d.attempts=$4 AND c.enabled=true AND c.revision=d."channelRevision"`,
        [
          lease.tenantId.toLowerCase(),
          lease.deliveryId,
          lease.leaseToken,
          attempt,
        ],
      );
      return !!row;
    });
  }
  private async performDelivery(
    lease: AlertDeliveryLease,
    controller: AbortController,
  ): Promise<boolean> {
    const job = await this.prepare(lease);
    if (!job) return false;
    let checking: Promise<void> | undefined;
    const check = async () => {
      try {
        if (!(await this.stillOwned(lease, job.attempt))) controller.abort();
      } catch {
        controller.abort();
      }
    };
    await check();
    if (this.stopping) controller.abort();
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      const task = check();
      checking = task;
      void task.finally(() => {
        if (checking === task) checking = undefined;
      });
    }, ALERT_DELIVERY_CHECK_MS);
    timer.unref();
    let failure: AlertTransportError | undefined;
    try {
      await this.transport.deliver(
        job.credentials,
        job.payload,
        controller.signal,
      );
    } catch (error) {
      failure =
        error instanceof AlertTransportError
          ? error
          : new AlertTransportError('connection_failed', true);
    } finally {
      clearInterval(timer);
      if (checking) await checking;
    }
    return this.finish(lease, job.attempt, failure);
  }
  private finish(
    lease: AlertDeliveryLease,
    attempt: number,
    failure?: AlertTransportError,
  ): Promise<boolean> {
    return this.rules.withTenantTransaction(
      lease.tenantId,
      async (manager, schema) => {
        const [owned] = await manager.query<Array<{ leaseToken: string }>>(
          `SELECT "leaseToken" FROM public.alert_delivery_schedule
        WHERE "tenantId"=$1 AND "deliveryId"=$2 AND "leaseToken"=$3 AND "leaseUntil">clock_timestamp() FOR UPDATE`,
          [lease.tenantId.toLowerCase(), lease.deliveryId, lease.leaseToken],
        );
        if (!owned) return false;
        const [row] = await manager.query<Array<{ valid: boolean }>>(
          `SELECT (c.enabled=true AND c.revision=d."channelRevision") AS valid
        FROM ${schema}.alert_deliveries d LEFT JOIN ${schema}.alert_channels c ON c.id=d."channelId"
        WHERE d.id=$1 AND d.status='processing' AND d.attempts=$2 FOR UPDATE OF d`,
          [lease.deliveryId, attempt],
        );
        if (!row?.valid) {
          await manager.query(
            `UPDATE ${schema}.alert_deliveries SET status='cancelled', "nextAttemptAt"=NULL,
            "completedAt"=clock_timestamp(), "lastError"='Alert configuration changed.' WHERE id=$1 AND status='processing' AND attempts=$2`,
            [lease.deliveryId, attempt],
          );
          await this.removeSchedule(manager, lease);
          return false;
        }
        const retry =
          !!failure &&
          (failure.retryable || failure.code === 'cancelled') &&
          attempt < 3;
        if (retry) {
          const delay = ALERT_DELIVERY_RETRY_MS[attempt - 1];
          await manager.query(
            `UPDATE ${schema}.alert_deliveries SET status='queued', "lastError"=$2,
          "nextAttemptAt"=clock_timestamp()+make_interval(secs=>$3), "completedAt"=NULL WHERE id=$1`,
            [lease.deliveryId, failure.message, delay / 1000],
          );
          await manager.query(
            `UPDATE public.alert_delivery_schedule SET "dueAt"=clock_timestamp()+make_interval(secs=>$4), "leaseToken"=NULL,"leaseUntil"=NULL,"leaseStarted"=false
          WHERE "tenantId"=$1 AND "deliveryId"=$2 AND "leaseToken"=$3`,
            [
              lease.tenantId.toLowerCase(),
              lease.deliveryId,
              lease.leaseToken,
              delay / 1000,
            ],
          );
        } else {
          await manager.query(
            `UPDATE ${schema}.alert_deliveries SET status=$2,"lastError"=$3,"nextAttemptAt"=NULL,"completedAt"=clock_timestamp() WHERE id=$1`,
            [
              lease.deliveryId,
              failure ? 'failed' : 'delivered',
              failure?.message ?? null,
            ],
          );
          await this.removeSchedule(manager, lease);
        }
        return true;
      },
    );
  }
}
