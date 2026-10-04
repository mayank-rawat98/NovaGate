import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { TenantConfig } from '@api-gateway/shared-types';

@Injectable()
export class ConfigPushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConfigPushService.name);
  private redis!: Redis;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  async triggerUpdate(tenantId: string): Promise<void> {
    this.logger.log(`Publishing configuration for tenant ${tenantId}`);
    const payload = await this.dataSource.transaction(async (manager) => {
      // Lock and version first: concurrent updates cannot publish a newer version
      // carrying an older snapshot assembled before another transaction committed.
      const [tenant] = await manager.query(
        `WITH versioned AS (
           UPDATE public.tenants SET "gatewayConfigVersion" = "gatewayConfigVersion" + 1
           WHERE id = $1 RETURNING "gatewayConfigVersion"
         ) SELECT "gatewayConfigVersion" FROM versioned`,
        [tenantId],
      );
      if (!tenant) throw new Error('Tenant not found');
      const version = tenant.gatewayConfigVersion as number;
      const config = await this.assembleConfig(tenantId, manager);
      await manager.query(
        `INSERT INTO public.pending_config_updates ("tenantId", config) VALUES ($1, $2)
         ON CONFLICT ("tenantId") DO UPDATE SET config = $2, "createdAt" = NOW()`,
        [tenantId, JSON.stringify({ config, version })],
      );
      return { tenantId, config, version };
    });
    // Persist before publishing: subscriber presence does not imply delivery.
    await this.redis.publish('config.update', JSON.stringify(payload));
  }

  async assembleConfig(
    tenantId: string,
    manager: EntityManager | DataSource = this.dataSource,
  ): Promise<TenantConfig> {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(tenantId))
      throw new Error('Invalid tenant ID');
    const schema = `tenant_${tenantId.replace(/-/g, '_')}`;

    const routes = await manager.query(
      `SELECT * FROM ${schema}.routes WHERE "deletedAt" IS NULL AND enabled = true`,
    );
    const serviceRows = await manager.query(
      `SELECT * FROM ${schema}.services WHERE "deletedAt" IS NULL`,
    );
    const consumers = await manager.query(
      `SELECT * FROM ${schema}.consumers WHERE "revokedAt" IS NULL`,
    );
    const tenantRows = await manager.query(
      `SELECT "caCertPem" FROM public.tenants WHERE id = $1`,
      [tenantId],
    );

    const services = serviceRows.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      targets: row.targets,
      healthCheckPath: row.healthCheckPath,
      healthCheckIntervalMs: row.healthCheckIntervalMs ?? 10000,
      unhealthyFallback: row.unhealthyFallback ?? false,
      timeoutMs: row.timeoutMs,
      h2: row.h2 ?? false,
      supportsWebSocket: row.supportsWebSocket ?? false,
    }));

    const caCertPem: string | undefined = tenantRows[0]?.caCertPem ?? undefined;

    const config: TenantConfig = {
      routes,
      services,
      consumers,
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
    };
    if (caCertPem) config.caCertPem = caCertPem;
    return config;
  }

  async isOnline(tenantId: string): Promise<boolean> {
    const key = `gw:online:${tenantId}`;
    const val = await this.redis.get(key);
    return val !== null;
  }
}
