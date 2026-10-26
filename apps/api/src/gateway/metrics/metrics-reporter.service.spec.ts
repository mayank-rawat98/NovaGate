import { ConfigService } from '@nestjs/config';
import { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { MetricsService } from './metrics.service';
import { MetricsReporterService } from './metrics-reporter.service';
import { configSchema } from '../../config/configuration.schema';
import configuration from '../../config/configuration';
import {
  METRIC_LATENCY_BUCKETS,
  validateMetricPayload,
} from '@api-gateway/shared-types';

describe('Bounded aggregate HTTP metrics reporting', () => {
  let tenant: string | null;
  let metrics: MetricsService;
  let reporter: MetricsReporterService;
  const send = jest.fn();
  beforeEach(() => {
    tenant = 'tenant';
    const manager = {
      getTenantId: () => tenant,
    } as GatewayConfigManagerService;
    metrics = new MetricsService(manager);
    send.mockReset().mockReturnValue(true);
    reporter = new MetricsReporterService(
      new ConfigService(),
      metrics,
      { sendTransient: send } as unknown as ControlPlaneConnectorService,
      manager,
    );
  });
  it('uses fixed buckets, counts final errors and resets each reporting window', () => {
    metrics.recordCompletedHttp(200, 3, tenant);
    metrics.recordCompletedHttp(499, 26, tenant);
    const snapshot = metrics.takeSnapshot();
    expect(snapshot).toMatchObject({
      p50Ms: 5,
      p95Ms: 50,
      p99Ms: 50,
      errorRate: 0.5,
    });
    expect(snapshot.rps).toBeGreaterThan(0);
    expect(metrics.takeSnapshot()).toMatchObject({
      rps: 0,
      p50Ms: 0,
      errorRate: 0,
    });
  });
  it('reports coherent histograms and counts only final failed downstream timeouts', () => {
    metrics.recordCompletedHttp(504, 1200, tenant, true);
    metrics.recordCompletedHttp(502, 20, tenant);
    metrics.recordCompletedHttp(200, 3, tenant, true);
    reporter.report();
    const payload = send.mock.calls[0][0].payload;
    expect(validateMetricPayload(payload)).toEqual(payload);
    expect(payload.window).toMatchObject({
      requestCount: 3,
      errorCount: 2,
      timeoutCount: 1,
    });
    expect(payload.window.latencyCounts).toHaveLength(
      METRIC_LATENCY_BUCKETS.length,
    );
    expect(
      payload.window.latencyCounts.reduce(
        (sum: number, count: number) => sum + count,
        0,
      ),
    ).toBe(3);
    expect(metrics.takeSnapshot().window).toMatchObject({
      requestCount: 0,
      errorCount: 0,
      timeoutCount: 0,
    });
    expect(payload.window.requestCount).toBe(3);
  });
  it('discards reporting intervals after a prolonged process stall', () => {
    jest.useFakeTimers();
    try {
      // Initialize the interval using the same monotonic clock as the timer.
      metrics = new MetricsService({
        getTenantId: () => tenant,
      } as GatewayConfigManagerService);
      metrics.recordCompletedHttp(504, 5, tenant, true);
      jest.advanceTimersByTime(60001);
      expect(metrics.takeSnapshot().window).toMatchObject({
        requestCount: 0,
        errorCount: 0,
        timeoutCount: 0,
      });
    } finally {
      jest.useRealTimers();
    }
  });
  it('rejects stale completions, invalid durations and prior-tenant aggregate state', () => {
    metrics.recordCompletedHttp(500, 2, tenant);
    const prior = tenant;
    tenant = 'replacement';
    metrics.recordCompletedHttp(500, 10, prior);
    metrics.recordCompletedHttp(200, NaN, tenant);
    metrics.recordCompletedHttp(200, -1, tenant);
    expect(metrics.takeSnapshot()).toMatchObject({ rps: 0, errorRate: 0 });
    metrics.recordCompletedHttp(200, 1, tenant);
    expect(metrics.takeSnapshot().p99Ms).toBe(1);
  });
  it('caps latency and drops transient delivery rather than queueing or throwing', () => {
    metrics.recordCompletedHttp(504, 7200000, tenant);
    send.mockReturnValue(false);
    expect(reporter.report()).toBe(false);
    expect(send).toHaveBeenCalledWith(
      {
        type: 'metrics',
        payload: expect.objectContaining({ p99: 3600000, errorRate: 1 }),
      },
      65536,
    );
    send.mockImplementation(() => {
      throw new Error('offline');
    });
    expect(reporter.report()).toBe(false);
    tenant = null;
    send.mockClear();
    expect(reporter.report()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('runs one timer and flushes once on shutdown without reporting afterwards', () => {
    jest.useFakeTimers();
    try {
      reporter.onModuleInit();
      reporter.onModuleInit();
      jest.advanceTimersByTime(2000);
      expect(send).toHaveBeenCalledTimes(2);
      reporter.onModuleDestroy();
      expect(send).toHaveBeenCalledTimes(3);
      jest.advanceTimersByTime(5000);
      expect(send).toHaveBeenCalledTimes(3);
      expect(reporter.report()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
  it('exposes transport drops without tenant or request labels', async () => {
    send.mockReturnValueOnce(false).mockImplementationOnce(() => {
      throw new Error('closed transport');
    });
    reporter.report();
    reporter.report();
    reporter.report();
    expect(await metrics.getMetrics()).toContain(
      'gateway_metric_snapshots_dropped_total 2',
    );
  });
  it('validates the reporting budgets and keeps factory defaults aligned', () => {
    const base = {
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'metric-fixture-secret-at-least-32-characters',
      GATEWAY_API_KEY: 'fixture',
      CONTROL_PLANE_URL: 'ws://localhost:8080',
    };
    expect(configuration().metricReporting).toEqual({
      intervalMs: 1000,
      maxBufferedBytes: 65536,
    });
    for (const key of [
      'METRICS_REPORT_INTERVAL_MS',
      'METRICS_REPORT_MAX_BUFFERED_BYTES',
    ]) {
      expect(configSchema.validate({ ...base, [key]: 0 }).error).toBeDefined();
      expect(
        configSchema.validate({ ...base, [key]: 1.5 }).error,
      ).toBeDefined();
    }
  });
});
