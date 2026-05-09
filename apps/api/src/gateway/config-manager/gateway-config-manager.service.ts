import { Injectable, Logger, Inject } from '@nestjs/common';
import { TenantConfig } from '@api-gateway/shared-types';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../shared/redis.tokens';

@Injectable()
export class GatewayConfigManagerService {
  private readonly logger = new Logger(GatewayConfigManagerService.name);
  private currentConfig: TenantConfig | null = null;
  private tenantId: string | null = null;
  private _configVersion: number | null = null;
  private _configCachedAt: Date | null = null;
  private _configSource: 'live' | 'cache' | 'none' = 'none';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async loadConfig(tenantId: string, config: TenantConfig, version?: number) {
    this.tenantId = tenantId;
    this.currentConfig = config;
    this._configVersion = version ?? null;
    this._configCachedAt = new Date();
    this._configSource = 'live';

    await this.redis.set('cfg:default', JSON.stringify({ config, version, cachedAt: this._configCachedAt }), 'EX', 7 * 24 * 60 * 60);

    this.logger.log(`Config loaded for tenant ${tenantId}`);
  }

  getConfig(): TenantConfig | null {
    return this.currentConfig;
  }

  getTenantId(): string | null {
    return this.tenantId;
  }

  get configVersion(): number | null {
    return this._configVersion;
  }

  get configCachedAt(): Date | null {
    return this._configCachedAt;
  }

  get configSource(): 'live' | 'cache' | 'none' {
    return this._configSource;
  }

  async warmStart() {
    const cached = await this.redis.get('cfg:default');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed.config) {
          this.currentConfig = parsed.config;
          this._configVersion = parsed.version ?? null;
          this._configCachedAt = parsed.cachedAt ? new Date(parsed.cachedAt) : new Date();
          this._configSource = 'cache';
        } else {
          // Legacy format: raw config without envelope
          this.currentConfig = parsed;
          this._configSource = 'cache';
          this._configCachedAt = new Date();
        }
      } catch {
        this.logger.warn('Failed to parse cached config');
      }
      this.logger.log('Warm-started from local Redis cache');
    }
  }
}
