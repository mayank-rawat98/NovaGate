import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_METRIC_REPORTING,
  type MetricReportingSettings,
} from '../../config/configuration';
import { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { MetricsService } from './metrics.service';
@Injectable()
export class MetricsReporterService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly settings: MetricReportingSettings;
  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly connector: ControlPlaneConnectorService,
    private readonly manager: GatewayConfigManagerService,
  ) {
    this.settings = {
      ...DEFAULT_METRIC_REPORTING,
      ...config.get<MetricReportingSettings>('metricReporting'),
    };
  }
  onModuleInit(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => this.report(), this.settings.intervalMs);
    this.timer.unref();
  }
  report(): boolean {
    if (this.stopping) return false;
    const snapshot = this.metrics.takeSnapshot();
    if (!this.manager.getTenantId()) return false;
    try {
      const delivered = this.connector.sendTransient(
        {
          type: 'metrics',
          payload: {
            rps: snapshot.rps,
            p50: snapshot.p50Ms,
            p95: snapshot.p95Ms,
            p99: snapshot.p99Ms,
            errorRate: snapshot.errorRate,
          },
        },
        this.settings.maxBufferedBytes,
      );
      if (!delivered) this.metrics.incrementMetricSnapshotDropped();
      return delivered;
    } catch {
      this.metrics.incrementMetricSnapshotDropped();
      return false;
    }
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.report();
    this.stopping = true;
  }
}
