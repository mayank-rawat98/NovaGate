import { Injectable } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'statusCode'],
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

  incrementHttpRequests(method: string, path: string, statusCode: number): void {
    this.httpRequestsTotal.labels(method, path, String(statusCode)).inc();
  }

  incrementRateLimitRedisError(): void {
    this.rateLimitRedisErrorsTotal.inc();
  }

  incrementDownstreamTimeout(service: string): void {
    this.downstreamTimeoutTotal.labels(service).inc();
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
