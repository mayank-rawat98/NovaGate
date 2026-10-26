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

  private readonly listeners = new Set<() => void>();

  subscribeConfig(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notifyConfig() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        this.logger.warn('A configuration listener failed');
      }
    }
  }

  private loadQueue: Promise<void> = Promise.resolve();

  loadConfig(
    tenantId: string,
    config: TenantConfig,
    version?: number,
  ): Promise<void> {
    const operation = this.loadQueue.then(() =>
      this.installConfig(tenantId, config, version),
    );
    this.loadQueue = operation.catch(() => undefined);
    return operation;
  }

  private async installConfig(
    tenantId: string,
    config: TenantConfig,
    version?: number,
  ) {
    if (
      !tenantId ||
      !Number.isSafeInteger(version) ||
      (version as number) < 0
    ) {
      throw new Error('Invalid tenant or configuration version');
    }
    if (
      this.tenantId === tenantId &&
      this._configVersion !== null &&
      (version as number) < this._configVersion
    ) {
      return;
    }
    const cachedAt = new Date();

    await this.redis.set(
      'cfg:default',
      JSON.stringify({
        tenantId,
        config,
        version,
        cachedAt,
      }),
      'EX',
      7 * 24 * 60 * 60,
    );

    this.tenantId = tenantId;
    this.currentConfig = config;
    this._configVersion = version ?? null;
    this._configCachedAt = cachedAt;
    this._configSource = 'live';
    this.notifyConfig();

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
          this.tenantId = parsed.tenantId ?? null;
          this.currentConfig = parsed.config;
          this._configVersion = parsed.version ?? null;
          this._configCachedAt = parsed.cachedAt
            ? new Date(parsed.cachedAt)
            : new Date();
          this._configSource = 'cache';
          this.notifyConfig();
        } else {
          // Legacy format: raw config without envelope
          this.currentConfig = parsed;
          this._configSource = 'cache';
          this.notifyConfig();
          this._configCachedAt = new Date();
        }
      } catch {
        this.logger.warn('Failed to parse cached config');
      }
      this.logger.log('Warm-started from local Redis cache');
    }
  }
}
