import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { traceSchemaSql } from '../database/trace-schema';
import { tenantSchema } from './tenant-schema';

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(private readonly dataSource: DataSource) {}

  async provisionTenant(tenantId: string): Promise<string> {
    const schemaName = tenantSchema(tenantId);
    this.logger.log(`Provisioning schema ${schemaName}`);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

      await manager.query(traceSchemaSql(schemaName));

      // Create tables for the tenant
      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.routes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          method VARCHAR NOT NULL,
          "pathPattern" VARCHAR NOT NULL,
          "serviceId" UUID NOT NULL,
          "authRequired" BOOLEAN DEFAULT false,
          "rateLimitOverride" INTEGER,
          enabled BOOLEAN DEFAULT true,
          retry JSONB,
          plugins JSONB,
          graphql JSONB,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "deletedAt" TIMESTAMP
        )
      `);

      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.services (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR NOT NULL,
          targets JSONB NOT NULL,
          "healthCheckPath" VARCHAR NOT NULL DEFAULT '/health',
          "timeoutMs" INTEGER DEFAULT 10000,
          "healthCheckIntervalMs" INTEGER NOT NULL DEFAULT 10000,
          "healthCheckProtocol" VARCHAR NOT NULL DEFAULT 'http',
          "healthCheckService" VARCHAR NOT NULL DEFAULT '',
          "unhealthyFallback" BOOLEAN NOT NULL DEFAULT false,
          "loadBalancing" VARCHAR NOT NULL DEFAULT 'weighted-round-robin' CHECK ("loadBalancing" IN ('weighted-round-robin', 'least-connections')),
          h2 BOOLEAN DEFAULT false,
          "supportsWebSocket" BOOLEAN DEFAULT false,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "deletedAt" TIMESTAMP
        )
      `);

      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.consumers (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR NOT NULL,
          "keyHash" VARCHAR NOT NULL,
          "rateLimitTier" VARCHAR DEFAULT 'authenticated',
          groups JSONB NOT NULL DEFAULT '[]'::jsonb,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          "revokedAt" TIMESTAMP
        )
      `);

      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.request_logs (
          id UUID PRIMARY KEY,
          "consumerId" UUID,
          method VARCHAR,
          path VARCHAR,
          "statusCode" INTEGER,
          "responseTimeMs" INTEGER,
          "requestId" VARCHAR,
          "traceId" VARCHAR(32),
          "spanId" VARCHAR(16),
          "downstreamService" VARCHAR,
          "downstreamLatencyMs" INTEGER,
          "clientIp" VARCHAR,
          "userAgent" VARCHAR,
          "errorCode" VARCHAR,
          timestamp TIMESTAMPTZ
        )
      `);

      await manager.query(
        `CREATE INDEX IF NOT EXISTS request_logs_export_cursor ON ${schemaName}.request_logs (timestamp, id)`,
      );

      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.error_events (
          id UUID PRIMARY KEY,
          "requestId" VARCHAR,
          "traceId" VARCHAR(32),
          "spanId" VARCHAR(16),
          "errorCode" VARCHAR,
          message TEXT,
          "serviceId" UUID,
          path VARCHAR,
          "statusCode" INTEGER,
          timestamp TIMESTAMP,
          resolved BOOLEAN DEFAULT false
        )
      `);

      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.health_snapshots (
          id SERIAL PRIMARY KEY,
          "serviceId" UUID,
          status VARCHAR,
          "latencyMs" INTEGER,
          "checkedAt" TIMESTAMP,
          "errorMessage" TEXT
        )
      `);

      await manager.query(`
        CREATE TABLE IF NOT EXISTS ${schemaName}.metrics_snapshots (
          id SERIAL PRIMARY KEY,
          rps DOUBLE PRECISION,
          "p50Ms" INTEGER,
          "p95Ms" INTEGER,
          "p99Ms" INTEGER,
          "errorRate" FLOAT,
          timestamp TIMESTAMPTZ
        )
      `);
      await manager.query(
        `CREATE INDEX IF NOT EXISTS metrics_snapshots_time ON ${schemaName}.metrics_snapshots (timestamp DESC)`,
      );
    });

    const rawKey = 'gw_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await this.dataSource.query(
      `INSERT INTO public.api_keys (id, "tenantId", "keyHash", label, "createdAt")
       VALUES (gen_random_uuid(), $1, $2, 'default', NOW())`,
      [tenantId, keyHash],
    );
    this.logger.log(`Gateway API key provisioned for tenant ${tenantId}`);

    return rawKey;
  }
}
