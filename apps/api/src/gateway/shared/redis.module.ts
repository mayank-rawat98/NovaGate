import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { GatewayConfig } from '../../config/configuration';
import { REDIS_CLIENT } from './redis.tokens';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<GatewayConfig, true>) => {
        const redisUrl = configService.get('redis', { infer: true }).url;
        return new Redis(redisUrl);
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
