import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { GatewayConfig } from '../config/configuration';
import { JwtMiddleware } from './auth/jwt.middleware';
import { HealthController } from './health/health.controller';
import { LoggingInterceptor } from './logging/logging.interceptor';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { ProxyController } from './proxy/proxy.controller';
import { ProxyMiddleware } from './proxy/proxy.middleware';
import { ProxyService } from './proxy/proxy.service';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimitService } from './rate-limit/rate-limit.service';
import { REDIS_CLIENT } from './shared/redis.tokens';
import { GatewayExceptionFilter } from './shared/gateway-exception.filter';
import { ServicesModule } from './services/services.module';
import { GatewayConfigManagerService } from './config-manager/gateway-config-manager.service';
import { ControlPlaneConnectorService } from './connector/control-plane-connector.service';
import { GatewayTelemetryService } from './telemetry/gateway-telemetry.service';

@Module({
  imports: [ServicesModule],
  controllers: [HealthController, MetricsController, ProxyController],
  providers: [
    JwtMiddleware,
    MetricsService,
    ProxyService,
    ProxyMiddleware,
    RateLimitService,
    RateLimitGuard,
    LoggingInterceptor,
    GatewayConfigManagerService,
    ControlPlaneConnectorService,
    GatewayTelemetryService,
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<GatewayConfig, true>) => {
        const redisUrl = configService.get('redis', { infer: true }).url;
        return new Redis(redisUrl);
      },
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GatewayExceptionFilter,
    },
  ],
})
export class GatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(JwtMiddleware).forRoutes('*');
  }
}
