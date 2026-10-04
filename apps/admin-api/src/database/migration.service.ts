import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class MigrationService implements OnModuleInit {
  private readonly logger = new Logger(MigrationService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.migrateAllTenants();
  }

  private async migrateAllTenants(): Promise<void> {
    await this.dataSource.query(`ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS "passwordHash" VARCHAR,
      ADD COLUMN IF NOT EXISTS "resetPasswordToken" VARCHAR,
      ADD COLUMN IF NOT EXISTS "resetPasswordExpires" TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "verifyToken" VARCHAR,
      ADD COLUMN IF NOT EXISTS "verifyExpires" TIMESTAMP`);
    // One durable latest update per tenant. Older installations may contain duplicates.
    await this.dataSource.query(`
      DELETE FROM public.pending_config_updates a USING public.pending_config_updates b
      WHERE a."tenantId" = b."tenantId" AND (a."createdAt", a.id) < (b."createdAt", b.id)
    `);
    await this.dataSource.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS pending_config_updates_tenant_unique ON public.pending_config_updates ("tenantId")`,
    );
    // Public schema migrations
    try {
      await this.dataSource.query(
        `ALTER TABLE IF EXISTS public.tenants ADD COLUMN IF NOT EXISTS "caCertPem" TEXT`,
      );
    } catch (err) {
      this.logger.warn(
        `Could not migrate public.tenants: ${(err as Error).message}`,
      );
    }

    const tenants = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM public.tenants`,
    );

    for (const tenant of tenants) {
      const schema = `tenant_${tenant.id.replace(/-/g, '_')}`;
      try {
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.routes ADD COLUMN IF NOT EXISTS plugins JSONB`,
        );
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.routes DROP COLUMN IF EXISTS "maxBodyBytes"`,
        );
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.routes DROP COLUMN IF EXISTS cors`,
        );
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.routes DROP COLUMN IF EXISTS "ipRestriction"`,
        );
        // Phase 2: consumer groups
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.consumers ADD COLUMN IF NOT EXISTS groups JSONB DEFAULT '[]'::jsonb`,
        );
        // Protocol expansion: GraphQL guard config + HTTP/2 / WebSocket flags
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.routes ADD COLUMN IF NOT EXISTS graphql JSONB`,
        );
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.services ADD COLUMN IF NOT EXISTS h2 BOOLEAN DEFAULT false`,
        );
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS ${schema}.services ADD COLUMN IF NOT EXISTS "supportsWebSocket" BOOLEAN DEFAULT false`,
        );
      } catch (err) {
        this.logger.warn(
          `Could not migrate schema ${schema}: ${(err as Error).message}`,
        );
      }
    }

    if (tenants.length > 0) {
      this.logger.log(`Migrated ${tenants.length} tenant schema(s)`);
    }
  }
}
