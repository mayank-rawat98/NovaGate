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
import type {
  RequestWithUser,
  ResponseWithLocals,
} from '../shared/request-context';
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
    // Browser preflight is resolved and terminated by the CORS plugin. It
    // must work even when the caller has exhausted its actual-request budget.
    if (
      request.method === 'OPTIONS' &&
      request.headers.origin &&
      request.headers['access-control-request-method']
    )
      return true;
    const clientIp = this.getClientIp(request);
    const userId = request.user?.id;
    const tier = userId ? 'authenticated' : 'unauthenticated';
    const rateLimitConfig = this.configService.get('rateLimit', {
      infer: true,
    });
    const limit = userId ? rateLimitConfig.authMax : rateLimitConfig.unauthMax;
    const clientKey = userId ? `${userId}:${clientIp}` : clientIp;

    try {
      const result = await this.rateLimitService.check(clientKey, limit);
      if (!result.allowed) {
        const retryAfterSeconds =
          result.retryAfterMs !== null
            ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            : null;
        if (retryAfterSeconds !== null) {
          response.setHeader('Retry-After', retryAfterSeconds);
        }
        this.metricsService.incrementRateLimitHit(clientIp, tier);
        throw new GatewayError(
          'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds
            ? `Too Many Requests. Retry after ${retryAfterSeconds}s.`
            : 'Too Many Requests',
          429,
        );
      }
      return true;
    } catch (error) {
      if (
        error instanceof GatewayError &&
        error.code === 'RATE_LIMIT_EXCEEDED'
      ) {
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
    if (Array.isArray(request.ips) && request.ips.length > 0) {
      return request.ips[0];
    }
    return request.ip ?? 'unknown';
  }
}
