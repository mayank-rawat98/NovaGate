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

  async ingestLogs(tenantId: string, logs: RequestLog[]) {
    if (logs.length === 0) return;

    try {
      const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
      await this.dataSource.query(`SET search_path TO ${schema}`);

      const values = logs.map((log) => [
        log.id,
        log.consumerId,
        log.method,
        log.path,
        log.statusCode,
        log.responseTimeMs,
        log.requestId,
        log.downstreamService,
        log.downstreamLatencyMs,
        log.clientIp,
        log.userAgent,
        log.errorCode,
        log.timestamp,
      ]);

      await this.dataSource.query(
        `INSERT INTO request_logs (
          id, "consumerId", method, path, "statusCode", 
          "responseTimeMs", "requestId", "downstreamService", 
          "downstreamLatencyMs", "clientIp", "userAgent", "errorCode", timestamp
        ) VALUES ${values.map((_, i) => `($${i * 13 + 1}, $${i * 13 + 2}, $${i * 13 + 3}, $${i * 13 + 4}, $${i * 13 + 5}, $${i * 13 + 6}, $${i * 13 + 7}, $${i * 13 + 8}, $${i * 13 + 9}, $${i * 13 + 10}, $${i * 13 + 11}, $${i * 13 + 12}, $${i * 13 + 13})`).join(', ')}`,
        values.flat(),
      );

      await this.dataSource.query(`SET search_path TO public`);
    } catch (err) {
      this.logger.error(
        `Failed to ingest logs for tenant ${tenantId}: ${err.message}`,
      );
    }
  }

  async ingestHealth(tenantId: string, snapshots: HealthSnapshot[]) {
    try {
      const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
      await this.dataSource.query(`SET search_path TO ${schema}`);

      for (const s of snapshots) {
        await this.dataSource.query(
          `INSERT INTO health_snapshots ("serviceId", status, "latencyMs", "checkedAt", "errorMessage")
           VALUES ($1, $2, $3, $4, $5)`,
          [s.serviceId, s.status, s.latencyMs, s.checkedAt, s.errorMessage],
        );

        // Keep only last 100
        await this.dataSource.query(
          `DELETE FROM health_snapshots WHERE id IN (
            SELECT id FROM health_snapshots WHERE "serviceId" = $1
            ORDER BY "checkedAt" DESC OFFSET 100
          )`,
          [s.serviceId],
        );
      }

      await this.dataSource.query(`SET search_path TO public`);
    } catch (err) {
      this.logger.error(
        `Failed to ingest health for tenant ${tenantId}: ${err.message}`,
      );
    }
  }

  async ingestErrors(tenantId: string, errors: ErrorEvent[]) {
    try {
      const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
      await this.dataSource.query(`SET search_path TO ${schema}`);

      for (const e of errors) {
        await this.dataSource.query(
          `INSERT INTO error_events (id, "requestId", "errorCode", message, "serviceId", path, "statusCode", timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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

      await this.dataSource.query(`SET search_path TO public`);
    } catch (err) {
      this.logger.error(
        `Failed to ingest errors for tenant ${tenantId}: ${err.message}`,
      );
    }
  }

  async ingestMetrics(tenantId: string, payload: any) {
    try {
      const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
      await this.dataSource.query(`SET search_path TO ${schema}`);

      await this.dataSource.query(
        `INSERT INTO metrics_snapshots (rps, "p50Ms", "p95Ms", "p99Ms", "errorRate", timestamp)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [payload.rps, payload.p50, payload.p95, payload.p99, payload.errorRate],
      );

      await this.dataSource.query(`SET search_path TO public`);
    } catch (err) {
      this.logger.error(
        `Failed to ingest metrics for tenant ${tenantId}: ${err.message}`,
      );
    }
  }
}
