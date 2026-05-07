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
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<ResponseWithLocals>();
    const start = response.locals.requestStart ?? Date.now();

    return next.handle().pipe(
      finalize(() => {
        const responseTimeMs = Date.now() - start;
        const statusCode = response.statusCode;
        const method = request.method;
        const routePath = request.route?.path ?? 'unmatched';
        const requestIdHeader = request.headers['x-request-id'];
        const requestId =
          (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ??
          response.locals.requestId;

        this.metricsService.incrementHttpRequests(method, routePath, statusCode);

        const logEntry: Record<string, string | number | undefined> = {
          timestamp: new Date().toISOString(),
          method,
          path: request.originalUrl,
          statusCode,
          responseTimeMs,
          requestId,
        };

        if (request.user?.id) {
          logEntry.userId = request.user.id;
        }

        if (request.ip) {
          logEntry.clientIp = request.ip;
        }

        if (response.locals.downstreamService) {
          logEntry.downstreamService = response.locals.downstreamService;
        }

        if (typeof response.locals.downstreamLatencyMs === 'number') {
          logEntry.downstreamLatencyMs = response.locals.downstreamLatencyMs;
        }

        this.logger.log(JSON.stringify(logEntry));
      }),
    );
  }
}
