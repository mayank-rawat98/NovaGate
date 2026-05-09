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
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        entities: [Tenant, ApiKey, PendingConfigUpdate],
        synchronize: true, // For demo purposes
      }),
    }),
    TypeOrmModule.forFeature([Tenant, ApiKey, PendingConfigUpdate]),
  ],
  controllers: [HealthController],
  providers: [TenantConnectionManager, LogIngestionService],
})
export class AppModule {}
