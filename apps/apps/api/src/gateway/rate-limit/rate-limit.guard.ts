import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import type { GatewayConfig } from '../../config/configuration';
import { GatewayError } from '../shared/gateway-error';
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { RateLimitService } from './rate-limit.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly configService: ConfigService<GatewayConfig, true>,
    private readonly metricsService: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<ResponseWithLocals>();
    const clientIp = this.getClientIp(request);
    const userId = request.user?.id;
    const rateLimitConfig = this.configService.get('rateLimit', { infer: true });
    const limit = userId ? rateLimitConfig.authMax : rateLimitConfig.unauthMax;
    const clientKey = userId ? `${userId}:${clientIp}` : clientIp;

    try {
      const result = await this.rateLimitService.check(clientKey, limit);
      if (!result.allowed) {
        if (result.retryAfterMs !== null) {
          response.setHeader(
            'Retry-After',
            Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
          );
        }
        this.logRequest(request, response, clientIp, userId, 429);
        throw new GatewayError(
          'RATE_LIMIT_EXCEEDED',
          'Too Many Requests',
          429,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'RATE_LIMIT_EXCEEDED') {
        throw error;
      }
      this.metricsService.incrementRateLimitRedisError();
      this.logger.warn(
        JSON.stringify({
          msg: 'Redis unavailable, failing open',
          error: (error as Error).message,
        }),
      );
      return true;
    }
  }

  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0];
    }
    return request.ip;
  }

  private logRequest(
    request: RequestWithUser,
    response: ResponseWithLocals,
    clientIp: string,
    userId: string | undefined,
    statusCode: number,
  ): void {
    const start = response.locals?.requestStart ?? Date.now();
    const responseTimeMs = Date.now() - start;
    const logEntry: Record<string, string | number | undefined> = {
      timestamp: new Date().toISOString(),
      method: request.method,
      path: request.originalUrl,
      statusCode,
      responseTimeMs,
    };

    const requestIdHeader = request.headers['x-request-id'];
    const requestId = Array.isArray(requestIdHeader)
      ? requestIdHeader[0]
      : requestIdHeader;
    if (requestId) {
      logEntry.requestId = requestId;
    }

    if (userId) {
      logEntry.userId = userId;
    }

    if (clientIp) {
      logEntry.clientIp = clientIp;
    }

    this.logger.warn(JSON.stringify(logEntry));
  }
}
