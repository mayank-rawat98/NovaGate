import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtMiddleware } from './auth/jwt.middleware';
import { HealthController } from './health/health.controller';
import { LoggingInterceptor } from './logging/logging.interceptor';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';
import { ProxyController } from './proxy/proxy.controller';
import { ProxyMiddleware } from './proxy/proxy.middleware';
import { ProxyService } from './proxy/proxy.service';
import { LoadBalancerService } from './proxy/load-balancer.service';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RateLimitService } from './rate-limit/rate-limit.service';
import { GatewayExceptionFilter } from './shared/gateway-exception.filter';
import { RedisModule } from './shared/redis.module';
import { ServicesModule } from './services/services.module';
import { ConfigManagerModule } from './config-manager/config-manager.module';
import { ControlPlaneConnectorService } from './connector/control-plane-connector.service';
import { GatewayTelemetryService } from './telemetry/gateway-telemetry.service';
import { UpstreamHealthService } from './health/upstream-health.service';
import { PluginsModule } from './plugins/plugins.module';

@Module({
  imports: [ServicesModule, RedisModule, ConfigManagerModule, PluginsModule],
  controllers: [HealthController, MetricsController, ProxyController],
  providers: [
    JwtMiddleware,
    MetricsService,
    ProxyService,
    ProxyMiddleware,
    LoadBalancerService,
    RateLimitService,
    RateLimitGuard,
    LoggingInterceptor,
    ControlPlaneConnectorService,
    GatewayTelemetryService,
    UpstreamHealthService,
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
