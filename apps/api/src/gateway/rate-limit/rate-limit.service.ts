import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import type { GatewayConfig } from '../../config/configuration';
import { REDIS_CLIENT } from '../shared/redis.tokens';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number | null;
}

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly windowMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService<GatewayConfig, true>,
  ) {
    this.windowMs = this.configService.get('rateLimit', {
      infer: true,
    }).windowMs;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          msg: 'Failed to close Redis connection',
          error: (error as Error).message,
        }),
      );
    }
  }

  async check(clientKey: string, limit: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const key = `rl:${clientKey}`;
    const member = `${now}-${Math.random()}`;

    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, '-inf', windowStart);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.zrange(key, 0, 0, 'WITHSCORES');
    pipeline.expire(key, Math.ceil(this.windowMs / 1000));

    const results = await pipeline.exec();
    const count = Number(results?.[2]?.[1] ?? 0);
    const oldest = results?.[3]?.[1] as string[] | undefined;

    const allowed = count <= limit;
    if (allowed) {
      return { allowed: true, retryAfterMs: null };
    }

    const oldestScore = oldest && oldest.length >= 2 ? Number(oldest[1]) : now;
    const retryAfterMs = Math.max(0, oldestScore + this.windowMs - now);

    return { allowed: false, retryAfterMs };
  }
}
