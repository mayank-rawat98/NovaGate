import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import {
  logPrivacyPolicy,
  redactRequestLog,
  validateLogPrivacy,
  type LogExportDelivery,
  type LogExportDeliveryBatch,
  type LogExportDestinationCredentials,
  type LogExportDestinationType,
  type LogExportRecord,
  type LogPrivacyPolicy,
  type LogExportDeliverySchedule,
  type SaveLogExportDeliverySchedule,
  type LogExportCadence,
  type LogExportSelection,
  type LogExportDeliveryHistory,
  type LogExportDeliveryState,
} from '@api-gateway/shared-types';
import {
  encodeExportRecord,
  exportDeliveryBody,
} from './export-delivery-encoding';
import { validateExportSelection } from './log-export.service';
import {
  REVOKE_DESTINATION_DELIVERIES_SQL,
  RECORD_PRUNED_SCHEDULED_HISTORY_SQL,
} from './export-delivery-schema';
import { OutboundHttpError } from '../shared/outbound-http';
import { tenantSchema } from '../tenants/tenant-schema';
import { RETENTION_CUTOFF_SQL } from '../log-retention/log-retention.policy';
import { outboundTrustedOrigins } from '../shared/outbound-egress-policy';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';
import { EXPORT_DESTINATION_LIMIT } from './export-destinations.service';
import {
  destinationCredentials,
  destinationRecord,
  destinationUuid,
} from './export-destination-input';
import {
  exportDeliveryRecords,
  EXPORT_MAX_RECORDS,
  EXPORT_MAX_BODY_BYTES,
} from './export-delivery-payload';

export const EXPORT_DELIVERY_QUEUE_LIMIT = 20;
export const EXPORT_DELIVERY_HISTORY_LIMIT = 1000;
export const EXPORT_SCHEDULED_TERMINAL_HISTORY_LIMIT = 1000;
export const EXPORT_SCHEDULED_DELIVERY_LIMIT =
  EXPORT_SCHEDULED_TERMINAL_HISTORY_LIMIT +
  EXPORT_DESTINATION_LIMIT * EXPORT_DELIVERY_QUEUE_LIMIT;
export const EXPORT_DELIVERY_MAX_ATTEMPTS = 6;
export const EXPORT_DELIVERY_LEASE_SECONDS = 30;
const RETRY_SECONDS = [5, 30, 120, 600, 1800];
export const EXPORT_RECEIPT_SETTLEMENT_SECONDS = 15;
// Return at most max characters + 1, then validate UTF-8 bytes. Valid values are
// unchanged; retained oversized values still fail rather than shipping a prefix.
const SOURCE_COLUMNS = `id,LEFT(method,33) AS method,LEFT(path,4097) AS path,"statusCode","responseTimeMs",
  LEFT("requestId",37) AS "requestId",LEFT("clientIp",65) AS "clientIp",LEFT("userAgent",2049) AS "userAgent",
  LEFT("downstreamService",257) AS "downstreamService","downstreamLatencyMs","consumerId",
  LEFT("traceId",33) AS "traceId",LEFT("spanId",17) AS "spanId",LEFT("errorCode",129) AS "errorCode",
  to_char(timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp,
  to_char("receivedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS receipt`;
interface DeliveryScheduleRow {
  destination_id: string;
  revision: string;
  enabled: boolean;
  cadence: LogExportCadence;
  filter: LogExportSelection;
  payload_privacy: LogPrivacyPolicy;
  started: string;
  cursor: string;
  cursor_id: string | null;
  next_window: string;
  last_checked_at: Date | null;
  admitted_records: string;
  filtered_records: string;
  invalid_records: string;
  retention_skipped_seconds: number;
  error: string | null;
}
const SCHEDULE_COLUMNS = `s.*,
  to_char(s.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started,
  to_char(s.cursor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor,
  to_char((date_bin(CASE WHEN s.cadence='hourly' THEN INTERVAL '1 hour' ELSE INTERVAL '1 minute' END,
    s.cursor_at,'1970-01-01T00:00:00Z'::timestamptz)+
    CASE WHEN s.cadence='hourly' THEN INTERVAL '1 hour' ELSE INTERVAL '1 minute' END)
    AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS next_window`;
export interface ExportDeliveryTarget {
  tenantId: string;
  destinationId: string;
}
function cadenceInterval(cadence: LogExportCadence) {
  return cadence === 'hourly' ? '1 hour' : '1 minute';
}
function scheduleView(
  row: DeliveryScheduleRow,
  destinationRevision: string,
): LogExportDeliverySchedule {
  return {
    destinationId: row.destination_id,
    destinationRevision,
    revision: row.revision,
    enabled: row.enabled,
    cadence: row.cadence,
    filter: row.filter,
    payloadPrivacy: row.payload_privacy,
    startedAt: row.started,
    cursor: row.cursor,
    nextWindowAt: row.next_window,
    lastCheckedAt: row.last_checked_at?.toISOString(),
    admittedRecords: Number(row.admitted_records),
    filteredRecords: Number(row.filtered_records),
    invalidRecords: Number(row.invalid_records),
    retentionSkippedSeconds: row.retention_skipped_seconds,
    error: row.error ?? undefined,
  };
}
const ERRORS = new Set([
  'configuration',
  'invalid_payload',
  'blocked_destination',
  'dns_failed',
  'timeout',
  'cancelled',
  'connection_failed',
  'response_too_large',
  'redirect_refused',
  'http_client_error',
  'http_retryable',
  'busy',
  'credentials_unavailable',
]);
const HISTORY_COLUMNS = `id,destination_id,is_scheduled,status,attempts,record_count,created_at,
expires_at,completed_at,next_attempt_at,error`;
const ELIGIBLE_SQL = `d.tenant_id=j.tenant_id AND d.deleted_at IS NULL AND d.revision=j.destination_revision
AND t."logPrivacyRevision"=j.privacy_revision AND t."logRetentionRevision"=j.retention_revision
AND j.expires_at>clock_timestamp()
AND j.receipt_from>=GREATEST(t."logRetentionFloor",clock_timestamp()-make_interval(secs=>t."logRetentionDays"::integer*86400))`;
type SourceRow = LogExportRecord & { timestamp: string; receipt: string };
interface DeliveryRow {
  id: string;
  destination_id: string;
  is_scheduled: boolean;
  status: LogExportDelivery['status'];
  attempts: number;
  record_count: number;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  next_attempt_at: Date;
  error: string | null;
  source_ids: string[];
  payload_privacy: LogPrivacyPolicy;
  payload: LogExportDeliveryBatch;
  lease_id: string;
}
interface Snapshot {
  logPrivacy: unknown;
  logPrivacyRevision: string;
  logRetentionRevision: string;
  logRetentionDays: number;
  cutoff: string;
}
interface Destination {
  revision: string;
  type: LogExportDestinationType;
  credentials: unknown;
}
/** Private worker material. It must never be returned by an HTTP controller. */
export interface ExportDeliveryLease {
  id: string;
  leaseId: string;
  attempts: number;
  batch: LogExportDeliveryBatch;
  credentials: LogExportDestinationCredentials;
}
function view(row: DeliveryRow): LogExportDelivery {
  return {
    id: row.id,
    destinationId: row.destination_id,
    source: row.is_scheduled ? 'scheduled' : 'selected_records',
    status: row.status,
    attempts: row.attempts,
    recordCount: row.record_count,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    nextAttemptAt: row.next_attempt_at.toISOString(),
    error: row.error ?? undefined,
  };
}

