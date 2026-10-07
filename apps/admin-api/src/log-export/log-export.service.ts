import {
  retentionProfile,
  RETENTION_CUTOFF_SQL,
} from '../log-retention/log-retention.policy';
import { redactRequestLog } from '@api-gateway/shared-types';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  ConflictException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  LogExportFilter,
  LogExportJob,
  LogExportList,
  LogExportStatus,
  LogExportSelection,
  LogExportTimeBasis,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { ObjectStorageService } from './object-storage.service';

interface JobRow {
  id: string;
  tenant_id: string;
  status: LogExportStatus;
  filter: LogExportFilter;
  attempts: number;
  retry_count: number;
  lease_id?: string;
  object_key?: string;
  row_count: number;
  bytes: string | number;
  error?: string;
  created_at: Date;
  completed_at?: Date;
  expires_at: Date;
  kind: 'manual' | 'scheduled';
  time_basis: LogExportTimeBasis;
  schedule_id?: string;
  privacy_policy?: unknown;
  privacy_revision?: string;
  retention_revision?: string;
  retention_days?: number;
  retention_from?: Date;
  retention_cutoff?: string;
}
const MAX_ATTEMPTS = 3;
const MAX_ROWS = 1_000_000;
const MAX_BYTES = 512 * 1024 * 1024;
const LEASE_SECONDS = 180;
const DEADLINE_MS = 120_000;
const BATCH_ROWS = 500;

function view(row: JobRow): LogExportJob {
  return {
    retention:
      row.retention_revision &&
      row.retention_from &&
      row.retention_days !== undefined
        ? {
            days: row.retention_days,
            revision: row.retention_revision,
            receivedFrom:
              row.retention_cutoff ?? row.retention_from.toISOString(),
            timeBasis: 'receipt',
          }
        : undefined,
    id: row.id,
    status: row.status,
    filter: row.filter,
    attempts: row.attempts,
    retryCount: row.retry_count ?? 0,
    rowCount: row.row_count,
    bytes: Number(row.bytes),
    error: row.error ?? undefined,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    kind: row.kind ?? 'manual',
    timeBasis: row.time_basis ?? 'request',
    scheduleId: row.schedule_id ?? undefined,
  };
}
function jobId(id: string) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
    throw new BadRequestException('Invalid archive ID');
  return id.toLowerCase();
}
export function validateExportFilter(body: unknown): LogExportFilter {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Archive filters are required');
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !['from', 'to', 'minStatusCode', 'pathPrefix', 'consumerId'].includes(
          key,
        ),
    )
  )
    throw new BadRequestException('Unknown archive filter');
  const date = (key: string) => {
    const value = input[key];
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new BadRequestException(
        'Use UTC timestamps for the archive date range',
      );
    const normalized = new Date(value).toISOString();
    if (normalized.slice(0, 19) !== value.slice(0, 19))
      throw new BadRequestException('Invalid archive timestamp');
    return normalized;
  };
  const from = date('from');
  const to = date('to');
  if (
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 31 * 86400000 ||
    Date.parse(to) > Date.now() + 60000
  )
    throw new BadRequestException('Select a past date range of up to 31 days');
  const selection = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'from' && key !== 'to'),
  );
  return { from, to, ...validateExportSelection(selection) };
}
export function validateExportSelection(body: unknown): LogExportSelection {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Archive filters are required');
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['minStatusCode', 'pathPrefix', 'consumerId'].includes(key),
    )
  )
    throw new BadRequestException('Unknown archive filter');
  const result: LogExportSelection = {};
  if (input.minStatusCode !== undefined) {
    if (
      typeof input.minStatusCode !== 'number' ||
      !Number.isInteger(input.minStatusCode) ||
      input.minStatusCode < 100 ||
      input.minStatusCode > 599
    )
      throw new BadRequestException('Minimum status must be 100–599');
    result.minStatusCode = input.minStatusCode;
  }
  if (input.pathPrefix !== undefined) {
    if (
      typeof input.pathPrefix !== 'string' ||
      !input.pathPrefix.startsWith('/') ||
      input.pathPrefix.length > 512 ||
      Array.from(input.pathPrefix).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new BadRequestException(
        'Path prefix must start with / and contain up to 512 characters',
      );
    result.pathPrefix = input.pathPrefix;
  }
  if (input.consumerId !== undefined) {
    if (typeof input.consumerId !== 'string')
      throw new BadRequestException('Invalid consumer ID');
    result.consumerId = jobId(input.consumerId);
  }
  return result;
}

