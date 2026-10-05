import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  RequestLog,
  HealthSnapshot,
  ErrorEvent,
} from '@api-gateway/shared-types';

@Injectable()
export class LogIngestionService {
  private readonly logger = new Logger(LogIngestionService.name);

  constructor(private readonly dataSource: DataSource) {}

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

  async ingestMetrics(tenantId: string, payload: Record<string, unknown>) {
    try {
      const schema = this.tenantSchema(tenantId);

      await this.dataSource.query(
        `INSERT INTO ${schema}.metrics_snapshots (rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [payload.rps, payload.p50, payload.p95, payload.p99, payload.errorRate],
      );
    } catch (err) {
      this.logger.error(
        `Failed to ingest metrics for tenant ${tenantId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
