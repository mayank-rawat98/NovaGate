import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../shared/redis.tokens';

@Controller('health')
export class HealthController {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  @Get()
  async getHealth(): Promise<{
    status: string;
    redis: 'connected' | 'disconnected';
    uptime: number;
  }> {
    const redisStatus = await this.getRedisStatus();
    return {
      status: 'ok',
      redis: redisStatus,
      uptime: Math.floor(process.uptime()),
    };
  }

  private async getRedisStatus(): Promise<'connected' | 'disconnected'> {
    try {
      await this.redis.ping();
      return 'connected';
    } catch {
      return 'disconnected';
    }
  }
}
