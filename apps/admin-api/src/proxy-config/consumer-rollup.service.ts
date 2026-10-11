import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { CONSUMER_ROLLUP_PAGE_SIZE } from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { retentionProfile } from '../log-retention/log-retention.policy';
import { eraseConsumerPathRollups } from './consumer-path-rollup-cleanup';

/** Called under the canonical receipt lock. Old test/legacy schemas may lack DDL. */
export async function eraseConsumerRollups(
  manager: Pick<EntityManager, 'query'>,
  tenantId: string,
  options: { attributionHidden: boolean; receiptCutoff?: string },
): Promise<number> {
  const schema = tenantSchema(tenantId);
  const [exists] = await manager.query(
    'SELECT to_regclass($1) IS NOT NULL AS ready',
    [`${schema}.consumer_usage_rollups`],
  );
  if (!exists?.ready) return 0;
  const [removed] = await manager.query(
    `WITH page AS (
      SELECT consumer_id,request_minute,receipt_minute FROM ${schema}.consumer_usage_rollups
      WHERE $1::boolean OR last_receipt<$2::timestamptz ORDER BY last_receipt,consumer_id,request_minute,receipt_minute LIMIT $3 FOR UPDATE
    ), erased AS (
      DELETE FROM ${schema}.consumer_usage_rollups r USING page p
      WHERE (r.consumer_id,r.request_minute,r.receipt_minute)=(p.consumer_id,p.request_minute,p.receipt_minute) RETURNING 1
    ), updated AS (
      UPDATE ${schema}.consumer_usage_rollup_state SET cells=cells-(SELECT COUNT(*) FROM erased)
      WHERE singleton RETURNING (SELECT COUNT(*)::integer FROM erased) AS removed
    ) SELECT removed FROM updated`,
    [
      options.attributionHidden,
      options.receiptCutoff ?? null,
      CONSUMER_ROLLUP_PAGE_SIZE,
    ],
  );
  return removed?.removed ?? 0;
}

/** Fair bounded backfill; row markers and aggregates commit in the same transaction. */
@Injectable()
export class ConsumerRollupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ConsumerRollupService.name);
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private stopping = false;

  constructor(private readonly db: DataSource) {}

  onApplicationBootstrap(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, 2000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.work;
  }

  sweep(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.work) return this.work;
    this.work = this.run().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }

  private async run(): Promise<void> {
    for (let page = 0; page < 8 && !this.stopping; page++) {
      let attempted: string | undefined;
      try {
        const found = await this.db.transaction(async (manager) => {
          await manager.query(
            "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
          );
          const candidate = `SELECT id FROM public.tenants WHERE
              ("consumerRollupCheckedAt" IS NULL OR "consumerRollupCheckedAt"<=clock_timestamp()) AND (
              (("consumerRollupPending" OR EXISTS(SELECT 1 FROM public.consumer_rollup_backlog b WHERE b.tenant_id=public.tenants.id))
                AND NOT "consumerRollupError") OR "consumerRollupCheckedAt" IS NULL OR "consumerRollupCheckedAt"<clock_timestamp()-INTERVAL '1 minute')
              ORDER BY "consumerRollupCheckedAt" NULLS FIRST,id LIMIT 1 FOR NO KEY UPDATE`;
          let [tenant] = await manager.query(`${candidate} SKIP LOCKED`);
          // Periodic workers can repeatedly hit the same brief row-lock phase.
          // Prefer free tenants, then wait within the existing one-second budget
          // when all candidates are busy. PostgreSQL rechecks eligibility after
          // the lock; receipt/marker fencing still prevents replica double counts.
          if (!tenant) [tenant] = await manager.query(candidate);
          if (!tenant) return false;
          attempted = tenant.id;
          const schema = tenantSchema(tenant.id);
          await manager.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`log-receipt:${tenant.id}`],
          );
          const profile = await retentionProfile(manager, tenant.id);
          await eraseConsumerRollups(manager, tenant.id, {
            attributionHidden: false,
            receiptCutoff: profile.cutoff,
          });
          await eraseConsumerPathRollups(manager, tenant.id, {
            attributionHidden: false,
            receiptCutoff: profile.cutoff,
          });
          const rows: Array<{ id: string }> = await manager.query(
            `SELECT id FROM ${schema}.request_logs WHERE "usageRollupVersion" IS NULL OR "pathRollupVersion" IS NULL ORDER BY "receivedAt",id LIMIT $1 FOR UPDATE`,
            [CONSUMER_ROLLUP_PAGE_SIZE],
          );
          await manager.query(
            `SELECT ${schema}.materialize_consumer_usage($1::uuid[])`,
            [rows.map((row) => row.id)],
          );
          const [state] = await manager.query(
            `WITH updated AS (UPDATE ${schema}.consumer_usage_rollup_state SET backfill_complete=NOT EXISTS (
              SELECT 1 FROM ${schema}.request_logs WHERE "usageRollupVersion" IS NULL
            ) WHERE singleton RETURNING backfill_complete,capacity_blocked), paths AS (
              UPDATE ${schema}.consumer_path_rollup_state SET backfill_complete=NOT EXISTS (
                SELECT 1 FROM ${schema}.request_logs WHERE "pathRollupVersion" IS NULL
              ) WHERE singleton RETURNING backfill_complete,capacity_blocked
            ) SELECT (NOT c.backfill_complete AND NOT c.capacity_blocked) OR
              (NOT p.backfill_complete AND NOT p.capacity_blocked) AS pending FROM updated c CROSS JOIN paths p`,
          );
          // Ingestion and this acknowledgement hold the same receipt fence.
          // Remaining work transfers to the public pending flag atomically;
          // capacity pressure transfers to the existing idle retry instead.
          await manager.query(
            'DELETE FROM public.consumer_rollup_backlog WHERE tenant_id=$1',
            [tenant.id],
          );
          await manager.query(
            `UPDATE public.tenants SET "consumerRollupPending"=$2,"consumerRollupError"=false,"consumerRollupCheckedAt"=clock_timestamp() WHERE id=$1`,
            [tenant.id, state.pending],
          );
          return true;
        });
        if (!found) break;
      } catch (error) {
        // Receipt contention is expected during ingestion/cleanup. Keep the
        // one-second lock budget, but retry on the next timer rather than putting
        // a healthy backlog into the one-minute materialization-failure cooldown.
        const code =
          (error as { code?: string; driverError?: { code?: string } })
            ?.driverError?.code ?? (error as { code?: string })?.code;
        const contention = code === '55P03';
        this.logger.warn(
          'Consumer rollup backfill will retry; raw usage remains available',
        );
        if (!attempted) break;
        await this.db
          .transaction(async (manager) => {
            await manager.query(
              "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
            );
            await manager.query(
              `UPDATE public.tenants SET "consumerRollupError"=$2,"consumerRollupCheckedAt"=clock_timestamp()+
                CASE WHEN $2::boolean THEN INTERVAL '0 seconds' ELSE INTERVAL '2 seconds' END WHERE id=$1`,
              [attempted, !contention],
            );
          })
          .catch(() => undefined);
      }
    }
  }
}
