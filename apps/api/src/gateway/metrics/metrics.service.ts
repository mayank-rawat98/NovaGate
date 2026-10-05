import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
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
