import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import type { ServiceConfig, HealthSnapshot } from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';

interface TargetHealth {
  healthy: boolean;
  failCount: number;
  successCount: number;
  lastChecked: Date;
  errorMessage?: string;
}

const FAIL_THRESHOLD = 3;
const SUCCESS_THRESHOLD = 2;
const CHECK_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class UpstreamHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamHealthService.name);
  private readonly health = new Map<string, TargetHealth>();
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly telemetry: GatewayTelemetryService,
  ) {}

  onModuleInit(): void {
    this.interval = setInterval(() => void this.checkAll(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  getHealthyUrls(targets: Array<{ url: string; weight: number }>): Set<string> {
    const healthy = new Set<string>();
    for (const t of targets) {
      const h = this.health.get(t.url);
      if (!h || h.healthy) healthy.add(t.url);
    }
    return healthy;
  }

  getSnapshots(services: ServiceConfig[]): HealthSnapshot[] {
    return services.map((svc) => {
      const targetStates = svc.targets
        .map((t) => this.health.get(t.url))
        .filter(Boolean) as TargetHealth[];
      const anyUnhealthy = targetStates.some((h) => !h.healthy);
      const anyHealthy = targetStates.some((h) => h.healthy);
      const status: HealthSnapshot['status'] = anyUnhealthy
        ? 'unhealthy'
        : anyHealthy
          ? 'healthy'
          : 'unknown';
      const lastChecked = targetStates.reduce<Date | null>(
        (latest, h) =>
          !latest || h.lastChecked > latest ? h.lastChecked : latest,
        null,
      );
      const errorMessage = anyUnhealthy
        ? targetStates.find((h) => !h.healthy)?.errorMessage
        : undefined;
      return {
        serviceId: svc.id,
        status,
        checkedAt: lastChecked
          ? lastChecked.toISOString()
          : new Date().toISOString(),
        errorMessage,
      } as HealthSnapshot;
    });
  }

  private async checkAll(): Promise<void> {
    const config = this.configManager.getConfig();
    if (!config) return;

    const probes = config.services.flatMap((svc) =>
      svc.targets.map((t) => this.checkTarget(t.url, svc.healthCheckPath)),
    );
    await Promise.allSettled(probes);

    this.telemetry.sendHealth(this.getSnapshots(config.services));
  }

  private async checkTarget(url: string, healthPath: string): Promise<void> {
    const success = await this.probe(url, healthPath);
    const current = this.health.get(url) ?? {
      healthy: true,
      failCount: 0,
      successCount: 0,
      lastChecked: new Date(),
    };

    if (success) {
      const successCount = current.healthy
        ? current.successCount
        : current.successCount + 1;
      const nowHealthy = current.healthy || successCount >= SUCCESS_THRESHOLD;
      this.health.set(url, {
        healthy: nowHealthy,
        failCount: 0,
        successCount,
        lastChecked: new Date(),
      });
      if (!current.healthy && nowHealthy) {
        this.logger.log(`Target ${url} recovered`);
      }
    } else {
      const failCount = current.failCount + 1;
      const nowUnhealthy = failCount >= FAIL_THRESHOLD;
      const wasHealthy = current.healthy;
      this.health.set(url, {
        healthy: wasHealthy && !nowUnhealthy,
        failCount,
        successCount: 0,
        lastChecked: new Date(),
        errorMessage: `Failed ${failCount} consecutive health check(s)`,
      });
      if (wasHealthy && nowUnhealthy) {
        this.logger.warn(
          `Target ${url} marked unhealthy after ${failCount} consecutive failures`,
        );
      }
    }
  }

  private probe(baseUrl: string, healthPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };

      try {
        const fullUrl = new URL(healthPath || '/', baseUrl);
        const lib = fullUrl.protocol === 'https:' ? https : http;
        const req = lib.get(
          {
            hostname: fullUrl.hostname,
            port: fullUrl.port || undefined,
            path: fullUrl.pathname + fullUrl.search,
            timeout: PROBE_TIMEOUT_MS,
          },
          (res) => {
            res.resume();
            done((res.statusCode ?? 500) < 500);
          },
        );
        req.on('error', () => done(false));
        req.on('timeout', () => {
          req.destroy();
          done(false);
        });
      } catch {
        done(false);
      }
    });
  }
}