/** Internal receipt admission/configuration; the scheduler owns the timer.
 * Every transaction locks tenant -> destination -> batch, matching revocation writes. */
@Injectable()
export class ExportDeliveryStoreService implements OnModuleDestroy {
  private readonly cipher: ExportDestinationCredentialCipher;
  private readonly trustedOrigins: ReadonlySet<string>;
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;
  get configurationAvailable() {
    return this.cipher.enabled;
  }
  constructor(
    private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.cipher = new ExportDestinationCredentialCipher({
      LOG_EXPORT_DESTINATION_KEYS: config.get('LOG_EXPORT_DESTINATION_KEYS'),
      LOG_EXPORT_DESTINATION_ACTIVE_KEY: config.get(
        'LOG_EXPORT_DESTINATION_ACTIVE_KEY',
      ),
    });
    this.trustedOrigins = outboundTrustedOrigins(
      config.get('LOG_EXPORT_HTTP_TRUSTED_ORIGINS'),
      'LOG_EXPORT_HTTP_TRUSTED_ORIGINS',
    );
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
    this.cipher.destroy();
  }
  private tenant(value: string) {
    return tenantSchema(value).slice(7).replace(/_/g, '-');
  }
  private async transaction<T>(
    operation: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (this.stopping || this.pending.size >= 8)
      throw new ServiceUnavailableException(
        'External log delivery is busy. Try again shortly.',
      );
    const work = this.db.transaction(async (manager) => {
      await manager.query(
        "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
      );
      return operation(manager);
    });
    this.pending.add(work);
    try {
      return await work;
    } catch (error) {
      if (error instanceof QueryFailedError) {
        if ((error.driverError as { code?: unknown }).code === '23505')
          throw new ConflictException(
            'The delivery identifier is already in use.',
          );
        throw new ServiceUnavailableException(
          'External log delivery storage is unavailable.',
        );
      }
      throw error;
    } finally {
      this.pending.delete(work);
    }
  }
  private async snapshot(
    manager: EntityManager,
    tenant: string,
    destination: string,
    writable = false,
  ) {
    // SHARE conflicts with privacy/retention NO KEY UPDATE, while preserving FK admission.
    const [policy]: Snapshot[] = await manager.query(
      `SELECT "logPrivacy","logPrivacyRevision","logRetentionRevision","logRetentionDays",
       to_char(${RETENTION_CUTOFF_SQL} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff
       FROM public.tenants WHERE id=$1 FOR SHARE`,
      [tenant],
    );
    if (!policy) throw new NotFoundException('Workspace not found.');
    const [connection]: Destination[] = await manager.query(
      `SELECT revision,type,credentials FROM public.log_export_destinations
       WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR ${writable ? 'UPDATE' : 'SHARE'}`,
      [tenant, destination],
    );
    return { policy, connection };
  }
  private async expire(
    manager: EntityManager,
    tenant: string,
    destination: string,
  ) {
    await manager.query(
      `UPDATE public.log_export_deliveries j SET status='expired',payload=NULL,lease_id=NULL,
       lease_until=NULL,completed_at=clock_timestamp(),error='policy_changed'
       FROM public.tenants t,public.log_export_destinations d
       WHERE j.tenant_id=$1 AND j.destination_id=$2 AND t.id=j.tenant_id AND d.id=j.destination_id
       AND j.status IN ('queued','processing') AND NOT (${ELIGIBLE_SQL})`,
      [tenant, destination],
    );
  }
  /** Read trusted rows rather than accepting caller-supplied log data or receipt timestamps. */
  async admit(
    tenantId: string,
    destinationId: string,
    deliveryId: string,
    recordIds: string[],
    payloadPrivacy: LogPrivacyPolicy = {
      clientIp: 'retain',
      userAgent: 'retain',
    },
  ): Promise<LogExportDelivery> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId),
      id = destinationUuid(deliveryId);
    if (
      !Array.isArray(recordIds) ||
      !recordIds.length ||
      recordIds.length > EXPORT_MAX_RECORDS
    )
      throw new BadRequestException(
        'Select between 1 and 256 retained log records.',
      );
    const ids = recordIds.map(destinationUuid).sort();
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('Log records must be unique.');
    let privacy: LogPrivacyPolicy;
    try {
      privacy = validateLogPrivacy(payloadPrivacy);
    } catch {
      throw new BadRequestException(
        'Use a supported destination payload policy.',
      );
    }
    return this.transaction(async (manager) => {
      const { policy, connection } = await this.snapshot(
        manager,
        tenant,
        destination,
      );
      if (!connection)
        throw new NotFoundException('Export destination not found.');
      // This lock makes hard queue/history admission atomic across independent replicas.
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`export-delivery-admission:${tenant}`],
      );
      const [existing]: DeliveryRow[] = await manager.query(
        'SELECT * FROM public.log_export_deliveries WHERE id=$1',
        [id],
      );
      if (existing) {
        // A global UUID collision reveals no other tenant's history or payload.
        const [owned]: DeliveryRow[] = await manager.query(
          'SELECT * FROM public.log_export_deliveries WHERE id=$1 AND tenant_id=$2 AND destination_id=$3',
          [id, tenant, destination],
        );
        if (
          !owned ||
          JSON.stringify(owned.source_ids) !== JSON.stringify(ids) ||
          JSON.stringify(validateLogPrivacy(owned.payload_privacy)) !==
            JSON.stringify(privacy)
        )
          throw new ConflictException(
            'The delivery identifier is already in use.',
          );
        return view(owned);
      }
      await this.expire(manager, tenant, destination);
      const [{ total, pending }]: Array<{ total: number; pending: number }> =
        await manager.query(
          `SELECT COUNT(*) FILTER (WHERE NOT is_scheduled)::integer AS total,COUNT(*) FILTER (WHERE destination_id=$2 AND status IN ('queued','processing'))::integer AS pending
         FROM public.log_export_deliveries WHERE tenant_id=$1`,
          [tenant, destination],
        );
      if (
        total >= EXPORT_DELIVERY_HISTORY_LIMIT ||
        pending >= EXPORT_DELIVERY_QUEUE_LIMIT
      )
        throw new ConflictException(
          'The external delivery queue or retained history is full.',
        );
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`log-receipt:${tenant}`],
      );
      const rows: Array<
        LogExportRecord & { timestamp: string; receipt: string }
      > = await manager.query(
        `SELECT ${SOURCE_COLUMNS}
         FROM ${tenantSchema(tenant)}.request_logs WHERE id=ANY($1::uuid[]) AND "receivedAt">=$2::timestamptz
         ORDER BY "receivedAt",id`,
        [ids, policy.cutoff],
      );
      if (rows.length !== ids.length)
        throw new ConflictException(
          'Some selected logs are missing or expired.',
        );
      return this.insertBatch(
        manager,
        tenant,
        destination,
        id,
        ids,
        privacy,
        policy,
        connection,
        rows,
      );
    });
  }
  private async insertBatch(
    manager: EntityManager,
    tenant: string,
    destination: string,
    id: string,
    ids: string[],
    privacy: LogPrivacyPolicy,
    policy: Snapshot,
    connection: Destination,
    rows: SourceRow[],
    prepared?: LogExportRecord[],
    scheduleId?: string,
  ): Promise<LogExportDelivery> {
    const batch: LogExportDeliveryBatch = {
      version: 1,
      tenantId: tenant,
      destinationId: destination,
      deliveryId: id,
      records: rows.map(
        (row) =>
          Object.fromEntries(
            Object.entries(row).filter(([, value]) => value !== null),
          ) as unknown as LogExportRecord,
      ),
      privacy: logPrivacyPolicy(policy.logPrivacy),
      payloadPrivacy: privacy,
    };
    batch.records =
      prepared ??
      exportDeliveryRecords(
        batch,
        new AbortController().signal,
        performance.now() + 1000,
      );
    exportDeliveryBody(connection.type, batch);
    const [saved]: DeliveryRow[] = await manager.query(
      `INSERT INTO public.log_export_deliveries
        (id,tenant_id,destination_id,destination_revision,privacy_revision,retention_revision,source_ids,payload_privacy,receipt_from,payload,record_count,schedule_id,is_scheduled,created_at,next_attempt_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8::jsonb,$9::timestamptz,$10::jsonb,$11,$13::uuid,$13::uuid IS NOT NULL,clock_timestamp(),clock_timestamp(),
          LEAST(clock_timestamp()+INTERVAL '24 hours',$9::timestamptz+make_interval(secs=>$12::integer*86400))) RETURNING *`,
      [
        id,
        tenant,
        destination,
        connection.revision,
        policy.logPrivacyRevision,
        policy.logRetentionRevision,
        ids,
        JSON.stringify(privacy),
        rows[0].receipt,
        JSON.stringify(batch),
        rows.length,
        policy.logRetentionDays,
        scheduleId ?? null,
      ],
    );
    return view(saved);
  }
  private async scheduleRow(
    manager: EntityManager,
    tenant: string,
    destination: string,
    lock = false,
  ): Promise<DeliveryScheduleRow | undefined> {
    const [row]: DeliveryScheduleRow[] = await manager.query(
      `SELECT ${SCHEDULE_COLUMNS} FROM public.log_export_delivery_schedules s
       WHERE s.tenant_id=$1 AND s.destination_id=$2 ${lock ? 'FOR UPDATE SKIP LOCKED' : ''}`,
      [tenant, destination],
    );
    return row;
  }
  async getSchedule(
    tenantId: string,
    destinationId: string,
  ): Promise<LogExportDeliverySchedule | null> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    return this.transaction(async (manager) => {
      const { connection } = await this.snapshot(manager, tenant, destination);
      if (!connection)
        throw new NotFoundException('Export destination not found.');
      const row = await this.scheduleRow(manager, tenant, destination);
      return row ? scheduleView(row, connection.revision) : null;
    });
  }
  /** Display-safe configuration and bounded pending counts; no provider probe. */
  async deliveryState(
    tenantId: string,
    destinationId: string,
  ): Promise<LogExportDeliveryState> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    return this.transaction(async (manager) => {
      const { policy, connection } = await this.snapshot(
        manager,
        tenant,
        destination,
      );
      if (!connection)
        throw new NotFoundException('Export destination not found.');
      let credentialStatus: LogExportDeliveryState['credentialStatus'] =
        'available';
      try {
        const credentials = destinationCredentials(
          this.cipher.decrypt(
            tenant,
            destination,
            connection.type,
            connection.credentials,
          ),
          this.trustedOrigins,
        ).credentials;
        if (credentials.type !== connection.type) throw new Error();
      } catch {
        credentialStatus = 'unavailable';
      }
      const schedule = await this.scheduleRow(manager, tenant, destination);
      const [counts]: Array<{ pending: number; processing: number }> =
        await manager.query(
          `SELECT COUNT(*) FILTER(WHERE status IN('queued','processing'))::integer AS pending,
        COUNT(*) FILTER(WHERE status='processing')::integer AS processing FROM public.log_export_deliveries WHERE tenant_id=$1 AND destination_id=$2`,
          [tenant, destination],
        );
      return {
        available:
          this.configurationAvailable && credentialStatus === 'available',
        credentialStatus,
        destinationRevision: connection.revision,
        schedule: schedule ? scheduleView(schedule, connection.revision) : null,
        tenantPrivacy: logPrivacyPolicy(policy.logPrivacy),
        retentionDays: policy.logRetentionDays,
        receiptFloor: policy.cutoff,
        pendingBatches: counts.pending,
        processingBatches: counts.processing,
        limits: {
          pendingBatches: EXPORT_DELIVERY_QUEUE_LIMIT,
          settlementSeconds: EXPORT_RECEIPT_SETTLEMENT_SECONDS,
          maxAttempts: EXPORT_DELIVERY_MAX_ATTEMPTS,
          payloadLifetimeHours: 24,
        },
      };
    });
  }
  /** Only an explicit revision-aware write enables source admission. */
  async saveSchedule(
    tenantId: string,
    destinationId: string,
    body: unknown,
  ): Promise<LogExportDeliverySchedule> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    const input = destinationRecord(body, [
      'enabled',
      'cadence',
      'filter',
      'payloadPrivacy',
      'expectedRevision',
      'expectedDestinationRevision',
    ]);
    if (
      typeof input.enabled !== 'boolean' ||
      !['near_real_time', 'hourly'].includes(input.cadence as string)
    )
      throw new BadRequestException(
        'Select a supported delivery cadence and pause setting.',
      );
    let privacy: LogPrivacyPolicy;
    try {
      privacy = validateLogPrivacy(input.payloadPrivacy);
    } catch {
      throw new BadRequestException(
        'Use a supported destination payload policy.',
      );
    }
    const settings: SaveLogExportDeliverySchedule = {
      enabled: input.enabled,
      cadence: input.cadence as LogExportCadence,
      filter: validateExportSelection(input.filter),
      payloadPrivacy: privacy,
      expectedRevision:
        input.expectedRevision === null
          ? null
          : destinationUuid(input.expectedRevision),
      expectedDestinationRevision: destinationUuid(
        input.expectedDestinationRevision,
      ),
    };
    if (settings.enabled && !this.configurationAvailable)
      throw new ServiceUnavailableException(
        'External delivery configuration is unavailable.',
      );
    return this.transaction(async (manager) => {
      const { policy, connection } = await this.snapshot(
        manager,
        tenant,
        destination,
        true,
      );
      if (!connection)
        throw new NotFoundException('Export destination not found.');
      if (connection.revision !== settings.expectedDestinationRevision)
        throw new ConflictException(
          'The export destination changed. Refresh before saving.',
        );
      const [current]: DeliveryScheduleRow[] = await manager.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM public.log_export_delivery_schedules s WHERE tenant_id=$1 AND destination_id=$2 FOR UPDATE`,
        [tenant, destination],
      );
      if ((current?.revision ?? null) !== settings.expectedRevision)
        throw new ConflictException(
          'Delivery settings changed. Refresh before saving.',
        );
      if (settings.enabled)
        try {
          const credentials = destinationCredentials(
            this.cipher.decrypt(
              tenant,
              destination,
              connection.type,
              connection.credentials,
            ),
            this.trustedOrigins,
          ).credentials;
          if (credentials.type !== connection.type) throw new Error();
        } catch {
          throw new ServiceUnavailableException(
            'Export destination credentials are unavailable.',
          );
        }
      const hidden = logPrivacyPolicy(policy.logPrivacy).redactedFields ?? [];
      if (
        settings.enabled &&
        ((settings.filter.pathPrefix !== undefined &&
          hidden.includes('path')) ||
          (settings.filter.consumerId !== undefined &&
            hidden.includes('consumerId')))
      )
        throw new BadRequestException(
          'Stored privacy omits a field used by this delivery filter.',
        );
      if (!current)
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`log-receipt:${tenant}`],
        );
      // Payload changes invalidate old projected bytes; cadence/filter/pause keep admitted work.
      if (
        !current ||
        JSON.stringify(validateLogPrivacy(current.payload_privacy)) !==
          JSON.stringify(privacy)
      ) {
        connection.revision = randomUUID();
        await manager.query(
          'UPDATE public.log_export_destinations SET revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
          [tenant, destination, connection.revision],
        );
        await manager.query(REVOKE_DESTINATION_DELIVERIES_SQL, [
          tenant,
          destination,
        ]);
      }
      await manager.query(
        `INSERT INTO public.log_export_delivery_schedules
        (destination_id,tenant_id,revision,enabled,cadence,filter,payload_privacy,started_at,cursor_at,cursor_id,next_due_at)
        SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,COALESCE($8::timestamptz,saved),COALESCE($9::timestamptz,saved),
          CASE WHEN $10 THEN $11::uuid ELSE 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid END,
          date_bin($12::interval,COALESCE($9::timestamptz,saved),'1970-01-01T00:00:00Z'::timestamptz)+$12::interval+make_interval(secs=>$13)
        FROM (SELECT clock_timestamp() AS saved) initial
        ON CONFLICT (destination_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,cadence=EXCLUDED.cadence,
          filter=EXCLUDED.filter,payload_privacy=EXCLUDED.payload_privacy,next_due_at=EXCLUDED.next_due_at,last_checked_at=NULL,error=NULL`,
        [
          destination,
          tenant,
          randomUUID(),
          settings.enabled,
          settings.cadence,
          JSON.stringify(settings.filter),
          JSON.stringify(privacy),
          current?.started ?? null,
          current?.cursor ?? null,
          !!current,
          current?.cursor_id ?? null,
          cadenceInterval(settings.cadence),
          EXPORT_RECEIPT_SETTLEMENT_SECONDS,
        ],
      );
      const saved = await this.scheduleRow(manager, tenant, destination);
      if (!saved) throw new Error('Delivery settings were not persisted.');
      return scheduleView(saved, connection.revision);
    });
  }
  async removeSchedule(
    tenantId: string,
    destinationId: string,
    body: unknown,
  ): Promise<{ removed: true }> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    const input = destinationRecord(body, [
      'expectedRevision',
      'expectedDestinationRevision',
    ]);
    const expected = destinationUuid(input.expectedRevision),
      expectedDestination = destinationUuid(input.expectedDestinationRevision);
    return this.transaction(async (manager) => {
      const { connection } = await this.snapshot(
        manager,
        tenant,
        destination,
        true,
      );
      if (!connection)
        throw new NotFoundException('Export destination not found.');
      if (connection.revision !== expectedDestination)
        throw new ConflictException(
          'The export destination changed. Refresh before saving.',
        );
      const [schedule]: DeliveryScheduleRow[] = await manager.query(
        `SELECT ${SCHEDULE_COLUMNS} FROM public.log_export_delivery_schedules s WHERE tenant_id=$1 AND destination_id=$2 FOR UPDATE`,
        [tenant, destination],
      );
      if (!schedule)
        throw new NotFoundException('Delivery settings not found.');
      if (schedule.revision !== expected)
        throw new ConflictException(
          'Delivery settings changed. Refresh before saving.',
        );
      await manager.query(
        `UPDATE public.log_export_deliveries SET status='expired',payload=NULL,lease_id=NULL,lease_until=NULL,
        completed_at=clock_timestamp(),error='schedule_removed' WHERE tenant_id=$1 AND destination_id=$2 AND is_scheduled AND status IN('queued','processing')`,
        [tenant, destination],
      );
      await manager.query(
        'DELETE FROM public.log_export_delivery_schedules WHERE tenant_id=$1 AND destination_id=$2',
        [tenant, destination],
      );
      return { removed: true };
    });
  }
  /** Fair durable reservations expire after two seconds even if a replica crashes. */
  async reserveProducerTargets(): Promise<ExportDeliveryTarget[]> {
    return this.transaction((manager) =>
      manager.query(`WITH page AS (
      SELECT s.destination_id FROM public.log_export_delivery_schedules s JOIN public.log_export_destinations d ON d.id=s.destination_id AND d.tenant_id=s.tenant_id
      WHERE s.enabled AND s.next_due_at<=clock_timestamp() AND d.deleted_at IS NULL
      ORDER BY s.last_checked_at NULLS FIRST,s.next_due_at,s.destination_id LIMIT 4 FOR UPDATE OF s SKIP LOCKED
    ), reserved AS (UPDATE public.log_export_delivery_schedules s SET last_checked_at=clock_timestamp(),next_due_at=clock_timestamp()+INTERVAL '2 seconds'
      FROM page WHERE s.destination_id=page.destination_id RETURNING s.tenant_id AS "tenantId",s.destination_id AS "destinationId")
      SELECT * FROM reserved`),
    );
  }
  async reserveDeliveryTargets(
    limit = 4,
    excludedDestinationIds: string[] = [],
  ): Promise<ExportDeliveryTarget[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 4 ||
      excludedDestinationIds.length > 4
    )
      throw new BadRequestException(
        'Use a bounded external delivery discovery request.',
      );
    const excluded = excludedDestinationIds.map(destinationUuid);
    if (!limit) return [];
    return this.transaction((manager) =>
      manager.query(
        `WITH page AS (
      SELECT s.destination_id FROM public.log_export_delivery_schedules s JOIN public.log_export_destinations d ON d.id=s.destination_id AND d.tenant_id=s.tenant_id
      WHERE d.deleted_at IS NULL AND NOT (s.destination_id=ANY($1::uuid[])) AND EXISTS(SELECT 1 FROM public.log_export_deliveries j
        WHERE j.schedule_id=s.destination_id AND j.tenant_id=s.tenant_id AND j.destination_id=s.destination_id
        AND ((j.status='queued' AND j.next_attempt_at<=clock_timestamp()) OR (j.status='processing' AND j.lease_until<=clock_timestamp())))
      ORDER BY s.last_delivery_checked_at NULLS FIRST,s.destination_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED
    ), reserved AS (UPDATE public.log_export_delivery_schedules s SET last_delivery_checked_at=clock_timestamp()
      FROM page WHERE s.destination_id=page.destination_id RETURNING s.tenant_id AS "tenantId",s.destination_id AS "destinationId")
      SELECT * FROM reserved`,
        [excluded, limit],
      ),
    );
  }
  /** Source batch and microsecond keyset cursor always commit or roll back together. */
  async produceNext(tenantId: string, destinationId: string): Promise<boolean> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    return this.transaction(async (manager) => {
      const { policy, connection } = await this.snapshot(
        manager,
        tenant,
        destination,
      );
      if (!connection) return false;
      const original = await this.scheduleRow(
        manager,
        tenant,
        destination,
        true,
      );
      if (!original?.enabled) return false;
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`export-delivery-admission:${tenant}`],
      );
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`log-receipt:${tenant}`],
      );
      await this.expire(manager, tenant, destination);
      await this.compactScheduledHistory(manager, tenant);
      await manager.query(
        `UPDATE public.log_export_delivery_schedules SET
        retention_skipped_seconds=retention_skipped_seconds+EXTRACT(EPOCH FROM ($3::timestamptz-cursor_at)),
        cursor_at=$3::timestamptz,cursor_id=NULL WHERE tenant_id=$1 AND destination_id=$2 AND cursor_at<$3::timestamptz`,
        [tenant, destination, policy.cutoff],
      );
      const row = await this.scheduleRow(manager, tenant, destination);
      if (!row) throw new Error('Delivery schedule disappeared.');
      const defer = async (error: string) => {
        await manager.query(
          `UPDATE public.log_export_delivery_schedules SET error=$3,last_checked_at=clock_timestamp(),next_due_at=clock_timestamp()+INTERVAL '5 seconds' WHERE tenant_id=$1 AND destination_id=$2`,
          [tenant, destination, error],
        );
        return true;
      };
      const hidden = logPrivacyPolicy(policy.logPrivacy).redactedFields ?? [];
      if (
        (row.filter.pathPrefix !== undefined && hidden.includes('path')) ||
        (row.filter.consumerId !== undefined && hidden.includes('consumerId'))
      )
        return defer('filter_unavailable');
      const [{ pending, scheduled }]: Array<{
        pending: number;
        scheduled: number;
      }> = await manager.query(
        `SELECT COUNT(*) FILTER (WHERE destination_id=$2 AND status IN ('queued','processing'))::integer AS pending,
          COUNT(*) FILTER (WHERE is_scheduled)::integer AS scheduled FROM public.log_export_deliveries WHERE tenant_id=$1`,
        [tenant, destination],
      );
      if (pending >= EXPORT_DELIVERY_QUEUE_LIMIT) return defer('queue_full');
      // Compaction may skip terminal rows owned by concurrent cleanup. Wait for
      // that ownership to settle rather than growing beyond the automatic budget.
      if (scheduled >= EXPORT_SCHEDULED_DELIVERY_LIMIT)
        return defer('history_busy');
      const interval = cadenceInterval(row.cadence);
      const [{ ready }]: Array<{ ready: boolean }> = await manager.query(
        'SELECT $1::timestamptz+make_interval(secs=>$2)<=clock_timestamp() AS ready',
        [row.next_window, EXPORT_RECEIPT_SETTLEMENT_SECONDS],
      );
      if (!ready) {
        await manager.query(
          'UPDATE public.log_export_delivery_schedules SET next_due_at=$3::timestamptz+make_interval(secs=>$4),last_checked_at=clock_timestamp() WHERE tenant_id=$1 AND destination_id=$2',
          [
            tenant,
            destination,
            row.next_window,
            EXPORT_RECEIPT_SETTLEMENT_SECONDS,
          ],
        );
        return true;
      }
      const page: SourceRow[] = await manager.query(
        `SELECT ${SOURCE_COLUMNS} FROM ${tenantSchema(tenant)}.request_logs
        WHERE "receivedAt">=$1::timestamptz AND ("receivedAt">$2::timestamptz OR ("receivedAt"=$2::timestamptz AND ($3::uuid IS NULL OR id>$3)))
        AND "receivedAt"<$4::timestamptz ORDER BY "receivedAt",id LIMIT 257`,
        [policy.cutoff, row.cursor, row.cursor_id, row.next_window],
      );
      const id = randomUUID(),
        records: LogExportRecord[] = [],
        sources: SourceRow[] = [];
      const batch: LogExportDeliveryBatch = {
        version: 1,
        tenantId: tenant,
        destinationId: destination,
        deliveryId: id,
        records: [],
        privacy: logPrivacyPolicy(policy.logPrivacy),
        payloadPrivacy: validateLogPrivacy(row.payload_privacy),
      };
      const deadline = performance.now() + 1000,
        signal = new AbortController().signal;
      let processed = 0,
        invalid = 0,
        filtered = 0,
        bytes = connection.type === 'datadog' ? 2 : 0;
      for (const source of page.slice(0, EXPORT_MAX_RECORDS)) {
        const raw = Object.fromEntries(
          Object.entries(source).filter(([, value]) => value !== null),
        ) as unknown as LogExportRecord;
        let record: LogExportRecord;
        try {
          record = exportDeliveryRecords(
            { ...batch, records: [raw] },
            signal,
            deadline,
          )[0];
        } catch (error) {
          if (
            !(error instanceof OutboundHttpError) ||
            error.code !== 'invalid_payload'
          )
            throw error;
          invalid++;
          processed++;
          continue;
        }
        const selected = redactRequestLog(raw, policy.logPrivacy);
        if (
          (row.filter.minStatusCode !== undefined &&
            record.statusCode < row.filter.minStatusCode) ||
          (row.filter.pathPrefix !== undefined &&
            (typeof selected.path !== 'string' ||
              !selected.path.startsWith(row.filter.pathPrefix))) ||
          (row.filter.consumerId !== undefined &&
            selected.consumerId !== row.filter.consumerId)
        ) {
          filtered++;
          processed++;
          continue;
        }
        const size =
          Buffer.byteLength(
            encodeExportRecord(connection.type, batch, record),
          ) + (connection.type === 'datadog' ? (records.length ? 1 : 0) : 1);
        if (bytes + size > EXPORT_MAX_BODY_BYTES) {
          if (records.length) break;
          invalid++;
          processed++;
          continue;
        }
        bytes += size;
        records.push(record);
        sources.push(source);
        processed++;
      }
      if (records.length)
        await this.insertBatch(
          manager,
          tenant,
          destination,
          id,
          sources.map((source) => source.id).sort(),
          batch.payloadPrivacy as LogPrivacyPolicy,
          policy,
          connection,
          sources,
          records,
          destination,
        );
      const complete = processed === page.length;
      let cursor = complete ? row.next_window : page[processed - 1]?.receipt;
      const cursorId = complete ? null : page[processed - 1]?.id;
      if (!cursor) throw new Error('Receipt cursor made no progress.');
      if (!page.length) {
        const [{ empty_cursor }]: Array<{ empty_cursor: string }> =
          await manager.query(
            `SELECT to_char(GREATEST($1::timestamptz,LEAST(
          date_bin($2::interval,COALESCE((SELECT "receivedAt" FROM ${tenantSchema(tenant)}.request_logs WHERE "receivedAt">=$1::timestamptz ORDER BY "receivedAt",id LIMIT 1),clock_timestamp()-make_interval(secs=>$3)),'1970-01-01T00:00:00Z'::timestamptz),
          date_bin($2::interval,clock_timestamp()-make_interval(secs=>$3),'1970-01-01T00:00:00Z'::timestamptz))) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS empty_cursor`,
            [row.next_window, interval, EXPORT_RECEIPT_SETTLEMENT_SECONDS],
          );
        cursor = empty_cursor;
      }
      await manager.query(
        `UPDATE public.log_export_delivery_schedules SET cursor_at=$3::timestamptz,cursor_id=$4::uuid,
        next_due_at=CASE WHEN $5 THEN $3::timestamptz+$6::interval+make_interval(secs=>$7) ELSE clock_timestamp()+INTERVAL '2 seconds' END,
        last_checked_at=clock_timestamp(),admitted_records=admitted_records+$8,invalid_records=invalid_records+$9,filtered_records=filtered_records+$10,error=$11
        WHERE tenant_id=$1 AND destination_id=$2`,
        [
          tenant,
          destination,
          cursor,
          cursorId,
          complete,
          interval,
          EXPORT_RECEIPT_SETTLEMENT_SECONDS,
          records.length,
          invalid,
          filtered,
          invalid ? 'invalid_records' : null,
        ],
      );
      return true;
    });
  }
  async history(
    tenantId: string,
    destinationId: string,
  ): Promise<LogExportDelivery[]> {
    return (await this.historyState(tenantId, destinationId)).deliveries;
  }
  /** Metadata and workspace coverage share one statement snapshot; no payload/source IDs. */
  async historyState(
    tenantId: string,
    destinationId: string,
    requireDestination = false,
  ): Promise<LogExportDeliveryHistory> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    return this.transaction(async (manager) => {
      if (requireDestination) {
        const [owner] = await manager.query(
          'SELECT id FROM public.log_export_destinations WHERE tenant_id=$1 AND id=$2 FOR SHARE',
          [tenant, destination],
        );
        if (!owner)
          throw new NotFoundException('Export destination not found.');
      }
      const rows: Array<
        DeliveryRow & {
          delivered_batches: string | null;
          failed_batches: string | null;
          expired_batches: string | null;
          delivered_records: string | null;
          failed_records: string | null;
          expired_records: string | null;
          last_pruned_at: Date | null;
        }
      > = await manager.query(
        `SELECT recent.*,c.delivered_batches::text,c.failed_batches::text,c.expired_batches::text,
        c.delivered_records::text,c.failed_records::text,c.expired_records::text,c.last_pruned_at
        FROM (SELECT 1) pivot LEFT JOIN LATERAL (
          SELECT ${HISTORY_COLUMNS} FROM public.log_export_deliveries WHERE tenant_id=$1 AND destination_id=$2
          ORDER BY created_at DESC,id DESC LIMIT 50
        ) recent ON true LEFT JOIN public.log_export_delivery_history_totals c ON c.tenant_id=$1
        ORDER BY recent.created_at DESC,recent.id DESC`,
        [tenant, destination],
      );
      const totals = rows[0];
      return {
        deliveries: rows.filter((row) => row.id).map(view),
        coverage: {
          scope: 'workspace',
          retentionHours: 168,
          scheduledTerminalLimit: EXPORT_SCHEDULED_TERMINAL_HISTORY_LIMIT,
          readLimit: 50,
          prunedScheduledBatches: {
            delivered: totals?.delivered_batches ?? '0',
            failed: totals?.failed_batches ?? '0',
            expired: totals?.expired_batches ?? '0',
          },
          prunedScheduledRecords: {
            delivered: totals?.delivered_records ?? '0',
            failed: totals?.failed_records ?? '0',
            expired: totals?.expired_records ?? '0',
          },
          lastPrunedAt: totals?.last_pruned_at?.toISOString(),
        },
      };
    });
  }
  /** Only terminal scheduled metadata rolls off. Active retries and caller IDs stay intact.
   * Call under the tenant admission lock; no schedule/destination write lock is acquired. */
  private async compactScheduledHistory(
    manager: EntityManager,
    tenant: string,
  ) {
    await manager.query(
      `WITH excess AS (
        SELECT id FROM public.log_export_deliveries WHERE tenant_id=$1 AND is_scheduled
        AND status IN ('delivered','failed','expired') ORDER BY completed_at DESC NULLS LAST,id DESC OFFSET $2 LIMIT 500
      ), page AS (
        SELECT j.id FROM public.log_export_deliveries j JOIN excess e ON e.id=j.id
        WHERE j.tenant_id=$1 AND j.is_scheduled AND j.status IN ('delivered','failed','expired')
        FOR UPDATE OF j SKIP LOCKED
      ), removed AS (
        DELETE FROM public.log_export_deliveries j USING page WHERE j.id=page.id
        RETURNING j.tenant_id,j.is_scheduled,j.status,j.record_count
      ) ${RECORD_PRUNED_SCHEDULED_HISTORY_SQL}`,
      [tenant, EXPORT_SCHEDULED_TERMINAL_HISTORY_LIMIT],
    );
  }
  async claim(
    tenantId: string,
    destinationId: string,
    scheduledOnly = false,
  ): Promise<ExportDeliveryLease | undefined> {
    const tenant = this.tenant(tenantId),
      destination = destinationUuid(destinationId);
    return this.transaction(async (manager) => {
      const { connection } = await this.snapshot(manager, tenant, destination);
      await this.expire(manager, tenant, destination);
      if (!connection) return undefined;
      await manager.query(
        `UPDATE public.log_export_deliveries SET status='failed',payload=NULL,lease_id=NULL,lease_until=NULL,
         completed_at=clock_timestamp(),error='attempts_exhausted' WHERE tenant_id=$1 AND destination_id=$2
         AND status='processing' AND lease_until<=clock_timestamp() AND attempts>=6`,
        [tenant, destination],
      );
      const [row]: DeliveryRow[] = await manager.query(
        `SELECT * FROM public.log_export_deliveries WHERE tenant_id=$1 AND destination_id=$2
         AND attempts<6 AND (NOT $3::boolean OR (is_scheduled AND schedule_id=$2))
         AND ((status='queued' AND next_attempt_at<=clock_timestamp()) OR
         (status='processing' AND lease_until<=clock_timestamp())) ORDER BY next_attempt_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenant, destination, scheduledOnly],
      );
      if (!row) return undefined;
      let credentials: LogExportDestinationCredentials;
      try {
        credentials = destinationCredentials(
          this.cipher.decrypt(
            tenant,
            destination,
            connection.type,
            connection.credentials,
          ),
          this.trustedOrigins,
        ).credentials;
        if (credentials.type !== connection.type) throw new Error();
      } catch {
        // A missing/retired key never spins at the head of the queue or leaks crypto errors.
        await this.failed(manager, row, 'credentials_unavailable', true);
        return undefined;
      }
      const leaseId = randomUUID();
      await manager.query(
        `UPDATE public.log_export_deliveries SET status='processing',attempts=attempts+1,lease_id=$2,
         lease_until=clock_timestamp()+make_interval(secs=>$3),error=NULL WHERE id=$1`,
        [row.id, leaseId, EXPORT_DELIVERY_LEASE_SECONDS],
      );
      return {
        id: row.id,
        leaseId,
        attempts: row.attempts + 1,
        batch: row.payload,
        credentials,
      };
    });
  }
  private async failed(
    manager: EntityManager,
    row: DeliveryRow,
    code: string,
    retryable: boolean,
    counted = false,
  ) {
    const attempts = row.attempts + (counted ? 0 : 1);
    const retry = retryable && attempts < EXPORT_DELIVERY_MAX_ATTEMPTS;
    await manager.query(
      `UPDATE public.log_export_deliveries SET status=$2,attempts=$3,payload=CASE WHEN $4 THEN payload ELSE NULL END,
       lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>$5),
       completed_at=CASE WHEN $4 THEN NULL ELSE clock_timestamp() END,error=$6 WHERE id=$1`,
      [
        row.id,
        retry ? 'queued' : 'failed',
        attempts,
        retry,
        RETRY_SECONDS[attempts - 1] ?? 1800,
        ERRORS.has(code) ? code : 'delivery_failed',
      ],
    );
  }
  /** Check immediately before network work and at most once per second while sending. */
  async leaseEligible(
    tenantId: string,
    deliveryId: string,
    leaseId: string,
  ): Promise<boolean> {
    const tenant = this.tenant(tenantId),
      id = destinationUuid(deliveryId),
      lease = destinationUuid(leaseId);
    return this.transaction(async (manager) => {
      const [{ eligible }]: Array<{ eligible: boolean }> = await manager.query(
        `SELECT EXISTS(SELECT 1 FROM public.log_export_deliveries j
         JOIN public.tenants t ON t.id=j.tenant_id JOIN public.log_export_destinations d ON d.id=j.destination_id
         WHERE j.tenant_id=$1 AND j.id=$2 AND j.lease_id=$3 AND j.status='processing'
         AND j.lease_until>clock_timestamp() AND (${ELIGIBLE_SQL})) AS eligible`,
        [tenant, id, lease],
      );
      return eligible;
    });
  }

  /** A stale lease/revision cannot report acknowledgement or schedule another attempt. */
  async finish(
    tenantId: string,
    deliveryId: string,
    leaseId: string,
    result:
      | { delivered: true }
      | { delivered: false; code: string; retryable: boolean },
  ): Promise<boolean> {
    const tenant = this.tenant(tenantId),
      id = destinationUuid(deliveryId),
      lease = destinationUuid(leaseId);
    return this.transaction(async (manager) => {
      const [identity]: Array<{ destination_id: string }> = await manager.query(
        'SELECT destination_id FROM public.log_export_deliveries WHERE tenant_id=$1 AND id=$2',
        [tenant, id],
      );
      if (!identity) return false;
      await this.snapshot(manager, tenant, identity.destination_id);
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`export-delivery-admission:${tenant}`],
      );
      await this.expire(manager, tenant, identity.destination_id);
      const [row]: DeliveryRow[] = await manager.query(
        `SELECT * FROM public.log_export_deliveries WHERE tenant_id=$1 AND id=$2 AND status='processing'
         AND lease_id=$3 AND lease_until>clock_timestamp() FOR UPDATE`,
        [tenant, id, lease],
      );
      if (!row) return false;
      if (result.delivered)
        await manager.query(
          `UPDATE public.log_export_deliveries SET status='delivered',payload=NULL,lease_id=NULL,lease_until=NULL,
         completed_at=clock_timestamp(),error=NULL WHERE id=$1`,
          [id],
        );
      else await this.failed(manager, row, result.code, result.retryable, true);
      await this.compactScheduledHistory(manager, tenant);
      return true;
    });
  }
  /** At most 500 payload revocations and 500 seven-day history removals per sweep. */
  async cleanup(): Promise<void> {
    await this.transaction(async (manager) => {
      await manager.query(
        `WITH page AS (SELECT id FROM public.log_export_deliveries WHERE status IN ('queued','processing')
         AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED)
         UPDATE public.log_export_deliveries j SET status='expired',payload=NULL,lease_id=NULL,lease_until=NULL,
         completed_at=clock_timestamp(),error='retention_expired' FROM page WHERE j.id=page.id`,
      );
      await manager.query(
        `WITH page AS (SELECT id FROM public.log_export_deliveries WHERE status IN ('delivered','failed','expired')
         AND completed_at<=clock_timestamp()-INTERVAL '168 hours' ORDER BY completed_at,id LIMIT 500 FOR UPDATE SKIP LOCKED)
         ,removed AS (DELETE FROM public.log_export_deliveries j USING page WHERE j.id=page.id
          RETURNING j.tenant_id,j.is_scheduled,j.status,j.record_count)
         ${RECORD_PRUNED_SCHEDULED_HISTORY_SQL}`,
      );
    });
  }
}
