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
  logPrivacyPolicy,
  validateLogPrivacy,
  type LogPrivacyState,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { ConfigPushService } from '../config-push/config-push.service';

@Injectable()
export class LogPrivacyService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogPrivacyService.name);
  private timer?: NodeJS.Timeout;
  private sweep?: Promise<void>;
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();
  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
  ) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      if (this.sweep || this.stopping) return;
      this.sweep = this.scrub()
        .catch(() => this.logger.warn('Historical privacy cleanup will retry'))
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
        'Privacy settings are busy. Try again shortly.',
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
      `SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'`,
    );
  }
  private async state(
    manager: EntityManager,
    id: string,
  ): Promise<LogPrivacyState> {
    const [row] = await manager.query(
      `SELECT "logPrivacy","logPrivacyRevision","logPrivacyScrubDone","logPrivacyScrubError",
      EXISTS (SELECT 1 FROM public.pending_config_updates WHERE "tenantId"=t.id) AS pending
      FROM public.tenants t WHERE id=$1`,
      [id],
    );
    if (!row) throw new NotFoundException('Workspace not found');
    return {
      policy: logPrivacyPolicy(row.logPrivacy),
      revision: row.logPrivacyRevision,
      historicalCleanup: row.logPrivacyScrubDone
        ? 'complete'
        : row.logPrivacyScrubError
          ? 'retrying'
          : 'pending',
      gatewayUpdatePending: row.pending,
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
      throw new BadRequestException('Privacy settings are required');
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).length !== 2 ||
      Object.keys(body).some(
        (k) => k !== 'policy' && k !== 'expectedRevision',
      ) ||
      typeof body.expectedRevision !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        body.expectedRevision,
      )
    )
      throw new BadRequestException('A current privacy revision is required');
    let policy;
    try {
      policy = validateLogPrivacy(body.policy);
    } catch {
      throw new BadRequestException('Choose omit or retain for each log field');
    }
    return this.admitted(async () => {
      const result = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        // Serialize policy/version writes while permitting archive FK KEY SHARE.
        // FOR UPDATE would deadlock an admitted insert against our export lock.
        const [row] = await manager.query(
          `SELECT "logPrivacy","logPrivacyRevision","logPrivacyScrubDone" FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE`,
          [id],
        );
        if (!row) throw new NotFoundException('Workspace not found');
        if (
          row.logPrivacyRevision !==
          (body.expectedRevision as string).toLowerCase()
        )
          throw new ConflictException(
            'Privacy settings changed. Reload the current settings before saving.',
          );
        if (
          JSON.stringify(logPrivacyPolicy(row.logPrivacy)) ===
          JSON.stringify(policy)
        )
          return { state: await this.state(manager, id), payload: undefined };
        const previous = logPrivacyPolicy(row.logPrivacy);
        if (
          !row.logPrivacyScrubDone &&
          ((previous.clientIp === 'omit' && policy.clientIp === 'retain') ||
            (previous.userAgent === 'omit' && policy.userAgent === 'retain'))
        )
          throw new ConflictException(
            'Historical cleanup must finish before retaining previously omitted fields. Try again shortly.',
          );
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `log-export:${id}`,
        ]);
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          [`log-receipt:${id}`],
        );
        await manager.query(
          `UPDATE public.tenants SET "logPrivacy"=$2,"logPrivacyRevision"=gen_random_uuid(),"logPrivacyScrubCursor"=NULL,"logPrivacyScrubDone"=false,"logPrivacyScrubError"=false,"logPrivacyScrubCheckedAt"=NULL WHERE id=$1`,
          [id, JSON.stringify(policy)],
        );
        await manager.query(
          `UPDATE public.log_export_jobs SET status='expired',expires_at=LEAST(expires_at,clock_timestamp()),lease_id=NULL,lease_until=NULL,cleanup_at=NULL,error='Privacy policy changed. Create a new archive.' WHERE tenant_id=$1 AND status <> 'expired'`,
          [id],
        );
        const payload = await this.push.persistUpdate(id, manager);
        return { state: await this.state(manager, id), payload };
      });
      // A failed Redis publication cannot turn a committed save into a misleading failure.
      if (result.payload) await this.push.publish(result.payload);
      return result.state;
    });
  }
  /** One page per tenant per transaction; progress is durable and replicas skip owned tenants. */
  async scrub(): Promise<void> {
    for (let page = 0; page < 8 && !this.stopping; page++) {
      let attempted: { id: string; revision: string } | undefined;
      try {
        const found = await this.db.transaction(async (manager) => {
          await this.bounded(manager);
          const [row] = await manager.query(
            `SELECT id,"logPrivacy","logPrivacyScrubCursor","logPrivacyRevision" FROM public.tenants WHERE NOT "logPrivacyScrubDone" ORDER BY "logPrivacyScrubCheckedAt" NULLS FIRST,id LIMIT 1 FOR NO KEY UPDATE SKIP LOCKED`,
          );
          if (!row) return false;
          attempted = { id: row.id, revision: row.logPrivacyRevision };
          await manager.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
            [`log-receipt:${row.id}`],
          );
          const policy = logPrivacyPolicy(row.logPrivacy);
          const schema = tenantSchema(row.id);
          // Do not skip locked log rows: advancing past one would permanently miss its erasure.
          const changed: Array<{ id: string }> = await manager.query(
            `WITH page AS (
          SELECT id FROM ${schema}.request_logs WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 500 FOR UPDATE
        ), scrubbed AS (UPDATE ${schema}.request_logs l SET "clientIp"=CASE WHEN $2 THEN '[redacted]' ELSE "clientIp" END,"userAgent"=CASE WHEN $3 THEN NULL ELSE "userAgent" END FROM page WHERE l.id=page.id RETURNING l.id) SELECT id FROM scrubbed ORDER BY id`,
            [
              row.logPrivacyScrubCursor,
              policy.clientIp === 'omit',
              policy.userAgent === 'omit',
            ],
          );
          await manager.query(
            `UPDATE public.tenants SET "logPrivacyScrubCursor"=$2,"logPrivacyScrubDone"=$3,"logPrivacyScrubError"=false,"logPrivacyScrubCheckedAt"=clock_timestamp() WHERE id=$1 AND "logPrivacyRevision"=$4`,
            [
              row.id,
              changed.at(-1)?.id ?? row.logPrivacyScrubCursor,
              changed.length < 500,
              row.logPrivacyRevision,
            ],
          );
          return true;
        });
        if (!found) break;
      } catch {
        this.logger.warn(
          'A tenant historical cleanup failed; continuing the sweep',
        );
        if (!attempted) break;
        const failed = attempted;
        await this.db
          .transaction(async (manager) => {
            await this.bounded(manager);
            await manager.query(
              `UPDATE public.tenants SET "logPrivacyScrubCheckedAt"=clock_timestamp(),"logPrivacyScrubError"=true WHERE id=$1 AND "logPrivacyRevision"=$2 AND NOT "logPrivacyScrubDone"`,
              [failed.id, failed.revision],
            );
          })
          .catch(() => undefined);
      }
    }
  }
}
