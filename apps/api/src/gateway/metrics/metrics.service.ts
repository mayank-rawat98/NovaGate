import { Injectable, Optional } from '@nestjs/common';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import {
  MAX_METRIC_RATE,
  MAX_METRIC_LATENCY_MS,
  METRIC_LATENCY_BUCKETS,
  type MetricsSnapshot,
} from '@api-gateway/shared-types';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  private windowTenant: string | null = null;
  private windowStarted = performance.now();
  private completed = 0;
  private errors = 0;
  private readonly latencyCounts = METRIC_LATENCY_BUCKETS.map(() => 0);
  constructor(
    @Optional() private readonly configManager?: GatewayConfigManagerService,
  ) {}
  private resetWindow(tenant: string | null): void {
    this.windowTenant = tenant;
    this.windowStarted = performance.now();
    this.completed = 0;
    this.errors = 0;
    this.latencyCounts.fill(0);
  }
  recordCompletedHttp(
    status: number,
    durationMs: number,
    tenant: string | null,
  ): void {
    const current = this.configManager?.getTenantId() ?? null;
    if (
      !tenant ||
      tenant !== current ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      return;
    if (this.windowTenant !== current) this.resetWindow(current);
    if (this.completed >= MAX_METRIC_RATE) return;
    this.completed++;
    if (status >= 400) this.errors++;
    const bounded = Math.min(MAX_METRIC_LATENCY_MS, durationMs);
    const bucket = METRIC_LATENCY_BUCKETS.findIndex(
      (ceiling) => bounded <= ceiling,
    );
    this.latencyCounts[bucket]++;
  }
  takeSnapshot(): MetricsSnapshot {
    const tenant = this.configManager?.getTenantId() ?? null;
    if (tenant !== this.windowTenant) this.resetWindow(tenant);
    const elapsed = Math.max(1, performance.now() - this.windowStarted);
    const percentile = (fraction: number): number => {
      if (!this.completed) return 0;
      const rank = Math.ceil(this.completed * fraction);
      let cumulative = 0;
      for (let i = 0; i < this.latencyCounts.length; i++) {
        cumulative += this.latencyCounts[i];
        if (cumulative >= rank) return METRIC_LATENCY_BUCKETS[i];
      }
      return MAX_METRIC_LATENCY_MS;
    };
    const snapshot: MetricsSnapshot = {
      rps: Math.min(MAX_METRIC_RATE, (this.completed * 1000) / elapsed),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      errorRate: this.completed ? this.errors / this.completed : 0,
      timestamp: new Date().toISOString(),
    };
    this.resetWindow(tenant);
    return snapshot;
  }
  private readonly registry = new Registry();
  private readonly metricSnapshotsDropped = new Counter({
    name: 'gateway_metric_snapshots_dropped_total',
    help: 'Aggregate HTTP metric snapshots dropped by transient transport limits',
    registers: [this.registry],
  });
  incrementMetricSnapshotDropped(): void {
    this.metricSnapshotsDropped.inc();
  }
  private readonly traceActive = new Gauge({
    name: 'gateway_trace_active_spans',
    help: 'Active recording spans',
    registers: [this.registry],
  });
  private readonly traceQueued = new Gauge({
    name: 'gateway_trace_queued_spans',
    help: 'Pending trace spans',
    registers: [this.registry],
  });
  private readonly traceDropped = new Counter({
    name: 'gateway_trace_dropped_spans_total',
    help: 'Trace spans dropped under finite admission and transport limits',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  setTraceActiveSpans(count: number): void {
    this.traceActive.set(count);
  }
  setTraceQueuedSpans(count: number): void {
    this.traceQueued.set(count);
  }
  incrementTraceDropped(
    reason:
      | 'active-capacity'
      | 'queue-capacity'
      | 'tenant-change'
      | 'transport-backpressure',
  ): void {
    this.traceDropped.labels(reason).inc();
  }

  private readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'statusCode'],
    registers: [this.registry],
  });
  private readonly httpRequestDurationMs = new Histogram({
    name: 'http_request_duration_ms',
    help: 'HTTP request duration in milliseconds',
    labelNames: ['method', 'path'],
    buckets: [5, 10, 25, 50, 100, 250, 500],
    registers: [this.registry],
  });
  private readonly rateLimitHitsTotal = new Counter({
    name: 'rate_limit_hits_total',
    help: 'Total rate limit hits',
    labelNames: ['clientIp', 'tier'],
    registers: [this.registry],
  });
  private readonly activeConnections = new Gauge({
    name: 'active_connections',
    help: 'Active HTTP connections',
    registers: [this.registry],
  });
  private readonly rateLimitRedisErrorsTotal = new Counter({
    name: 'gateway_rate_limit_redis_errors_total',
    help: 'Total Redis errors encountered by rate limiter',
    registers: [this.registry],
  });
  private readonly downstreamTimeoutTotal = new Counter({
    name: 'gateway_downstream_timeout_total',
    help: 'Total downstream timeouts',
    labelNames: ['service'],
    registers: [this.registry],
  });
  private readonly proxyRetriesTotal = new Counter({
    name: 'gateway_proxy_retries_total',
    help: 'Total proxy retry attempts',
    labelNames: ['route', 'attempt'],
    registers: [this.registry],
  });
  private readonly activeWsConnections = new Gauge({
    name: 'gateway_ws_active_connections',
    help: 'Active WebSocket connections',
    registers: [this.registry],
  });
  private readonly wsBytesTotal = new Counter({
    name: 'gateway_ws_bytes_total',
    help: 'Total WebSocket bytes proxied',
    labelNames: ['direction'],
    registers: [this.registry],
  });
  private readonly grpcActiveCalls = new Gauge({
    name: 'gateway_grpc_active_calls',
    help: 'Active gRPC calls including authentication and quota admission',
    registers: [this.registry],
  });
  setGrpcActiveCalls(count: number): void {
    this.grpcActiveCalls.set(count);
  }
  private readonly grpcRequestsTotal = new Counter({
    name: 'gateway_grpc_requests_total',
    help: 'Total gRPC requests proxied',
    labelNames: ['grpc_service', 'grpc_method', 'grpc_status'],
    registers: [this.registry],
  });

  incrementHttpRequests(
    method: string,
    path: string,
    statusCode: number,
  ): void {
    this.httpRequestsTotal.labels(method, path, String(statusCode)).inc();
  }

  observeRequestDuration(
    method: string,
    path: string,
    durationMs: number,
  ): void {
    this.httpRequestDurationMs.labels(method, path).observe(durationMs);
  }

  incrementRateLimitHit(
    clientIp: string,
    tier: 'authenticated' | 'unauthenticated',
  ): void {
    this.rateLimitHitsTotal.labels(clientIp, tier).inc();
  }

  incrementActiveConnections(): void {
    this.activeConnections.inc();
  }

  decrementActiveConnections(): void {
    this.activeConnections.dec();
  }

  incrementRateLimitRedisError(): void {
    this.rateLimitRedisErrorsTotal.inc();
  }

  incrementDownstreamTimeout(service: string): void {
    this.downstreamTimeoutTotal.labels(service).inc();
  }

  incrementProxyRetry(route: string, attempt: number): void {
    this.proxyRetriesTotal.labels(route, String(attempt)).inc();
  }

  incrementWsConnections(): void {
    this.activeWsConnections.inc();
  }

  decrementWsConnections(): void {
    this.activeWsConnections.dec();
  }

  incrementWsBytes(direction: 'inbound' | 'outbound', bytes: number): void {
    this.wsBytesTotal.labels(direction).inc(bytes);
  }

  incrementGrpcRequests(
    grpcService: string,
    grpcMethod: string,
    grpcStatus: string,
  ): void {
    this.grpcRequestsTotal.labels(grpcService, grpcMethod, grpcStatus).inc();
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
