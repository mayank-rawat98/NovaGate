import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type {
  LogExportCadence,
  LogExportSchedule,
  LogExportScheduleState,
  LogExportSelection,
  SaveLogExportSchedule,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { ObjectStorageService } from './object-storage.service';
import { validateExportSelection } from './log-export.service';

export const LOG_EXPORT_SETTLEMENT_SECONDS = 15;
export const LOG_EXPORT_QUEUE_LIMIT = 20;
const TICK_WINDOWS = 16;
interface ScheduleRow {
  id: string;
  tenant_id: string;
  revision: string;
  enabled: boolean;
  cadence: LogExportCadence;
  filter: LogExportSelection;
  started_at: Date;
  cursor_at: Date;
  cursor_iso?: string;
  next_due_at: Date;
  updated_at: Date;
  last_checked_at?: Date;
  last_job_id?: string;
  error?: string;
}
function revision(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    throw new BadRequestException('Use the latest schedule revision');
  return value.toLowerCase();
}
export function validateSchedule(body: unknown): SaveLogExportSchedule {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Schedule settings are required');
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !['enabled', 'cadence', 'filter', 'expectedRevision'].includes(key),
    )
  )
    throw new BadRequestException('Unknown schedule setting');
  if (
    typeof input.enabled !== 'boolean' ||
    (input.cadence !== 'near_real_time' && input.cadence !== 'hourly')
  )
    throw new BadRequestException(
      'Select a supported cadence and pause setting',
    );
  return {
    enabled: input.enabled,
    cadence: input.cadence as LogExportCadence,
    filter: validateExportSelection(input.filter),
    expectedRevision: revision(input.expectedRevision, true),
  };
}
function view(row: ScheduleRow): LogExportSchedule {
  const windowMs = row.cadence === 'hourly' ? 3600000 : 60000;
  return {
    id: row.id,
    revision: row.revision,
    enabled: row.enabled,
    cadence: row.cadence,
    filter: row.filter,
    startedAt: row.started_at.toISOString(),
    cursor: row.cursor_iso
      ? preciseIso(row.cursor_iso)
      : row.cursor_at.toISOString(),
    nextWindowAt: new Date(
      (Math.floor(row.cursor_at.getTime() / windowMs) + 1) * windowMs,
    ).toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastCheckedAt: row.last_checked_at?.toISOString(),
    lastJobId: row.last_job_id ?? undefined,
    error: row.error ?? undefined,
  };
}
function preciseIso(value: string) {
  return value.replace(/(\.\d{3})000Z$/, '$1Z');
}
async function deadlines(manager: EntityManager) {
  await manager.query(
    `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
  );
}
function interval(cadence: LogExportCadence) {
  return cadence === 'hourly' ? '1 hour' : '1 minute';
}

/** Scheduling contains no network work. Its transaction is the claim: window
 * admission, immutable job insertion and cursor movement commit together. */
@Injectable()
export class LogExportSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogExportSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly db: DataSource,
    private readonly storage: ObjectStorageService,
  ) {}

  onApplicationBootstrap() {
    if (!this.storage.enabled || this.timer || this.stopping) return;
    this.timer = setInterval(() => this.startTick(), 2000);
    this.timer.unref();
    this.startTick();
  }
  private startTick() {
    if (this.work || this.stopping) return;
    this.work = this.tick()
      .catch(() => {
        this.logger.warn(
          'Archive scheduling is temporarily unavailable; retained windows will retry',
        );
      })
      .finally(() => {
        this.work = undefined;
      });
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.work;
  }
  async get(tenantId: string): Promise<LogExportScheduleState> {
    tenantSchema(tenantId);
    const [row]: Array<
      ScheduleRow & { pending: number; failed: number; backlog: number }
    > = await this.db.transaction(async (manager) => {
      await deadlines(manager);
      return manager.query(
        `SELECT s.*, to_char(s.cursor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_iso,
        (SELECT COUNT(*)::integer FROM public.log_export_jobs j WHERE j.tenant_id=s.tenant_id AND j.status IN ('queued','processing')) AS pending,
        (SELECT COUNT(*)::integer FROM public.log_export_jobs j WHERE j.tenant_id=s.tenant_id AND j.schedule_id=s.id AND j.status='failed') AS failed,
        CASE WHEN s.next_due_at<=clock_timestamp() THEN GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (clock_timestamp()-make_interval(secs=>$2)-s.cursor_at)))) ELSE 0 END::integer AS backlog
        FROM public.log_export_schedules s WHERE s.tenant_id=$1`,
        [tenantId, LOG_EXPORT_SETTLEMENT_SECONDS],
      );
    });
    return {
      available: this.storage.enabled,
      schedule: row ? view(row) : null,
      settlementSeconds: LOG_EXPORT_SETTLEMENT_SECONDS,
      pendingJobs: row?.pending ?? 0,
      failedJobs: row?.failed ?? 0,
      backlogSeconds: row?.backlog ?? 0,
      queueLimit: LOG_EXPORT_QUEUE_LIMIT,
    };
  }
  async save(tenantId: string, body: unknown): Promise<LogExportScheduleState> {
    const schema = tenantSchema(tenantId);
    const input = validateSchedule(body);
    if (!this.storage.enabled)
      throw new ServiceUnavailableException(
        'Automatic archives are not enabled for this installation',
      );
    const canonical = schema.slice(7).replace(/_/g, '-');
    await this.db.transaction(async (manager) => {
      await deadlines(manager);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `log-export:${canonical}`,
      ]);
      const [current]: ScheduleRow[] = await manager.query(
        `SELECT * FROM public.log_export_schedules WHERE tenant_id=$1 FOR UPDATE`,
        [canonical],
      );
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new ConflictException(
          'The archive schedule changed. Refresh it before saving.',
        );
      // Creation coordinates with ingestion so the initial cursor has a precise
      // database receipt boundary. Changes keep all unprocessed windows.
      if (!current)
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`log-receipt:${canonical}`],
        );
      await manager.query(
        `INSERT INTO public.log_export_schedules (tenant_id,revision,enabled,cadence,filter,started_at,cursor_at,next_due_at)
         SELECT $1,$2,$3,$4,$5,started,cursor_at,date_bin($6::interval,cursor_at,'1970-01-01T00:00:00Z'::timestamptz)+$6::interval+make_interval(secs=>$7)
         FROM (SELECT COALESCE($8::timestamptz,saved_at) AS cursor_at,COALESCE($9::timestamptz,saved_at) AS started FROM (SELECT clock_timestamp() AS saved_at) saved) initial
         ON CONFLICT (tenant_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,cadence=EXCLUDED.cadence,filter=EXCLUDED.filter,
           next_due_at=EXCLUDED.next_due_at,updated_at=clock_timestamp(),error=NULL`,
        [
          canonical,
          randomUUID(),
          input.enabled,
          input.cadence,
          JSON.stringify(input.filter),
          interval(input.cadence),
          LOG_EXPORT_SETTLEMENT_SECONDS,
          current?.cursor_at ?? null,
          current?.started_at ?? null,
        ],
      );
    });
    return this.get(canonical);
  }
  async remove(
    tenantId: string,
    body: unknown,
  ): Promise<LogExportScheduleState> {
    const schema = tenantSchema(tenantId);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'expectedRevision')
    )
      throw new BadRequestException('Use the latest schedule revision');
    const expected = revision(
      (body as Record<string, unknown>).expectedRevision,
    );
    const canonical = schema.slice(7).replace(/_/g, '-');
    await this.db.transaction(async (manager) => {
      await deadlines(manager);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `log-export:${canonical}`,
      ]);
      const removed = await manager.query(
        `WITH removed AS (DELETE FROM public.log_export_schedules WHERE tenant_id=$1 AND revision=$2 RETURNING id) SELECT * FROM removed`,
        [canonical, expected],
      );
      if (!removed.length)
        throw new ConflictException(
          'The archive schedule changed. Refresh it before removing.',
        );
    });
    return this.get(canonical);
  }
  /** A finite sweep. Locked/busy tenants are deferred without cursor movement. */
  async tick(): Promise<void> {
    if (this.stopping || !this.storage.enabled) return;
    for (let i = 0; i < TICK_WINDOWS && !this.stopping; i++) {
      const handled = await this.scheduleNext();
      if (!handled) break;
    }
  }
  async scheduleNext(): Promise<boolean> {
    if (this.stopping || !this.storage.enabled) return false;
    return this.db.transaction('READ COMMITTED', async (manager) => {
      await deadlines(manager);
      const [row]: ScheduleRow[] = await manager.query(
        `SELECT * FROM public.log_export_schedules WHERE enabled AND next_due_at<=clock_timestamp() ORDER BY last_checked_at NULLS FIRST,next_due_at,tenant_id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!row) return false;
      const canonical = tenantSchema(row.tenant_id).slice(7).replace(/_/g, '-');
      const [{ admitted }]: Array<{ admitted: boolean }> = await manager.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AND pg_try_advisory_xact_lock(hashtextextended($2,0)) AS admitted`,
        [`log-export:${canonical}`, `log-receipt:${canonical}`],
      );
      if (!admitted) {
        await manager.query(
          `UPDATE public.log_export_schedules SET last_checked_at=clock_timestamp(),next_due_at=clock_timestamp()+INTERVAL '2 seconds' WHERE tenant_id=$1`,
          [canonical],
        );
        // Retry timing must not determine window boundaries; they use cursor + cadence below.
        return true;
      }
      const [{ pending }]: Array<{ pending: number }> = await manager.query(
        `SELECT COUNT(*)::integer AS pending FROM public.log_export_jobs WHERE tenant_id=$1 AND status IN ('queued','processing')`,
        [canonical],
      );
      if (pending >= LOG_EXPORT_QUEUE_LIMIT) {
        await manager.query(
          `UPDATE public.log_export_schedules SET error='Waiting for pending archives; unprocessed windows are retained',last_checked_at=clock_timestamp(),next_due_at=clock_timestamp()+INTERVAL '5 seconds' WHERE tenant_id=$1`,
          [canonical],
        );
        return true;
      }
      // Explicit UTC origin keeps minute/hour boundaries independent of TimeZone.
      const [{ from: rawFrom, to: rawTo, ready }]: Array<{
        from: string;
        to: string;
        ready: boolean;
      }> = await manager.query(
        `SELECT to_char(cursor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "from",
          to_char(boundary AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "to",
          boundary+make_interval(secs=>$3)<=clock_timestamp() AS ready
         FROM (SELECT cursor_at,date_bin($2::interval,cursor_at,'1970-01-01T00:00:00Z'::timestamptz)+$2::interval AS boundary FROM public.log_export_schedules WHERE tenant_id=$1) w`,
        [canonical, interval(row.cadence), LOG_EXPORT_SETTLEMENT_SECONDS],
      );
      const from = preciseIso(rawFrom);
      const to = preciseIso(rawTo);
      if (!ready) {
        await manager.query(
          `UPDATE public.log_export_schedules SET next_due_at=$2::timestamptz+make_interval(secs=>$3) WHERE tenant_id=$1`,
          [canonical, to, LOG_EXPORT_SETTLEMENT_SECONDS],
        );
        return true;
      }
      const params: unknown[] = [from, to];
      const conditions = [
        '"receivedAt">=$1::timestamptz',
        '"receivedAt"<$2::timestamptz',
      ];
      if (row.filter.minStatusCode !== undefined) {
        params.push(row.filter.minStatusCode);
        conditions.push(`"statusCode">=$${params.length}`);
      }
      if (row.filter.pathPrefix !== undefined) {
        params.push(row.filter.pathPrefix);
        conditions.push(
          `LEFT(path,LENGTH($${params.length}::text))=$${params.length}`,
        );
      }
      if (row.filter.consumerId !== undefined) {
        params.push(row.filter.consumerId);
        conditions.push(`"consumerId"=$${params.length}::uuid`);
      }
      const matched = await manager.query(
        `SELECT 1 FROM ${tenantSchema(canonical)}.request_logs WHERE ${conditions.join(' AND ')} LIMIT 1`,
        params,
      );
      let jobId: string | null = null;
      if (matched.length) {
        const [job]: Array<{ id: string }> = await manager.query(
          `INSERT INTO public.log_export_jobs (tenant_id,kind,time_basis,schedule_id,window_from,window_to,filter,expires_at,privacy_policy,privacy_revision)
           SELECT $1,'scheduled','receipt',$2,$3,$4,$5,clock_timestamp()+$6*INTERVAL '1 day',"logPrivacy","logPrivacyRevision" FROM public.tenants WHERE id=$1 RETURNING id`,
          [
            canonical,
            row.id,
            from,
            to,
            JSON.stringify({ ...row.filter, from, to }),
            this.storage.retentionDays,
          ],
        );
        jobId = job.id;
      }
      await manager.query(
        `UPDATE public.log_export_schedules SET cursor_at=$2,next_due_at=$2::timestamptz+$3::interval+make_interval(secs=>$4),last_checked_at=clock_timestamp(),last_job_id=COALESCE($5::uuid,last_job_id),error=NULL WHERE tenant_id=$1 AND revision=$6`,
        [
          canonical,
          to,
          interval(row.cadence),
          LOG_EXPORT_SETTLEMENT_SECONDS,
          jobId,
          row.revision,
        ],
      );
      return true;
    });
  }
}
