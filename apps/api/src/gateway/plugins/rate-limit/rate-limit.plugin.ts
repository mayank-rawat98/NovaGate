import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { RateLimitService } from '../../rate-limit/rate-limit.service';

interface RateLimitPluginConfig {
  windowMs?: number;
  max: number;
}

@Injectable()
export class RateLimitPlugin implements GatewayPlugin {
  readonly name = 'rate-limit';
  private readonly logger = new Logger(RateLimitPlugin.name);

  constructor(private readonly rateLimitService: RateLimitService) {}

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === 'rate-limit');
    if (!entry) return;

    const config = entry.config as unknown as RateLimitPluginConfig;
    const limit = config.max;
    if (!limit || limit <= 0) return;

    const req = ctx.req as IncomingMessage;
    const ip = this.extractIp(req);
    const userId = ctx.req.user?.id;
    const clientKey = `route:${ctx.route.id}:${userId ? `${userId}:${ip}` : ip}`;

    try {
      const result = await this.rateLimitService.check(clientKey, limit);
      if (!result.allowed) {
        const retryAfter =
          result.retryAfterMs !== null
            ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
            : null;

        return {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            ...(retryAfter !== null
              ? { 'Retry-After': String(retryAfter) }
              : {}),
          },
          body: JSON.stringify({
            error: 'RATE_LIMIT_EXCEEDED',
            message: retryAfter
              ? `Too Many Requests. Retry after ${retryAfter}s.`
              : 'Too Many Requests',
            requestId: ctx.requestId,
          }),
        };
      }
    } catch (err) {
      // Fail open: Redis errors must not block requests
      this.logger.warn(
        JSON.stringify({
          msg: 'rate-limit plugin Redis error, failing open',
          error: (err as Error).message,
        }),
      );
    }
  }

  private extractIp(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = Array.isArray(fwd) ? fwd[0] : fwd;
      return first.split(',')[0].trim();
    }
    return (
      (req.socket as { remoteAddress?: string })?.remoteAddress ?? 'unknown'
    );
  }
}