@Injectable()
export class LogExportService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogExportService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickDone?: Promise<void>;
  private closing = false;
  private readonly active = new Map<
    string,
    { promise: Promise<void>; abort: AbortController }
  >();
  private readonly downloads = new Set<{
    tenantId: string;
    abort: AbortController;
    done: Promise<void>;
  }>();
  constructor(
    private readonly db: DataSource,
    private readonly storage: ObjectStorageService,
  ) {}

  onApplicationBootstrap() {
    if (!this.storage.enabled) return;
    this.timer = setInterval(() => this.scheduleTick(), 2000);
    this.timer.unref();
    this.scheduleTick();
  }
  async onModuleDestroy() {
    this.closing = true;
    clearInterval(this.timer);
    for (const download of this.downloads) download.abort.abort();
    for (const work of this.active.values()) work.abort.abort();
    await this.tickDone;
    await Promise.allSettled([...this.downloads].map((work) => work.done));
    for (const work of this.active.values()) work.abort.abort();
    await Promise.allSettled(
      [...this.active.values()].map((work) => work.promise),
    );
  }
  async list(tenantId: string): Promise<LogExportList> {
    tenantId = tenantSchema(tenantId).slice(7).replace(/_/g, '-');
    const jobs: JobRow[] = await this.db.query(
      `SELECT *,to_char(retention_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retention_cutoff FROM public.log_export_jobs WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
      [tenantId],
    );
    return {
      enabled: this.storage.enabled,
      retentionDays: this.storage.retentionDays,
      jobs: jobs.map(view),
    };
  }
  async create(tenantId: string, input: unknown): Promise<LogExportJob> {
    tenantId = tenantSchema(tenantId).slice(7).replace(/_/g, '-');
    if (!this.storage.enabled)
      throw new ServiceUnavailableException(
        'Log archives are not enabled for this installation',
      );
    const filter = validateExportFilter(input);
    return this.db.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
      );
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `log-export:${tenantId}`,
      ]);
      const [{ count }] = await manager.query(
        `SELECT COUNT(*)::integer AS count FROM public.log_export_jobs WHERE tenant_id=$1 AND status IN ('queued','processing')`,
        [tenantId],
      );
      if (count >= 20)
        throw new ConflictException(
          'Wait for your pending archives before requesting more',
        );
      const [row]: JobRow[] = await manager.query(
        `INSERT INTO public.log_export_jobs (tenant_id, filter, expires_at,privacy_policy,privacy_revision,retention_revision,retention_days,retention_from) SELECT $1,$2,NOW() + make_interval(secs => $3::integer * 86400),"logPrivacy","logPrivacyRevision","logRetentionRevision","logRetentionDays",${RETENTION_CUTOFF_SQL} FROM public.tenants WHERE id=$1 RETURNING *,to_char(retention_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retention_cutoff`,
        [tenantId, JSON.stringify(filter), this.storage.retentionDays],
      );
      return view(row);
    });
  }
  async retry(tenantId: string, id: string): Promise<LogExportJob> {
    tenantId = tenantSchema(tenantId).slice(7).replace(/_/g, '-');
    const archiveId = jobId(id);
    if (!this.storage.enabled)
      throw new ServiceUnavailableException(
        'Log archives are not enabled for this installation',
      );
    return this.db.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1000', true)`,
      );
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `log-export:${tenantId}`,
      ]);
      const [row]: JobRow[] = await manager.query(
        `SELECT * FROM public.log_export_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
        [archiveId, tenantId],
      );
      if (!row) throw new NotFoundException('Archive not found');
      const [{ eligible }]: Array<{ eligible: boolean }> = await manager.query(
        `SELECT status='failed' AND expires_at>clock_timestamp() AS eligible FROM public.log_export_jobs WHERE id=$1`,
        [archiveId],
      );
      if (!eligible)
        throw new ConflictException(
          'Only failed, unexpired archives can be retried',
        );
      const [{ pending }]: Array<{ pending: number }> = await manager.query(
        `SELECT COUNT(*)::integer AS pending FROM public.log_export_jobs WHERE tenant_id=$1 AND status IN ('queued','processing')`,
        [tenantId],
      );
      if (pending >= 20)
        throw new ConflictException(
          'Wait for your pending archives before retrying',
        );
      const [queued]: JobRow[] = await manager.query(
        `WITH retried AS (UPDATE public.log_export_jobs SET status='queued',attempts=0,retry_count=retry_count+1,error=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 RETURNING *) SELECT *,to_char(retention_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retention_cutoff FROM retried`,
        [archiveId],
      );
      return view(queued);
    });
  }
  private async eligibleDownload(
    tenantId: string,
    id: string,
  ): Promise<JobRow | undefined> {
    return this.db.transaction(async (manager) => {
      await manager.query(
        `SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'`,
      );
      const [row]: JobRow[] = await manager.query(
        `SELECT j.* FROM public.log_export_jobs j JOIN public.tenants t ON t.id=j.tenant_id WHERE j.id=$1 AND j.tenant_id=$2 AND j.status='completed' AND j.expires_at>clock_timestamp() AND j.privacy_revision=t."logPrivacyRevision" AND j.retention_revision=t."logRetentionRevision"`,
        [id, tenantId],
      );
      return row;
    });
  }
  async download(tenantId: string, id: string): Promise<Readable> {
    tenantId = tenantSchema(tenantId).slice(7).replace(/_/g, '-');
    id = jobId(id);
    if (
      this.closing ||
      this.downloads.size >= 8 ||
      [...this.downloads].filter((d) => d.tenantId === tenantId).length >= 2
    )
      throw new ServiceUnavailableException(
        'Archive downloads are busy. Try again shortly.',
      );
    const abort = new AbortController();
    let resolveDone!: () => void;
    const work = {
      tenantId,
      abort,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    };
    this.downloads.add(work);
    let source: Readable | undefined;
    let output: Readable | undefined;
    let checking: Promise<void> | undefined;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => abort.abort(), DEADLINE_MS);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(timer);
      const sourceDone =
        source && !source.closed
          ? new Promise<void>((resolve) => source?.once('close', resolve))
          : Promise.resolve();
      abort.abort();
      source?.destroy();
      void Promise.allSettled([checking, sourceDone]).finally(() => {
        this.downloads.delete(work);
        resolveDone();
      });
    };
    const cancel = () => {
      source?.destroy();
      output?.destroy(
        new Error('Archive download revoked, cancelled or timed out'),
      );
    };
    abort.signal.addEventListener('abort', cancel, { once: true });
    try {
      const row = await this.eligibleDownload(tenantId, id);
      if (!row?.object_key)
        throw new NotFoundException('Archive is not ready or has expired');
      if (abort.signal.aborted) throw new Error('Download cancelled');
      source = await this.storage.download(row.object_key, abort.signal);
      source.on('error', () => undefined);
      if (abort.signal.aborted) throw new Error('Download cancelled');
      // Recheck after storage admission: policy may have changed during GetObject.
      if (!(await this.eligibleDownload(tenantId, id)))
        throw new NotFoundException('Archive is not ready or has expired');
      if (abort.signal.aborted) throw new Error('Download cancelled');
      const body = source;
      output = Readable.from(
        (async function* () {
          for await (const chunk of body) {
            if (abort.signal.aborted) throw new Error('Download cancelled');
            yield chunk;
          }
        })(),
      );
      output.on('error', () => undefined);
      output.once('close', finish);
      timer = setInterval(() => {
        if (checking || finished) return;
        checking = this.eligibleDownload(tenantId, id)
          .then((row) => {
            if (!row) abort.abort();
          })
          .catch(() => abort.abort())
          .finally(() => {
            checking = undefined;
          });
      }, 1000);
      timer.unref();
      return output;
    } catch (error) {
      finish();
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        'Archive download is temporarily unavailable. Please try again.',
      );
    }
  }

  /** One atomic claim per worker. A lease ID fences old workers from completing
   * a reclaimed job; each attempt writes to a different private object key. */
  async claim(): Promise<JobRow | undefined> {
    return this.db.transaction('READ COMMITTED', async (manager) => {
      const [candidate]: JobRow[] = await manager.query(
        `SELECT j.* FROM public.log_export_jobs j
        WHERE j.expires_at>NOW() AND j.attempts<$1 AND
          (j.status='queued' OR (j.status='processing' AND j.lease_until<NOW()))
          AND NOT EXISTS (SELECT 1 FROM public.log_export_jobs active
            WHERE active.tenant_id=j.tenant_id AND active.status='processing' AND active.lease_until>NOW())
        ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
        [MAX_ATTEMPTS],
      );
      if (!candidate) return undefined;
      const [{ locked }] = await manager.query(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        [`log-export-worker:${candidate.tenant_id}`],
      );
      if (!locked) return undefined;
      // A fresh READ COMMITTED snapshot after the tenant lock prevents two
      // replicas from starting different queued jobs for the same tenant.
      const active = await manager.query(
        `SELECT 1 FROM public.log_export_jobs WHERE tenant_id=$1 AND status='processing' AND lease_until>NOW() LIMIT 1`,
        [candidate.tenant_id],
      );
      if (active.length) return undefined;
      const [claimed]: JobRow[] = await manager.query(
        `WITH claimed AS (
        UPDATE public.log_export_jobs SET status='processing',attempts=attempts+1,
          lease_id=$2,lease_until=NOW()+$3 * INTERVAL '1 second',error=NULL
        WHERE id=$1 RETURNING *
      ) SELECT * FROM claimed`,
        [candidate.id, randomUUID(), LEASE_SECONDS],
      );
      return claimed;
    });
  }
  private scheduleTick() {
    if (this.ticking || this.closing) return;
    this.tickDone = this.tick();
  }
  private async tick() {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      await this.cleanupExpired();
      await this.db.query(
        `UPDATE public.log_export_jobs SET status='failed', error='Export could not finish after three attempts', lease_id=NULL, lease_until=NULL WHERE status='processing' AND lease_until<NOW() AND attempts >= $1`,
        [MAX_ATTEMPTS],
      );
      while (!this.closing && this.active.size < 2) {
        const row = await this.claim();
        if (!row) break;
        const abort = new AbortController();
        const promise = this.process(row, abort)
          .catch(() =>
            this.logger.warn(
              'Archive worker failed; lease recovery will retry it',
            ),
          )
          .finally(() => this.active.delete(row.id));
        this.active.set(row.id, { promise, abort });
      }
    } catch {
      this.logger.warn('Archive queue is temporarily unavailable');
    } finally {
      this.ticking = false;
    }
  }
  async process(row: JobRow, abort = new AbortController()) {
    const prefix = `tenants/${row.tenant_id}/log-exports/${row.id}/`;
    const key = `${prefix}${row.lease_id}.ndjson`;
    const query = this.db.createQueryRunner();
    let rows = 0;
    let bytes = 0;
    const deadline = setTimeout(() => abort.abort(), DEADLINE_MS);
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.db
        .query(
          `WITH renewed AS (UPDATE public.log_export_jobs SET lease_until=NOW()+$3 * INTERVAL '1 second' WHERE id=$1 AND lease_id=$2 AND status='processing' AND expires_at>NOW() RETURNING id) SELECT * FROM renewed`,
          [row.id, row.lease_id, LEASE_SECONDS],
        )
        .then((result) => {
          if (!result.length) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewing = false;
        });
    }, 10000);
    try {
      await query.connect();
      await query.startTransaction('REPEATABLE READ');
      await query.query('SET TRANSACTION READ ONLY');
      await query.query(`SET LOCAL statement_timeout = '5s'`);
      const schema = tenantSchema(row.tenant_id);
      const profile = await retentionProfile(query, row.tenant_id);
      if (profile.logRetentionRevision !== row.retention_revision)
        throw new Error('Archive retention policy changed');
      // Capture the actual processing cutoff, including age accrued while queued.
      const covered = await this.db.transaction(async (manager) => {
        await manager.query(
          "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
        );
        return manager.query(
          `WITH covered AS (UPDATE public.log_export_jobs SET retention_from=$3::timestamptz WHERE id=$1 AND lease_id=$2 AND status='processing' AND expires_at>clock_timestamp() AND retention_revision=$4::uuid RETURNING id) SELECT * FROM covered`,
          [row.id, row.lease_id, profile.cutoff, profile.logRetentionRevision],
        );
      });
      if (!covered.length) throw new Error('Archive lease lost');
      const params: unknown[] = [
        row.filter.from,
        row.filter.to,
        profile.cutoff,
      ];
      const timeColumn =
        row.time_basis === 'receipt' ? '"receivedAt"' : 'timestamp';
      const conditions = [
        `${timeColumn} >= $1::timestamptz`,
        `${timeColumn} < $2::timestamptz`,
        '"receivedAt">=$3::timestamptz',
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
        conditions.push(`"consumerId"=$${params.length}`);
      }
      let cursor: { timestamp: string; id: string } | undefined;
      const stream = Readable.from(
        (async function* () {
          while (true) {
            if (abort.signal.aborted)
              throw new Error('Archive deadline or lease lost');
            const pageParams = [...params];
            let cursorCondition = '';
            if (cursor) {
              pageParams.push(cursor.timestamp, cursor.id);
              cursorCondition = `AND (${timeColumn},id)>($${pageParams.length - 1}::timestamptz,$${pageParams.length}::uuid)`;
            }
            const page = (await query.query(
              `SELECT *, to_char(${timeColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS export_cursor, to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS export_timestamp FROM ${schema}.request_logs WHERE ${conditions.join(' AND ')} ${cursorCondition} ORDER BY ${timeColumn},id LIMIT ${BATCH_ROWS}`,
              pageParams,
            )) as Array<Record<string, unknown>>;
            if (!page.length) break;
            for (const log of page) {
              cursor = {
                timestamp: String(log.export_cursor),
                id: String(log.id),
              };
              log.timestamp = log.export_timestamp;
              delete log.export_timestamp;
              delete log.export_cursor;
              delete log.receivedAt;
              const line =
                JSON.stringify(redactRequestLog(log, row.privacy_policy)) +
                '\n';
              rows++;
              bytes += Buffer.byteLength(line);
              if (rows > MAX_ROWS || bytes > MAX_BYTES)
                throw new Error('Archive exceeds export limits');
              yield line;
            }
          }
        })(),
      );
      await this.storage.upload(key, stream, abort.signal);
      await query.commitTransaction();
      if (abort.signal.aborted)
        throw new Error('Archive lease or deadline lost');
      const completed = await this.db.query(
        `WITH done AS (UPDATE public.log_export_jobs SET status='completed', object_key=$3, row_count=$4, bytes=$5, completed_at=NOW(), lease_id=NULL, lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='processing' AND expires_at>NOW() RETURNING id) SELECT * FROM done`,
        [row.id, row.lease_id, key, rows, bytes],
      );
      if (!completed.length) await this.storage.remove(key);
    } catch {
      if (query.isTransactionActive)
        await query.rollbackTransaction().catch(() => undefined);
      await this.storage.remove(key).catch(() => undefined);
      await this.db.query(
        `UPDATE public.log_export_jobs SET status=CASE WHEN attempts < $3 THEN 'queued' ELSE 'failed' END, error='Export could not finish. Retry or use a smaller date range.', lease_id=NULL, lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='processing'`,
        [row.id, row.lease_id, MAX_ATTEMPTS],
      );
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      await query.release();
    }
  }
  async cleanupExpired() {
    const expired: JobRow[] = await this.db.query(`WITH candidates AS (
      SELECT id FROM public.log_export_jobs WHERE expires_at<NOW() AND (cleanup_at IS NULL OR cleanup_at<NOW()) ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 5
    ), expired AS (UPDATE public.log_export_jobs j SET status='expired', lease_id=NULL, lease_until=NULL, cleanup_at=NOW()+INTERVAL '1 hour' FROM candidates c WHERE j.id=c.id RETURNING j.*) SELECT * FROM expired`);
    for (const row of expired) {
      if (this.closing) break;
      try {
        await this.storage.cleanup(
          `tenants/${row.tenant_id}/log-exports/${row.id}/`,
        );
        await this.db.query(
          `DELETE FROM public.log_export_jobs WHERE id=$1 AND status='expired' AND expires_at<NOW()-INTERVAL '720 hours'`,
          [row.id],
        );
      } catch {
        await this.db.query(
          `UPDATE public.log_export_jobs SET cleanup_at=NOW()+INTERVAL '1 minute' WHERE id=$1`,
          [row.id],
        );
      }
    }
  }
}
