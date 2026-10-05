import { Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import type { NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { OtelService } from '../telemetry/otel.service';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';
import type { RequestLog } from '@api-gateway/shared-types';
import type {
  RequestWithUser,
  ResponseWithLocals,
} from '../shared/request-context';

const METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LoggingMiddleware.name);
  private readonly observed = new WeakSet<ResponseWithLocals>();
  constructor(
    private readonly metrics: MetricsService,
    private readonly telemetry: GatewayTelemetryService,
    @Optional() private readonly tracing?: OtelService,
    @Optional() private readonly manager?: GatewayConfigManagerService,
  ) {}

  use(
    request: RequestWithUser,
    response: ResponseWithLocals,
    next: NextFunction,
  ): void {
    if (this.observed.has(response)) {
      next();
      return;
    }
    this.observed.add(response);
    const started = performance.now();
    const requestTenant = this.manager?.getTenantId() ?? null;
    const header = request.headers['x-request-id'];
    const requestId =
      typeof header === 'string' && UUID.test(header) ? header : randomUUID();
    request.headers['x-request-id'] = requestId;
    response.locals.requestId = requestId;
    response.locals.requestStart = Date.now();
    response.setHeader('X-Request-ID', requestId);
    if (this.tracing)
      this.observe(() => {
        response.locals.trace = this.tracing?.startServer(
          request.headers,
          requestId,
        );
      });
    this.observe(() => this.metrics.incrementActiveConnections());
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      response.off('finish', finish);
      response.off('close', finish);
      // 499 is an internal incomplete-response outcome, including downstream truncation.
      const statusCode = response.writableFinished ? response.statusCode : 499;
      const responseTimeMs = Math.round(
        Math.max(0, performance.now() - started),
      );
      const method = METHODS.has(request.method) ? request.method : 'OTHER';
      const path = response.locals.routePattern ?? 'unmatched';
      this.observe(() => this.metrics.decrementActiveConnections());
      this.observe(() =>
        this.metrics.incrementHttpRequests(method, path, statusCode),
      );
      this.observe(() =>
        this.metrics.observeRequestDuration(method, path, responseTimeMs),
      );
      this.observe(() =>
        this.metrics.recordCompletedHttp?.(
          statusCode,
          responseTimeMs,
          requestTenant,
        ),
      );
      this.observe(() => {
        response.locals.trace?.set({
          'http.request.method': method,
          'http.route': path,
        });
        response.locals.trace?.end(statusCode);
      });
      const entry: RequestLog = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        requestId,
        ...(response.locals.trace
          ? {
              traceId: response.locals.trace.traceId,
              spanId: response.locals.trace.spanId,
            }
          : {}),
        method,
        path,
        statusCode,
        responseTimeMs,
        clientIp: request.ips?.[0] ?? request.ip ?? 'unknown',
        downstreamService: response.locals.downstreamService,
        downstreamLatencyMs: response.locals.downstreamLatencyMs,
        ...(request.user?.id ? { consumerId: request.user.id } : {}),
      };
      this.observe(() => this.telemetry.logRequest(entry));
      this.observe(() => this.logger.log(JSON.stringify(entry)));
    };
    response.once('finish', finish);
    response.once('close', finish);
    next();
  }
  private observe(operation: () => void): void {
    try {
      operation();
    } catch {
      this.logger.warn('HTTP observation failed');
    }
  }
}
