import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { logPrivacyPolicy, TenantConfig } from '@api-gateway/shared-types';

@Injectable()
export class ConfigPushService
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap
{
  private readonly logger = new Logger(ConfigPushService.name);
  private redis!: Redis;
  private timer?: NodeJS.Timeout;
  private retry?: Promise<void>;
  private stopping = false;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
    });
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      if (this.retry || this.stopping) return;
      this.retry = this.retryPending()
        .catch(() =>
          this.logger.warn('Configuration retry will resume on the next tick'),
        )
        .finally(() => {
          this.retry = undefined;
        });
    }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    this.redis.disconnect();
    await this.retry;
  }
  private async retryPending() {
    const pending = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'`,
      );
      return manager.query<
        Array<{
          tenantId: string;
          config: { config: TenantConfig; version: number };
        }>
      >(`WITH due AS (
        SELECT id FROM public.pending_config_updates WHERE "lastPublishAt" IS NULL OR "lastPublishAt"<clock_timestamp()-INTERVAL '10 seconds'
        ORDER BY "lastPublishAt" NULLS FIRST,"createdAt",id LIMIT 16 FOR UPDATE SKIP LOCKED
      ), claimed AS (UPDATE public.pending_config_updates p SET "lastPublishAt"=clock_timestamp() FROM due WHERE p.id=due.id RETURNING p."tenantId",p.config) SELECT * FROM claimed`);
    });
    for (const row of pending) {
      if (this.stopping) break;
      await this.publish({ tenantId: row.tenantId, ...row.config });
    }
  }
  async publish(payload: {
    tenantId: string;
    config: TenantConfig;
    version: number;
  }): Promise<boolean> {
    try {
      await this.redis.publish('config.update', JSON.stringify(payload));
      return true;
    } catch {
      this.logger.warn('Configuration is persisted and waiting for delivery');
      return false;
    }
  }
  async persistUpdate(tenantId: string, manager: EntityManager) {
    const [tenant] = await manager.query(
      `WITH versioned AS (
      UPDATE public.tenants SET "gatewayConfigVersion"="gatewayConfigVersion"+1 WHERE id=$1 RETURNING "gatewayConfigVersion"
    ) SELECT * FROM versioned`,
      [tenantId],
    );
    if (!tenant) throw new Error('Tenant not found');
    const version = tenant.gatewayConfigVersion as number;
    const config = await this.assembleConfig(tenantId, manager);
    await manager.query(
      `INSERT INTO public.pending_config_updates ("tenantId",config) VALUES ($1,$2)
      ON CONFLICT ("tenantId") DO UPDATE SET config=$2,"createdAt"=NOW(),"lastPublishAt"=NULL`,
      [tenantId, JSON.stringify({ config, version })],
    );
    return { tenantId, config, version };
  }

  async triggerUpdate(tenantId: string): Promise<void> {
    this.logger.log(`Publishing configuration for tenant ${tenantId}`);
    const payload = await this.dataSource.transaction((manager) =>
      this.persistUpdate(tenantId, manager),
    );
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
      `SELECT "caCertPem", "logPrivacy" FROM public.tenants WHERE id = $1`,
      [tenantId],
    );

    const services = serviceRows.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      targets: row.targets,
      healthCheckPath: row.healthCheckPath,
      healthCheckIntervalMs: row.healthCheckIntervalMs ?? 10000,
      healthCheckProtocol: row.healthCheckProtocol ?? 'http',
      healthCheckService: row.healthCheckService ?? '',
      unhealthyFallback: row.unhealthyFallback ?? false,
      timeoutMs: row.timeoutMs,
      loadBalancing: row.loadBalancing ?? 'weighted-round-robin',
      h2: row.h2 ?? false,
      supportsWebSocket: row.supportsWebSocket ?? false,
    }));

    const caCertPem: string | undefined = tenantRows[0]?.caCertPem ?? undefined;

    const config: TenantConfig = {
      logPrivacy: logPrivacyPolicy(tenantRows[0]?.logPrivacy),
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
