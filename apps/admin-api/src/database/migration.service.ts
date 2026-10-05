import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LOG_EXPORT_SCHEMA } from '../log-export/log-export-schema';
import { tenantSchema } from '../tenants/tenant-schema';

@Injectable()
export class MigrationService implements OnModuleInit {
  private readonly logger = new Logger(MigrationService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.migrateAllTenants();
  }

  private async migrateAllTenants(): Promise<void> {
    const tenantCount = await this.dataSource.transaction(async (manager) => {
      // Serialize migrations across admin replicas; release the lock at commit.
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtext('novagate-schema-migrations'))`,
      );
      await manager.query(`ALTER TABLE public.tenants
        ADD COLUMN IF NOT EXISTS "passwordHash" VARCHAR,
        ADD COLUMN IF NOT EXISTS "resetPasswordToken" VARCHAR,
        ADD COLUMN IF NOT EXISTS "resetPasswordExpires" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "verifyToken" VARCHAR,
        ADD COLUMN IF NOT EXISTS "verifyExpires" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "caCertPem" TEXT`);
      await manager.query(`DELETE FROM public.pending_config_updates a USING public.pending_config_updates b
        WHERE a."tenantId" = b."tenantId" AND (a."createdAt", a.id) < (b."createdAt", b.id)`);
      await manager.query(`CREATE UNIQUE INDEX IF NOT EXISTS pending_config_updates_tenant_unique
        ON public.pending_config_updates ("tenantId")`);
      await manager.query(LOG_EXPORT_SCHEMA);
      const tenants = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM public.tenants`,
      );
      for (const tenant of tenants) {
        const schema = tenantSchema(tenant.id);
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.services ADD COLUMN IF NOT EXISTS "loadBalancing" VARCHAR NOT NULL DEFAULT 'weighted-round-robin' CHECK ("loadBalancing" IN ('weighted-round-robin', 'least-connections'))`,
        );
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.services ADD COLUMN IF NOT EXISTS "healthCheckIntervalMs" INTEGER NOT NULL DEFAULT 10000, ADD COLUMN IF NOT EXISTS "unhealthyFallback" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "healthCheckProtocol" VARCHAR NOT NULL DEFAULT 'http', ADD COLUMN IF NOT EXISTS "healthCheckService" VARCHAR NOT NULL DEFAULT ''`,
        );
        await manager.query(
          `CREATE INDEX IF NOT EXISTS request_logs_export_cursor ON ${schema}.request_logs (timestamp, id)`,
        );
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.routes ADD COLUMN IF NOT EXISTS plugins JSONB`,
        );
        const columns = await manager.query<Array<{ column_name: string }>>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'routes'`,
          [schema],
        );
        // Convert each legacy policy only when an explicit plugin does not already
        // own it. Conversion and removal commit together; a failure preserves the
        // original policy and prevents starting with a partially upgraded schema.
        for (const [column, plugin, expression] of [
          [
            'maxBodyBytes',
            'request-size-limit',
            `jsonb_build_object('maxBodyBytes', "maxBodyBytes")`,
          ],
          ['cors', 'cors', 'cors::jsonb'],
          ['ipRestriction', 'ip-restriction', '"ipRestriction"::jsonb'],
        ]) {
          if (!columns.some((entry) => entry.column_name === column)) continue;
          await manager.query(
            `UPDATE ${schema}.routes
            SET plugins = COALESCE(plugins, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('name', $1::text, 'config', ${expression}))
            WHERE "${column}" IS NOT NULL AND NOT EXISTS
              (SELECT 1 FROM jsonb_array_elements(COALESCE(plugins, '[]'::jsonb)) p WHERE p->>'name' = $1)`,
            [plugin],
          );
          await manager.query(
            `ALTER TABLE ${schema}.routes DROP COLUMN "${column}"`,
          );
        }
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.consumers ADD COLUMN IF NOT EXISTS groups JSONB DEFAULT '[]'::jsonb`,
        );
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.routes ADD COLUMN IF NOT EXISTS graphql JSONB`,
        );
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.services ADD COLUMN IF NOT EXISTS h2 BOOLEAN DEFAULT false`,
        );
        await manager.query(
          `ALTER TABLE IF EXISTS ${schema}.services ADD COLUMN IF NOT EXISTS "supportsWebSocket" BOOLEAN DEFAULT false`,
        );
      }
      return tenants.length;
    });

    if (tenantCount > 0) {
      this.logger.log(`Migrated ${tenantCount} tenant schema(s)`);
    }
  }
}
