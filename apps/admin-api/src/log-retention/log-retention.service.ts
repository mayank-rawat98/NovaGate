import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  MAX_LOG_RETENTION_DAYS,
  type LogRetentionState,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  retentionCoverage,
  retentionProfile,
  RETENTION_CUTOFF_SQL,
} from './log-retention.policy';

@Injectable()
export class LogRetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogRetentionService.name);
  private timer?: NodeJS.Timeout;
  private sweep?: Promise<void>;
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();
  constructor(private readonly db: DataSource) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      if (this.stopping || this.sweep) return;
      this.sweep = this.prune()
        .catch(() => this.logger.warn('Log retention cleanup will retry'))
        .finally(() => {
          this.sweep = undefined;
        });
    }, 2000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.sweep;
    await Promise.allSettled([...this.operations]);
  }
  private async admitted<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopping || this.operations.size >= 8)
      throw new ServiceUnavailableException(
        'Log retention settings are busy. Try again shortly.',
      );
    const work = fn();
    this.operations.add(work);
    try {
      return await work;
    } finally {
      this.operations.delete(work);
    }
  }
  private async bounded(manager: EntityManager) {
    await manager.query(
      "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
    );
  }
  private async state(
    manager: EntityManager,
    id: string,
  ): Promise<LogRetentionState> {
    const row = await retentionProfile(manager, id);
    return {
      ...retentionCoverage(row),
      cleanup: row.logRetentionError
        ? 'retrying'
        : row.logRetentionPending
          ? 'pending'
          : 'healthy',
      lastCheckedAt: row.checked,
    };
  }
  get(tenantId: string) {
    const id = tenantSchema(tenantId).slice(7).replace(/_/g, '-');
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        return this.state(manager, id);
      }),
    );
  }
  save(tenantId: string, input: unknown) {
    const id = tenantSchema(tenantId).slice(7).replace(/_/g, '-');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Log retention settings are required');
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).length !== 2 ||
      Object.keys(body).some(
        (k) => !['days', 'expectedRevision'].includes(k),
      ) ||
      typeof body.days !== 'number' ||
      !Number.isInteger(body.days) ||
      body.days < 1 ||
      body.days > MAX_LOG_RETENTION_DAYS ||
      typeof body.expectedRevision !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        body.expectedRevision,
      )
    )
      throw new BadRequestException(
        'Choose 1–90 whole days and use the current retention revision',
      );
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        // Permit archive FK KEY SHARE while serializing policy writes.
        const [row] = await manager.query(
          'SELECT "logRetentionDays","logRetentionRevision" FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE',
          [id],
        );
        if (!row) throw new NotFoundException('Workspace not found');
        if (
          row.logRetentionRevision !==
          (body.expectedRevision as string).toLowerCase()
        )
          throw new ConflictException(
            'Log retention changed. Reload current settings before saving.',
          );
        if (row.logRetentionDays === body.days) return this.state(manager, id);
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'log-export:' + id,
        ]);
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          ['log-receipt:' + id],
        );
        // Preserve both old and new cutoffs. Increasing retention cannot resurrect expired rows.
        await manager.query(
          'UPDATE public.tenants SET "logRetentionFloor"=GREATEST("logRetentionFloor",clock_timestamp()-make_interval(secs=>"logRetentionDays"::integer*86400),clock_timestamp()-make_interval(secs=>$2::integer*86400)),"logRetentionDays"=$2,"logRetentionRevision"=gen_random_uuid(),"logRetentionPending"=true,"logRetentionError"=false,"logRetentionCheckedAt"=NULL WHERE id=$1',
          [id, body.days],
        );
        await manager.query(
          "UPDATE public.log_export_jobs SET status='expired',expires_at=LEAST(expires_at,clock_timestamp()),lease_id=NULL,lease_until=NULL,cleanup_at=NULL,error='Log retention changed. Create a new archive.' WHERE tenant_id=$1 AND status<>'expired'",
          [id],
        );
        return this.state(manager, id);
      }),
    );
  }
  /** Fair, resumable pages, with receipt admission fenced through commit. */
  async prune(): Promise<void> {
    for (let page = 0; page < 8 && !this.stopping; page++) {
      let attempted: { id: string; revision: string } | undefined;
      try {
        const found = await this.db.transaction(async (manager) => {
          await this.bounded(manager);
          const [row] = await manager.query(
            'SELECT id,"logRetentionRevision" FROM public.tenants WHERE ("logRetentionPending" AND NOT "logRetentionError") OR "logRetentionCheckedAt" IS NULL OR "logRetentionCheckedAt"<clock_timestamp()-INTERVAL \'1 minute\' ORDER BY "logRetentionCheckedAt" NULLS FIRST,id LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED',
          );
          if (!row) return false;
          attempted = { id: row.id, revision: row.logRetentionRevision };
          await manager.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            ['log-receipt:' + row.id],
          );
          await manager.query(
            'UPDATE public.tenants SET "logRetentionFloor"=' +
              RETENTION_CUTOFF_SQL +
              ' WHERE id=$1',
            [row.id],
          );
          const profile = await retentionProfile(manager, row.id);
          // Do not skip locked log rows and incorrectly report their deletion as complete.
          const removed: Array<{ id: string }> = await manager.query(
            'WITH page AS (SELECT id FROM ' +
              tenantSchema(row.id) +
              '.request_logs WHERE "receivedAt"<$1::timestamptz ORDER BY "receivedAt",id LIMIT 500 FOR UPDATE), removed AS (DELETE FROM ' +
              tenantSchema(row.id) +
              '.request_logs l USING page WHERE l.id=page.id RETURNING l.id) SELECT id FROM removed',
            [profile.cutoff],
          );
          await manager.query(
            'UPDATE public.tenants SET "logRetentionPending"=$2,"logRetentionError"=false,"logRetentionCheckedAt"=clock_timestamp() WHERE id=$1 AND "logRetentionRevision"=$3',
            [row.id, removed.length === 500, row.logRetentionRevision],
          );
          return true;
        });
        if (!found) break;
      } catch {
        this.logger.warn(
          'A tenant log retention cleanup failed; continuing the sweep',
        );
        if (!attempted) break;
        const failed = attempted;
        await this.db
          .transaction(async (manager) => {
            await this.bounded(manager);
            await manager.query(
              'UPDATE public.tenants SET "logRetentionPending"=true,"logRetentionError"=true,"logRetentionCheckedAt"=clock_timestamp() WHERE id=$1 AND "logRetentionRevision"=$2',
              [failed.id, failed.revision],
            );
          })
          .catch(() => undefined);
      }
    }
  }
}
