import { RETENTION_CUTOFF_SQL } from '../log-retention/log-retention.policy';
import { logPrivacyPolicy, redactRequestLog } from '@api-gateway/shared-types';
import type { Request, Response } from 'express';
import { MetricsStreamService } from './metrics-stream.service';
import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Req,
  Res,
  Header,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';
import {
  ConsumerAnalyticsService,
  consumerIdentity,
} from './consumer-analytics.service';
import { tenantSchema } from '../tenants/tenant-schema';

@Controller('tenants/:tenantId')
export class AnalyticsController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
    private readonly metricsStream: MetricsStreamService,
    private readonly consumerAnalytics: ConsumerAnalyticsService,
  ) {}

  private async withSchema<T>(
    tenantId: string,
    fn: (manager: EntityManager, schema: string) => Promise<T>,
  ): Promise<T> {
    const schema = tenantSchema(tenantId);
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SET LOCAL search_path TO ${schema}, public; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'`,
      );
      return fn(manager, schema);
    });
  }

  @Get('logs')
  @Header('Cache-Control', 'no-store')
  async getLogs(
    @Param('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('path') path?: string,
    @Query('statusCode') statusCode?: string,
    @Query('consumerId') consumerId?: string,
    @Query('page') page = '1',
  ) {
    if (consumerId !== undefined) consumerId = consumerIdentity(consumerId);
    return this.withSchema(tenantId, async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`log-receipt:${tenantId.toLowerCase()}`],
      );
      const [tenant] = await manager.query(
        `SELECT "logPrivacy",to_char(${RETENTION_CUTOFF_SQL} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff FROM public.tenants WHERE id=$1`,
        [tenantId],
      );
      const params: (string | number)[] = [tenant?.cutoff];
      const hidden = logPrivacyPolicy(tenant?.logPrivacy).redactedFields ?? [];
      const conditions: string[] = ['"receivedAt">=$1::timestamptz'];

      if (from) {
        params.push(from);
        conditions.push(`timestamp >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conditions.push(`timestamp <= $${params.length}`);
      }
      if (path) {
        params.push(`%${path}%`);
        conditions.push(
          `${hidden.includes('path') ? "'[redacted]'" : 'path'} ILIKE $${params.length}`,
        );
      }
      if (statusCode) {
        params.push(Number(statusCode));
        conditions.push(`"statusCode" = $${params.length}`);
      }
      if (consumerId) {
        if (hidden.includes('consumerId')) conditions.push('FALSE');
        params.push(consumerId);
        conditions.push(`"consumerId" = $${params.length}`);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const offset = (Math.max(1, Number(page)) - 1) * 50;
      params.push(offset);

      const rows: Array<Record<string, unknown>> = await manager.query(
        `SELECT * FROM request_logs ${where} ORDER BY timestamp DESC LIMIT 50 OFFSET $${params.length}`,
        params,
      );
      return rows.map(({ receivedAt: _receivedAt, ...row }) =>
        redactRequestLog(row, tenant?.logPrivacy),
      );
    });
  }

  @Get('health')
  async getHealth(@Param('tenantId') tenantId: string) {
    return this.withSchema(tenantId, (manager) =>
      manager.query(
        `SELECT DISTINCT ON ("serviceId") * FROM health_snapshots ORDER BY "serviceId", "checkedAt" DESC`,
      ),
    );
  }

  @Get('errors')
  async getErrors(
    @Param('tenantId') tenantId: string,
    @Query('resolved') resolved?: string,
    @Query('page') page = '1',
  ) {
    return this.withSchema(tenantId, async (manager) => {
      const params: (string | number | boolean)[] = [];
      const conditions: string[] = [];

      if (resolved !== undefined) {
        params.push(resolved !== 'false' && resolved !== '0');
        conditions.push(`resolved = $${params.length}`);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const offset = (Math.max(1, Number(page)) - 1) * 50;
      params.push(offset);

      return manager.query(
        `SELECT * FROM error_events ${where} ORDER BY timestamp DESC LIMIT 50 OFFSET $${params.length}`,
        params,
      );
    });
  }

  @Patch('errors/:errorId')
  async resolveError(
    @Param('tenantId') tenantId: string,
    @Param('errorId') errorId: string,
    @Body() body: { resolved: boolean },
  ) {
    return this.withSchema(tenantId, async (manager) => {
      await manager.query(
        `UPDATE error_events SET resolved = $2 WHERE id = $1`,
        [errorId, body.resolved],
      );
      return { success: true };
    });
  }

  @Get('metrics/stream')
  streamMetrics(
    @Param('tenantId') tenantId: string,
    @Req() request: Request & { sessionExpiresAt?: number },
    @Res() response: Response,
  ) {
    return this.metricsStream.open(
      tenantId,
      response,
      request.sessionExpiresAt,
    );
  }

  @Get('consumers/:consumerId/stats')
  @Header('Cache-Control', 'no-store')
  getConsumerStats(
    @Param('tenantId') tenantId: string,
    @Param('consumerId') consumerId: string,
    @Query('period') period = '24h',
  ) {
    return this.consumerAnalytics.get(tenantId, consumerId, period);
  }

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async getMetrics(
    @Param('tenantId') tenantId: string,
    @Query('period') period = '24h',
    @Query('consumerId') consumerId?: string,
  ) {
    if (consumerId !== undefined) {
      const usage = await this.consumerAnalytics.get(
        tenantId,
        consumerId,
        period,
      );
      // Legacy metric snapshots have numeric latency fields. Empty consumer buckets
      // carry zero rates; missing latency samples use 0. The stats API exposes null.
      return usage.series.map((b) => ({
        timestamp: b.timestamp,
        rps: b.rps,
        errorRate: b.errorRate,
        p50Ms: b.p50Ms ?? 0,
        p95Ms: b.p95Ms ?? 0,
        p99Ms: b.p99Ms ?? 0,
      }));
    }
    return this.metricsStream.history(tenantId, period);
  }

  @Get('gateway-status')
  async getGatewayStatus(@Param('tenantId') tenantId: string) {
    const online = await this.configPush.isOnline(tenantId);
    return { tenantId, online };
  }
}
