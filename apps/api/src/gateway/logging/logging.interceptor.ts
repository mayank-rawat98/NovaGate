import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MetricsService } from '../metrics/metrics.service';
import type {
  RequestWithUser,
  ResponseWithLocals,
} from '../shared/request-context';

import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';
import { RequestLog } from '@api-gateway/shared-types';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  constructor(
    private readonly metricsService: MetricsService,
    private readonly telemetryService: GatewayTelemetryService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<ResponseWithLocals>();
    const start = response.locals.requestStart ?? Date.now();
    this.metricsService.incrementActiveConnections();

    return next.handle().pipe(
      finalize(() => {
        const responseTimeMs = Date.now() - start;
        const statusCode = response.statusCode;
        const method = request.method;
        const routePath = this.getPathLabel(request);
        const requestIdHeader = request.headers['x-request-id'];
        const requestId =
          (Array.isArray(requestIdHeader)
            ? requestIdHeader[0]
            : requestIdHeader) ?? response.locals.requestId;

        this.metricsService.incrementHttpRequests(
          method,
          routePath,
          statusCode,
        );
        this.metricsService.observeRequestDuration(
          method,
          routePath,
          responseTimeMs,
        );
        this.metricsService.decrementActiveConnections();

        const logEntry: RequestLog = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          method,
          path: request.originalUrl || '',
          statusCode,
          responseTimeMs,
          requestId: requestId || 'unknown',
          clientIp: this.getClientIp(request) || 'unknown',
          userAgent: request.headers['user-agent'] as string,
          downstreamService: response.locals.downstreamService,
          downstreamLatencyMs: response.locals.downstreamLatencyMs,
        };

        if (request.user?.id) {
          logEntry.consumerId = request.user.id;
        }

        // Send to Control Plane
        this.telemetryService.logRequest(logEntry);

        // Local logging
        this.logger.log(JSON.stringify(logEntry));
      }),
    );
  }

  private getPathLabel(request: RequestWithUser): string {
    const rawPath = request.originalUrl ?? request.url ?? 'unknown';
    const [path] = rawPath.split('?');
    return path || 'unknown';
  }

  private getClientIp(request: RequestWithUser): string | undefined {
    if (Array.isArray(request.ips) && request.ips.length > 0) {
      return request.ips[0];
    }
    return request.ip ?? undefined;
  }
}
