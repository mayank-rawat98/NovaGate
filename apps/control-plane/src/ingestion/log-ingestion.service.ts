import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_METRIC_INGESTION,
  type MetricIngestionSettings,
} from '../config/tracing.configuration';
import { DataSource } from 'typeorm';
import {
  RequestLog,
  HealthSnapshot,
  ErrorEvent,
  validateMetricPayload,
  type MetricsSnapshot,
} from '@api-gateway/shared-types';

@Injectable()
export class LogIngestionService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private cleanup?: Promise<void>;
  private schemaCursor = '';
  private stopping = false;
  private cleanupRunning = false;
  private readonly logger = new Logger(LogIngestionService.name);

  private readonly metricSettings: MetricIngestionSettings;
  private activeMetrics = 0;
  constructor(
    private readonly dataSource: DataSource,
    @Optional() config: ConfigService = new ConfigService(),
  ) {
    this.metricSettings = {
      ...DEFAULT_METRIC_INGESTION,
      ...config.get<MetricIngestionSettings>('metricIngestion'),
    };
  }

  onModuleInit(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      if (this.cleanup || this.stopping) return;
      this.cleanup = this.cleanupExpired()
        .catch(() => {
          this.logger.warn(
            'Metric retention cleanup failed; retrying on the next tick',
          );
        })
        .finally(() => {
          this.cleanup = undefined;
        });
    }, 60000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.cleanup;
  }
  async cleanupExpired(): Promise<void> {
    if (
      this.stopping ||
      this.cleanupRunning ||
      this.activeMetrics >= this.metricSettings.maxConcurrent
    )
      return;
    this.cleanupRunning = true;
    this.activeMetrics++;
    try {
      const schemas = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', $1, true)`,
          [String(this.metricSettings.statementTimeoutMs)],
        );
        return manager.query<Array<{ table_schema: string }>>(
          `SELECT table_schema FROM information_schema.tables WHERE table_name = 'metrics_snapshots' AND table_schema > $1 AND table_schema ~ '^tenant_[0-9a-f]{8}(_[0-9a-f]{4}){3}_[0-9a-f]{12}$' ORDER BY table_schema LIMIT 64`,
          [this.schemaCursor],
        );
      });
      for (const { table_schema: schema } of schemas) {
        if (this.stopping) break;
        if (
          !/^tenant_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/.test(schema)
        )
          throw new Error('Invalid metric retention schema');
        const tenantId = schema.slice(7).replace(/_/g, '-');
        try {
          await this.dataSource.transaction(async (manager) => {
            await manager.query(
              `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
              [
                String(this.metricSettings.statementTimeoutMs),
                String(this.metricSettings.lockTimeoutMs),
              ],
            );
            await manager.query(
              `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
              [`metric-ingestion:${tenantId}`],
            );
            await manager.query(
              `DELETE FROM ${schema}.metrics_snapshots WHERE timestamp < NOW() - make_interval(days => $1)`,
              [this.metricSettings.retentionDays],
            );
          });
        } catch {
          this.logger.warn(
            'A tenant metric retention cleanup failed; continuing the sweep',
          );
        }
        this.schemaCursor = schema;
      }
      if (schemas.length < 64) this.schemaCursor = '';
    } finally {
      this.activeMetrics--;
      this.cleanupRunning = false;
    }
  }
  private tenantSchema(tenantId: string): string {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(tenantId)) {
      throw new Error('Invalid tenant ID');
    }
    return `tenant_${tenantId.replace(/-/g, '_')}`;
  }

  async ingestLogs(tenantId: string, logs: RequestLog[]) {
    if (logs.length === 0) return;

    try {
      const schema = this.tenantSchema(tenantId);

      const rows = logs.map((log) => ({
        id: log.id,
        consumerId: log.consumerId,
        method: log.method,
        path: log.path,
        statusCode: log.statusCode,
        responseTimeMs: log.responseTimeMs,
        requestId: log.requestId,
        downstreamService: log.downstreamService,
        downstreamLatencyMs: log.downstreamLatencyMs,
        clientIp: log.clientIp,
        userAgent: log.userAgent,
        errorCode: log.errorCode,
        timestamp: log.timestamp,
        traceId: log.traceId ?? null,
        spanId: log.spanId ?? null,
      }));
      // Table record conversion ignores new optional correlation fields on legacy schemas.
      // Tenant selection remains server-owned and schema-qualified.
      await this.dataSource.query(
        `INSERT INTO ${schema}.request_logs SELECT * FROM jsonb_populate_recordset(NULL::${schema}.request_logs, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(rows)],
      );
    } catch (err) {
      this.logger.error(
        `Failed to ingest logs for tenant ${tenantId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async ingestHealth(tenantId: string, snapshots: HealthSnapshot[]) {
    try {
      const schema = this.tenantSchema(tenantId);

      for (const s of snapshots) {
        await this.dataSource.query(
          `INSERT INTO ${schema}.health_snapshots ("serviceId", status, "latencyMs", "checkedAt", "errorMessage")
           VALUES ($1, $2, $3, $4, $5)`,
          [s.serviceId, s.status, s.latencyMs, s.checkedAt, s.errorMessage],
        );

        // Keep only last 100
        await this.dataSource.query(
          `DELETE FROM ${schema}.health_snapshots WHERE id IN (
            SELECT id FROM ${schema}.health_snapshots WHERE "serviceId" = $1
            ORDER BY "checkedAt" DESC OFFSET 100
          )`,
          [s.serviceId],
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to ingest health for tenant ${tenantId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async ingestErrors(tenantId: string, errors: ErrorEvent[]) {
    try {
      const schema = this.tenantSchema(tenantId);

      for (const e of errors) {
        await this.dataSource.query(
          `INSERT INTO ${schema}.error_events (id, "requestId", "errorCode", message, "serviceId", path, "statusCode", timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [
            e.id,
            e.requestId,
            e.errorCode,
            e.message,
            e.serviceId,
            e.path,
            e.statusCode,
            e.timestamp,
          ],
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to ingest errors for tenant ${tenantId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async ingestMetrics(
    tenantId: string,
    payload: unknown,
  ): Promise<MetricsSnapshot> {
    if (this.stopping) throw new Error('Metric ingestion is stopping');
    const schema = this.tenantSchema(tenantId.toLowerCase());
    const value = validateMetricPayload(payload);
    if (this.activeMetrics >= this.metricSettings.maxConcurrent)
      throw new Error('Metric ingestion capacity exhausted');
    this.activeMetrics++;
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
          [
            String(this.metricSettings.statementTimeoutMs),
            String(this.metricSettings.lockTimeoutMs),
          ],
        );
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`metric-ingestion:${tenantId.toLowerCase()}`],
        );
        await manager.query(
          `DELETE FROM ${schema}.metrics_snapshots WHERE timestamp < NOW() - make_interval(days => $1)`,
          [this.metricSettings.retentionDays],
        );
        const [stored] = await manager.query<
          Array<Omit<MetricsSnapshot, 'timestamp'> & { timestamp: Date }>
        >(
          `INSERT INTO ${schema}.metrics_snapshots (rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp) VALUES ($1::double precision, $2, $3, $4, $5, NOW()) RETURNING rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp`,
          [
            value.rps,
            Math.round(value.p50),
            Math.round(value.p95),
            Math.round(value.p99),
            value.errorRate,
          ],
        );
        await manager.query(
          `DELETE FROM ${schema}.metrics_snapshots WHERE ctid IN (SELECT ctid FROM ${schema}.metrics_snapshots ORDER BY timestamp DESC, ctid DESC OFFSET $1)`,
          [this.metricSettings.maxRowsPerTenant],
        );
        return {
          ...stored,
          timestamp: new Date(stored.timestamp).toISOString(),
        };
      });
    } finally {
      this.activeMetrics--;
    }
  }
}
