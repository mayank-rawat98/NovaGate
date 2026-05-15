import { Controller, Get, Patch, Param, Query, Body } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

function tenantSchema(tenantId: string): string {
  if (!/^[0-9a-f-]+$/i.test(tenantId)) throw new Error('Invalid tenantId');
  return `tenant_${tenantId.replace(/-/g, '_')}`;
}

const PERIOD_INTERVALS: Record<string, string> = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
};

@Controller('tenants/:tenantId')
export class AnalyticsController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
  ) {}

  private async withSchema<T>(
    tenantId: string,
    fn: (manager: EntityManager, schema: string) => Promise<T>,
  ): Promise<T> {
    const schema = tenantSchema(tenantId);
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL search_path TO ${schema}, public`);
      return fn(manager, schema);
    });
  }

  @Get('logs')
  async getLogs(
    @Param('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('path') path?: string,
    @Query('statusCode') statusCode?: string,
    @Query('consumerId') consumerId?: string,
    @Query('page') page = '1',
  ) {
    return this.withSchema(tenantId, async (manager) => {
      const params: (string | number)[] = [];
      const conditions: string[] = [];

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
        conditions.push(`path ILIKE $${params.length}`);
      }
      if (statusCode) {
        params.push(Number(statusCode));
        conditions.push(`"statusCode" = $${params.length}`);
      }
      if (consumerId) {
        params.push(consumerId);
        conditions.push(`"consumerId" = $${params.length}`);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const offset = (Math.max(1, Number(page)) - 1) * 50;
      params.push(offset);

      return manager.query(
        `SELECT * FROM request_logs ${where} ORDER BY timestamp DESC LIMIT 50 OFFSET $${params.length}`,
        params,
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

  @Get('metrics')
  async getMetrics(
    @Param('tenantId') tenantId: string,
    @Query('period') period = '24h',
  ) {
    const interval = PERIOD_INTERVALS[period] ?? PERIOD_INTERVALS['24h'];
    return this.withSchema(tenantId, (manager) =>
      manager.query(
        `SELECT * FROM metrics_snapshots WHERE timestamp >= NOW() - INTERVAL '${interval}' ORDER BY timestamp ASC`,
      ),
    );
  }

  @Get('gateway-status')
  async getGatewayStatus(@Param('tenantId') tenantId: string) {
    const online = await this.configPush.isOnline(tenantId);
    return { tenantId, online };
  }
}
