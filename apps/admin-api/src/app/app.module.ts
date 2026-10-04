import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        entities: [Tenant, ApiKey, PendingConfigUpdate],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Tenant, ApiKey, PendingConfigUpdate]),
  ],
  controllers: [
    HealthController,
    AuthController,
    TenantsController,
    RoutesController,
    ServicesController,
    ConsumersController,
    AnalyticsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: TenantAuthGuard },
    AuthService,
    EmailService,
    TenantsService,
    TenantProvisioningService,
    ConfigPushService,
    MigrationService,
  ],
})
export class AppModule {}
