import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { TenantConfig } from '@api-gateway/shared-types';

@Injectable()
export class ConfigPushService implements OnModuleInit {
  private readonly logger = new Logger(ConfigPushService.name);
  private redis: Redis;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async triggerUpdate(tenantId: string): Promise<void> {
    const config = await this.assembleConfig(tenantId);
    await this.pushUpdate(tenantId, config);
  }

  async pushUpdate(tenantId: string, config: TenantConfig): Promise<void> {
    this.logger.log(`Pushing config update for tenant ${tenantId}`);

    const rows = await this.dataSource.query(
      `UPDATE public.tenants SET "gatewayConfigVersion" = "gatewayConfigVersion" + 1 WHERE id = $1 RETURNING "gatewayConfigVersion"`,
      [tenantId],
    );
    const version: number = rows[0]?.gatewayConfigVersion ?? 0;

    const payload = JSON.stringify({ tenantId, config, version });
    const subscriberCount = await this.redis.publish('config.update', payload);

    if (subscriberCount === 0) {
      await this.dataSource.query(
        `INSERT INTO public.pending_config_updates ("tenantId", config) VALUES ($1, $2)
         ON CONFLICT ("tenantId") DO UPDATE SET config = $2, "createdAt" = NOW()`,
        [tenantId, JSON.stringify({ config, version })],
      );
      this.logger.warn(`Gateway offline for tenant ${tenantId} — stored pending update`);
    }
  }

  async assembleConfig(tenantId: string): Promise<TenantConfig> {
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;

    const [routes, services, consumers] = await Promise.all([
      this.dataSource.query(
        `SELECT * FROM ${schema}.routes WHERE "deletedAt" IS NULL AND enabled = true`,
      ),
      this.dataSource.query(
        `SELECT * FROM ${schema}.services WHERE "deletedAt" IS NULL`,
      ),
      this.dataSource.query(
        `SELECT * FROM ${schema}.consumers WHERE "revokedAt" IS NULL`,
      ),
    ]);

    return {
      routes,
      services,
      consumers,
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
    };
  }

  async isOnline(tenantId: string): Promise<boolean> {
    const key = `gw:online:${tenantId}`;
    const val = await this.redis.get(key);
    return val !== null;
  }
}
