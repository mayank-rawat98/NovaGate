import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import {
  nextMonthStart,
  usageMeter,
  usageMonth,
  type BillingOverview,
  type ConsumerQuotaUsage,
  type Plan,
} from '@api-gateway/shared-types';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { billingSettings, type BillingSettings } from './billing-settings';

export type PlanResource = 'consumers' | 'routes';

type Db = DataSource | EntityManager;

interface PlanRow {
  id: string;
  name: string;
  requestsPerMonth: string | null;
  consumersMax: number | null;
  routesMax: number | null;
  logRetentionDays: number;
  priceMonthlyCents: number | null;
}

const DEFAULT_ENFORCEMENT_INTERVAL_MS = 60000;
const FALLBACK_PLAN = 'free';

/** Refused because the workspace plan does not allow more. */
export class PlanLimitException extends HttpException {
  constructor(message: string) {
    super({ statusCode: 402, error: 'PLAN_LIMIT', message }, 402);
  }
}

/**
 * Plans, metered usage and quota enforcement. Usage comes from gateway
 * reports (control plane → public.usage_meters). When BILLING_QUOTAS_ENABLED
 * is set, a workspace that uses its monthly requests is suspended until the
 * next UTC month, and plan caps bound consumers, routes and log retention.
 */
@Injectable()
export class BillingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BillingService.name);
  readonly settings: BillingSettings;
  private timer?: NodeJS.Timeout;
  private sweep?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
    config: ConfigService,
  ) {
    this.settings = billingSettings({
      BILLING_QUOTAS_ENABLED: config.get('BILLING_QUOTAS_ENABLED'),
      STRIPE_SECRET_KEY: config.get('STRIPE_SECRET_KEY'),
      STRIPE_WEBHOOK_SECRET: config.get('STRIPE_WEBHOOK_SECRET'),
      STRIPE_PRICES: config.get('STRIPE_PRICES'),
      STRIPE_API_BASE: config.get('STRIPE_API_BASE'),
      DASHBOARD_URL: config.get('DASHBOARD_URL'),
    });
    const interval = Number(
      config.get('BILLING_ENFORCEMENT_INTERVAL_MS') ??
        DEFAULT_ENFORCEMENT_INTERVAL_MS,
    );
    if (!Number.isSafeInteger(interval) || interval < 1000)
      throw new Error('BILLING_ENFORCEMENT_INTERVAL_MS must be at least 1000');
    this.intervalMs = interval;
  }
  private readonly intervalMs: number;

  onApplicationBootstrap() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.stopping || this.sweep) return;
      this.sweep = this.enforce()
        .catch(() => this.logger.warn('Quota enforcement will retry'))
        .finally(() => {
          this.sweep = undefined;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.sweep;
  }

  private plan(row: PlanRow): Plan {
    return {
      id: row.id,
      name: row.name,
      requestsPerMonth:
        row.requestsPerMonth === null ? null : Number(row.requestsPerMonth),
      consumersMax: row.consumersMax,
      routesMax: row.routesMax,
      logRetentionDays: row.logRetentionDays,
      priceMonthlyCents: row.priceMonthlyCents,
      purchasable: Boolean(this.settings.stripe?.prices[row.id]),
    };
  }

  async plans(db: Db = this.db): Promise<Plan[]> {
    const rows: PlanRow[] = await db.query(
      `SELECT id,name,"requestsPerMonth","consumersMax","routesMax","logRetentionDays","priceMonthlyCents" FROM public.plans ORDER BY sort,id`,
    );
    return rows.map((row) => this.plan(row));
  }

  /** The workspace's plan; an unknown plan ID gets the free plan's limits. */
  async tenantPlan(db: Db, tenantId: string): Promise<Plan> {
    const [row]: PlanRow[] = await db.query(
      `SELECT p.id,p.name,p."requestsPerMonth",p."consumersMax",p."routesMax",p."logRetentionDays",p."priceMonthlyCents"
         FROM public.tenants t JOIN public.plans p ON p.id IN (t."planId",$2)
        WHERE t.id=$1 ORDER BY p.id=t."planId" DESC LIMIT 1`,
      [tenantId, FALLBACK_PLAN],
    );
    if (row) return this.plan(row);
    const [tenant] = await db.query(
      `SELECT 1 FROM public.tenants WHERE id=$1`,
      [tenantId],
    );
    if (!tenant) throw new NotFoundException('Workspace not found');
    // No plan rows at all: nothing to enforce.
    return {
      id: FALLBACK_PLAN,
      name: 'Free',
      requestsPerMonth: null,
      consumersMax: null,
      routesMax: null,
      logRetentionDays: 90,
      priceMonthlyCents: null,
      purchasable: false,
    };
  }

  async requestsUsed(db: Db, tenantId: string, month: string) {
    const [row] = await db.query(
      `SELECT COALESCE(SUM(requests),0)::bigint AS used FROM public.usage_meters WHERE "tenantId"=$1 AND month=$2`,
      [tenantId, month],
    );
    return Number(row?.used ?? 0);
  }

  private async counts(db: Db, tenantId: string) {
    const schema = tenantSchema(tenantId);
    const [row] = await db.query(
      `SELECT (SELECT COUNT(*) FROM ${schema}.consumers WHERE "revokedAt" IS NULL)::int AS consumers,
              (SELECT COUNT(*) FROM ${schema}.routes WHERE "deletedAt" IS NULL)::int AS routes`,
    );
    return { consumers: row.consumers as number, routes: row.routes as number };
  }

  async overview(tenantId: string, now = new Date()): Promise<BillingOverview> {
    const id = this.id(tenantId);
    return this.db.transaction('REPEATABLE READ', async (manager) => {
      const plan = await this.tenantPlan(manager, id);
      const month = usageMonth(now);
      const [tenant] = await manager.query(
        `SELECT "quotaSuspendedUntil","logRetentionDays" FROM public.tenants WHERE id=$1`,
        [id],
      );
      const counts = await this.counts(manager, id);
      const until: Date | null = tenant.quotaSuspendedUntil;
      return {
        plan,
        plans: await this.plans(manager),
        month,
        resetsAt: nextMonthStart(now).toISOString(),
        requests: usageMeter(
          await this.requestsUsed(manager, id, month),
          plan.requestsPerMonth,
        ),
        consumers: usageMeter(counts.consumers, plan.consumersMax),
        routes: usageMeter(counts.routes, plan.routesMax),
        logRetentionDays: {
          configured: tenant.logRetentionDays ?? 30,
          max: plan.logRetentionDays,
        },
        suspended:
          until && until.getTime() > now.getTime()
            ? { reason: 'QUOTA_EXCEEDED', until: until.toISOString() }
            : null,
        quotasEnforced: this.settings.quotasEnabled,
        checkoutAvailable: Boolean(this.settings.stripe),
      };
    });
  }

  async consumerQuotas(
    tenantId: string,
    now = new Date(),
  ): Promise<ConsumerQuotaUsage[]> {
    const id = this.id(tenantId);
    const schema = tenantSchema(id);
    const month = usageMonth(now);
    const rows = await this.db.query(
      `SELECT c.id,c.name,c."monthlyQuota",COALESCE(u.requests,0)::bigint AS requests
         FROM ${schema}.consumers c
         LEFT JOIN (SELECT "consumerId",SUM(requests) AS requests FROM public.consumer_usage_meters
                     WHERE "tenantId"=$1 AND month=$2 GROUP BY "consumerId") u ON u."consumerId"=c.id
        WHERE c."revokedAt" IS NULL ORDER BY c."createdAt",c.id`,
      [id, month],
    );
    return rows.map(
      (row: {
        id: string;
        name: string;
        monthlyQuota: number | null;
        requests: string;
      }) => {
        const meter = usageMeter(Number(row.requests), row.monthlyQuota);
        return {
          consumerId: row.id,
          name: row.name,
          month,
          requests: meter.used,
          monthlyQuota: row.monthlyQuota,
          percent: meter.percent,
        };
      },
    );
  }

  /**
   * Runs a write that may add consumers or routes, refusing it when the
   * result exceeds the plan. Creation already over a downgraded plan's cap
   * stays; only growth is refused.
   */
  async withCapacity<T>(
    tenantId: string,
    resources: PlanResource[],
    write: (db: Db) => Promise<T>,
  ): Promise<T> {
    if (!this.settings.quotasEnabled) return write(this.db);
    return this.db.transaction(async (manager) => {
      const check = await this.capacityCheck(manager, tenantId, resources);
      const result = await write(manager);
      await check();
      return result;
    });
  }

  /** For callers already in a transaction: measure now, verify after writing. */
  async capacityCheck(
    manager: EntityManager,
    tenantId: string,
    resources: PlanResource[],
  ): Promise<() => Promise<void>> {
    if (!this.settings.quotasEnabled) return async () => undefined;
    const id = this.id(tenantId);
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'plan-capacity:' + id,
    ]);
    const before = await this.counts(manager, id);
    return async () => {
      const plan = await this.tenantPlan(manager, id);
      const after = await this.counts(manager, id);
      for (const resource of resources) {
        const max =
          resource === 'consumers' ? plan.consumersMax : plan.routesMax;
        if (
          max !== null &&
          after[resource] > max &&
          after[resource] > before[resource]
        )
          throw new PlanLimitException(
            `The ${plan.name} plan allows ${max} ${resource}. Upgrade the plan or remove ${resource} first.`,
          );
      }
    };
  }

  async assertRetention(
    manager: EntityManager,
    tenantId: string,
    days: number,
  ) {
    if (!this.settings.quotasEnabled) return;
    const plan = await this.tenantPlan(manager, this.id(tenantId));
    if (days > plan.logRetentionDays)
      throw new PlanLimitException(
        `The ${plan.name} plan keeps logs for at most ${plan.logRetentionDays} days.`,
      );
  }

  /**
   * Brings one workspace's suspension in line with its plan and usage,
   * pushing configuration when it changes. Callers hold the tenant row lock
   * or call through reconcile().
   */
  async reconcileIn(
    manager: EntityManager,
    tenantId: string,
    now = new Date(),
  ): Promise<
    Awaited<ReturnType<ConfigPushService['persistUpdate']>> | undefined
  > {
    const [tenant] = await manager.query(
      `SELECT "quotaSuspendedUntil" FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE`,
      [tenantId],
    );
    if (!tenant) return undefined;
    const plan = await this.tenantPlan(manager, tenantId);
    const used = await this.requestsUsed(manager, tenantId, usageMonth(now));
    const desired =
      this.settings.quotasEnabled &&
      plan.requestsPerMonth !== null &&
      used >= plan.requestsPerMonth
        ? nextMonthStart(now)
        : null;
    const current: Date | null = tenant.quotaSuspendedUntil;
    if ((current?.getTime() ?? null) === (desired?.getTime() ?? null))
      return undefined;
    await manager.query(
      `UPDATE public.tenants SET "quotaSuspendedUntil"=$2 WHERE id=$1`,
      [tenantId, desired],
    );
    if (desired)
      this.logger.warn(`Workspace ${tenantId} used its monthly request quota`);
    return this.push.persistUpdate(tenantId, manager);
  }

  async reconcile(tenantId: string, now = new Date()) {
    const id = this.id(tenantId);
    const payload = await this.db.transaction((manager) =>
      this.reconcileIn(manager, id, now),
    );
    // Persisted with the change; the retry loop redelivers if this fails.
    if (payload) await this.push.publish(payload);
    return Boolean(payload);
  }

  /** One pass over workspaces whose suspension should change. */
  async enforce(now = new Date()) {
    const month = usageMonth(now);
    const candidates: Array<{ id: string }> = await this.db.query(
      `SELECT t.id FROM public.tenants t
         LEFT JOIN public.plans own ON own.id=t."planId"
         LEFT JOIN public.plans fallback ON fallback.id=$2
         LEFT JOIN (SELECT "tenantId",SUM(requests) AS used FROM public.usage_meters WHERE month=$1 GROUP BY "tenantId") u
           ON u."tenantId"=t.id
        WHERE ($3 AND CASE WHEN own.id IS NULL THEN fallback."requestsPerMonth" ELSE own."requestsPerMonth" END <= COALESCE(u.used,0)
               AND (t."quotaSuspendedUntil" IS NULL OR t."quotaSuspendedUntil" <> $4))
           OR (t."quotaSuspendedUntil" IS NOT NULL AND (NOT $3 OR t."quotaSuspendedUntil" <= $5
               OR COALESCE(CASE WHEN own.id IS NULL THEN fallback."requestsPerMonth" ELSE own."requestsPerMonth" END > COALESCE(u.used,0), true)))
        LIMIT 500`,
      [
        month,
        FALLBACK_PLAN,
        this.settings.quotasEnabled,
        nextMonthStart(now),
        now,
      ],
    );
    for (const candidate of candidates) {
      if (this.stopping) return;
      await this.reconcile(candidate.id, now).catch(() =>
        this.logger.warn('A workspace quota update will retry'),
      );
    }
  }

  /** Sets the plan and immediately lifts or applies the matching suspension. */
  async applyPlan(
    manager: EntityManager,
    tenantId: string,
    planId: string,
    stripe?: { customerId?: string | null; subscriptionId?: string | null },
  ) {
    const [plan] = await manager.query(
      `SELECT id FROM public.plans WHERE id=$1`,
      [planId],
    );
    if (!plan) throw new NotFoundException('Plan not found');
    await manager.query(
      `UPDATE public.tenants SET "planId"=$2,
         "stripeCustomerId"=CASE WHEN $3 THEN $4 ELSE "stripeCustomerId" END,
         "stripeSubscriptionId"=CASE WHEN $5 THEN $6 ELSE "stripeSubscriptionId" END
       WHERE id=$1`,
      [
        tenantId,
        planId,
        stripe?.customerId !== undefined,
        stripe?.customerId ?? null,
        stripe?.subscriptionId !== undefined,
        stripe?.subscriptionId ?? null,
      ],
    );
    return this.reconcileIn(manager, tenantId);
  }

  id(tenantId: string) {
    const id = tenantId.toLowerCase();
    tenantSchema(id);
    return id;
  }
}
