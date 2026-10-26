import { LogStreamController } from '../proxy-config/log-stream.controller';
import { LogStreamService } from '../proxy-config/log-stream.service';
import { LogRetentionController } from '../log-retention/log-retention.controller';
import { LogRetentionService } from '../log-retention/log-retention.service';
import { LogPrivacyController } from '../log-privacy/log-privacy.controller';
import { LogPrivacyService } from '../log-privacy/log-privacy.service';
import { ConsumerAnalyticsService } from '../proxy-config/consumer-analytics.service';
import { ConsumerRollupService } from '../proxy-config/consumer-rollup.service';
import { MetricsStreamService } from '../proxy-config/metrics-stream.service';
import { metricStreamConfiguration } from '../proxy-config/metrics-stream.configuration';
import { TracesController } from '../proxy-config/traces.controller';
import { TracesService } from '../proxy-config/traces.service';
import { validateTraceQueryConfiguration } from '../proxy-config/traces.configuration';
import { LogExportModule } from '../log-export/log-export.module';
import { Module } from '@nestjs/common';
import { ConfigImportController } from '../config-import/config-import.controller';
import { ConfigImportService } from '../config-import/config-import.service';
import { APP_GUARD } from '@nestjs/core';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  Tenant,
  ApiKey,
  PendingConfigUpdate,
} from '../database/entities/public.entities';
import { TenantsService } from '../tenants/tenants.service';
import { TenantsController } from '../tenants/tenants.controller';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { ConfigPushService } from '../config-push/config-push.service';
import { RoutesController } from '../proxy-config/routes.controller';
import { ServicesController } from '../proxy-config/services.controller';
import { ConsumersController } from '../proxy-config/consumers.controller';
import { AnalyticsController } from '../proxy-config/analytics.controller';
import { HealthController } from './health.controller';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { MigrationService } from '../database/migration.service';
import { AlertsModule } from '../alerts/alerts.module';
import { AutomationTokensController } from '../automation-tokens/automation-tokens.controller';
import { AutomationTokensService } from '../automation-tokens/automation-tokens.service';
import { PortalService } from '../portal/portal.service';
import { PortalDevelopersService } from '../portal/portal-developers.service';
import { PortalPublicController } from '../portal/portal-public.controller';
import { PortalDeveloperController } from '../portal/portal-developer.controller';
import { PortalAdminController } from '../portal/portal-admin.controller';
import { PortalDeveloperGuard } from '../portal/portal-developer.guard';
import { GatewayPluginsController } from '../gateway-plugins/gateway-plugins.controller';
import { GatewayPluginsService } from '../gateway-plugins/gateway-plugins.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env) => ({
        ...validateTraceQueryConfiguration(env),
        metricStream: metricStreamConfiguration(env),
      }),
    }),
    LogExportModule,
    AlertsModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        entities: [Tenant, ApiKey, PendingConfigUpdate],
        synchronize: false,
        // Bound pool admission as well as worker SQL/network deadlines.
        extra: {
          max: 20,
          connectionTimeoutMillis: 3000,
          idleTimeoutMillis: 30000,
        },
      }),
    }),
    TypeOrmModule.forFeature([Tenant, ApiKey, PendingConfigUpdate]),
  ],
  controllers: [
    LogStreamController,
    ConfigImportController,
    LogRetentionController,
    LogPrivacyController,
    HealthController,
    AuthController,
    TenantsController,
    RoutesController,
    ServicesController,
    ConsumersController,
    AnalyticsController,
    TracesController,
    AutomationTokensController,
    PortalPublicController,
    PortalDeveloperController,
    PortalAdminController,
    GatewayPluginsController,
  ],
  providers: [
    LogStreamService,
    ConfigImportService,
    { provide: APP_GUARD, useClass: TenantAuthGuard },
    AuthService,
    EmailService,
    TenantsService,
    TenantProvisioningService,
    ConfigPushService,
    LogPrivacyService,
    LogRetentionService,
    MigrationService,
    TracesService,
    MetricsStreamService,
    ConsumerAnalyticsService,
    ConsumerRollupService,
    AutomationTokensService,
    PortalService,
    PortalDevelopersService,
    PortalDeveloperGuard,
    GatewayPluginsService,
  ],
})
export class AppModule {}
