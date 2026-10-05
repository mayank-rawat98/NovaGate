import { TraceIngestionService } from '../ingestion/trace-ingestion.service';
import { validateTracingConfiguration } from '../config/tracing.configuration';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  Tenant,
  ApiKey,
  PendingConfigUpdate,
} from '../database/entities/public.entities';
import { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager';
import { LogIngestionService } from '../ingestion/log-ingestion.service';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateTracingConfiguration,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        entities: [Tenant, ApiKey, PendingConfigUpdate],
        // Public schema is initialized by docker/postgres-init.sql and migrated
        // by admin-api. Synchronization here can drop admin-only auth columns.
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Tenant, ApiKey, PendingConfigUpdate]),
  ],
  controllers: [HealthController],
  providers: [
    TenantConnectionManager,
    LogIngestionService,
    TraceIngestionService,
  ],
})
export class AppModule {}
