import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type {
  LogExportDestination,
  LogExportDestinationList,
  LogExportDestinationType,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';
import { REVOKE_DESTINATION_DELIVERIES_SQL } from './export-delivery-schema';
import { outboundTrustedOrigins } from '../shared/outbound-egress-policy';
import {
  destinationCredentials,
  destinationName,
  destinationRecord,
  destinationUuid,
} from './export-destination-input';

export const EXPORT_DESTINATION_LIMIT = 10;
interface DestinationRow {
  id: string;
  revision: string;
  name: string;
  type: LogExportDestinationType;
  destination: string;
  credentials: unknown;
  created_at: Date;
  updated_at: Date;
  schedule_enabled?: boolean | null;
}

/** Credentials remain private to this service; controllers return explicit projections. */
@Injectable()
export class ExportDestinationsService implements OnModuleDestroy {
  private readonly cipher: ExportDestinationCredentialCipher;
  private readonly trustedOrigins: ReadonlySet<string>;
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();
  constructor(
    private readonly db: DataSource,
    config: ConfigService,
  ) {
    this.trustedOrigins = outboundTrustedOrigins(
      config.get('LOG_EXPORT_HTTP_TRUSTED_ORIGINS'),
      'LOG_EXPORT_HTTP_TRUSTED_ORIGINS',
    );
    this.cipher = new ExportDestinationCredentialCipher({
      LOG_EXPORT_DESTINATION_KEYS: config.get('LOG_EXPORT_DESTINATION_KEYS'),
      LOG_EXPORT_DESTINATION_ACTIVE_KEY: config.get(
        'LOG_EXPORT_DESTINATION_ACTIVE_KEY',
      ),
    });
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.operations]);
    this.cipher.destroy();
  }
  private tenant(id: string) {
    tenantSchema(id);
    return id.toLowerCase();
  }
  private async admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping || this.operations.size >= 8)
      throw new ServiceUnavailableException(
        'Export destination settings are busy. Try again shortly.',
      );
    const work = operation();
    this.operations.add(work);
    try {
      return await work;
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driver = error.driverError as { code?: unknown };
        if (driver.code === '55P03' || driver.code === '57014')
          throw new ServiceUnavailableException(
            'Export destination settings are busy. Try again shortly.',
          );
      }
      throw error;
    } finally {
      this.operations.delete(work);
    }
  }
  private async bounded(manager: EntityManager) {
    await manager.query(
      "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
    );
  }
  private writable() {
    if (!this.cipher.enabled)
      throw new ServiceUnavailableException(
        'Export destination configuration is not enabled.',
      );
  }
  private readCredentials(tenant: string, row: DestinationRow) {
    try {
      const normalized = destinationCredentials(
        this.cipher.decrypt(tenant, row.id, row.type, row.credentials),
        this.trustedOrigins,
      );
      if (normalized.credentials.type !== row.type) throw new Error();
      return normalized.credentials;
    } catch {
      throw new ServiceUnavailableException(
        'Export destination credentials are unavailable.',
      );
    }
  }
  private view(tenant: string, row: DestinationRow): LogExportDestination {
    let credentialStatus: LogExportDestination['credentialStatus'] =
      'available';
    try {
      this.readCredentials(tenant, row);
    } catch {
      credentialStatus = 'unavailable';
    }
    return {
      id: row.id,
      revision: row.revision,
      name: row.name,
      type: row.type,
      destination: row.destination,
      state:
        row.schedule_enabled == null
          ? 'draft'
          : row.schedule_enabled
            ? 'enabled'
            : 'paused',
      credentialStatus,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
  async list(tenantId: string): Promise<LogExportDestinationList> {
    const tenant = this.tenant(tenantId);
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const rows: DestinationRow[] = await manager.query(
          `SELECT d.id,d.revision,d.name,d.type,d.destination,d.credentials,d.created_at,d.updated_at,s.enabled AS schedule_enabled
          FROM public.log_export_destinations d LEFT JOIN public.log_export_delivery_schedules s ON s.destination_id=d.id AND s.tenant_id=d.tenant_id
         WHERE d.tenant_id=$1 AND d.deleted_at IS NULL ORDER BY d.created_at,d.id LIMIT $2`,
          [tenant, EXPORT_DESTINATION_LIMIT],
        );
        return {
          configurationAvailable: this.cipher.enabled,
          deliveryAvailable: this.cipher.enabled,
          limit: EXPORT_DESTINATION_LIMIT,
          destinations: rows.map((row) => this.view(tenant, row)),
        };
      }),
    );
  }
  async create(tenantId: string, body: unknown): Promise<LogExportDestination> {
    const tenant = this.tenant(tenantId);
    const input = destinationRecord(body, ['name', 'credentials']);
    const name = destinationName(input.name);
    const connection = destinationCredentials(input.credentials);
    this.writable();
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        // Serializes all replica admission for this tenant without global contention.
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`export-destinations:${tenant}`],
        );
        const [{ count }]: Array<{ count: number }> = await manager.query(
          'SELECT COUNT(*)::integer AS count FROM public.log_export_destinations WHERE tenant_id=$1 AND deleted_at IS NULL',
          [tenant],
        );
        if (count >= EXPORT_DESTINATION_LIMIT)
          throw new ConflictException(
            'Remove an existing destination before adding another.',
          );
        const id = randomUUID();
        const encrypted = this.cipher.encrypt(
          tenant,
          id,
          connection.credentials.type,
          connection.credentials,
        );
        const [row]: DestinationRow[] = await manager.query(
          `INSERT INTO public.log_export_destinations (id,tenant_id,revision,name,type,destination,credentials)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
          [
            id,
            tenant,
            randomUUID(),
            name,
            connection.credentials.type,
            connection.destination,
            JSON.stringify(encrypted),
          ],
        );
        return this.view(tenant, row);
      }),
    );
  }
  private async current(
    manager: EntityManager,
    tenant: string,
    id: string,
    expected: string,
  ) {
    const [row]: DestinationRow[] = await manager.query(
      `SELECT d.*,(SELECT s.enabled FROM public.log_export_delivery_schedules s WHERE s.tenant_id=d.tenant_id AND s.destination_id=d.id) AS schedule_enabled
       FROM public.log_export_destinations d WHERE d.tenant_id=$1 AND d.id=$2 AND d.deleted_at IS NULL FOR UPDATE OF d`,
      [tenant, id],
    );
    if (!row) throw new NotFoundException('Export destination not found.');
    if (row.revision !== expected)
      throw new ConflictException(
        'The export destination changed. Refresh before saving.',
      );
    return row;
  }
  async update(
    tenantId: string,
    destinationId: string,
    body: unknown,
  ): Promise<LogExportDestination> {
    const tenant = this.tenant(tenantId),
      id = destinationUuid(destinationId);
    const input = destinationRecord(body, [
      'name',
      'credentials',
      'expectedRevision',
    ]);
    const expected = destinationUuid(input.expectedRevision),
      name = destinationName(input.name);
    const replacement = Object.hasOwn(input, 'credentials')
      ? destinationCredentials(input.credentials)
      : undefined;
    if (replacement) this.writable();
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const current = await this.current(manager, tenant, id, expected);
        if (replacement && replacement.credentials.type !== current.type)
          throw new BadRequestException(
            'Credential replacement must keep the destination type.',
          );
        const encrypted = replacement
          ? this.cipher.encrypt(
              tenant,
              id,
              current.type,
              replacement.credentials,
            )
          : current.credentials;
        const [row]: DestinationRow[] = await manager.query(
          `WITH changed AS (UPDATE public.log_export_destinations SET name=$3,revision=$4,destination=$5,credentials=$6::jsonb,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 RETURNING *) SELECT * FROM changed`,
          [
            tenant,
            id,
            name,
            randomUUID(),
            replacement?.destination ?? current.destination,
            JSON.stringify(encrypted),
          ],
        );
        await manager.query(REVOKE_DESTINATION_DELIVERIES_SQL, [tenant, id]);
        return this.view(tenant, {
          ...row,
          schedule_enabled: current.schedule_enabled,
        });
      }),
    );
  }
  async rotateKey(
    tenantId: string,
    destinationId: string,
    body: unknown,
  ): Promise<LogExportDestination> {
    const tenant = this.tenant(tenantId),
      id = destinationUuid(destinationId);
    const input = destinationRecord(body, ['expectedRevision']);
    const expected = destinationUuid(input.expectedRevision);
    this.writable();
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const current = await this.current(manager, tenant, id, expected);
        const credentials = this.readCredentials(tenant, current);
        const encrypted = this.cipher.encrypt(
          tenant,
          id,
          current.type,
          credentials,
        );
        const [row]: DestinationRow[] = await manager.query(
          `WITH changed AS (UPDATE public.log_export_destinations SET credentials=$3::jsonb,revision=$4,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 RETURNING *) SELECT * FROM changed`,
          [tenant, id, JSON.stringify(encrypted), randomUUID()],
        );
        await manager.query(REVOKE_DESTINATION_DELIVERIES_SQL, [tenant, id]);
        return this.view(tenant, {
          ...row,
          schedule_enabled: current.schedule_enabled,
        });
      }),
    );
  }
  async remove(
    tenantId: string,
    destinationId: string,
    body: unknown,
  ): Promise<void> {
    const tenant = this.tenant(tenantId),
      id = destinationUuid(destinationId);
    const input = destinationRecord(body, ['expectedRevision']);
    const expected = destinationUuid(input.expectedRevision);
    return this.admitted(() =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        await this.current(manager, tenant, id, expected);
        // Keep stable identity for later durable delivery history; destroy stored secrets.
        await manager.query(
          `UPDATE public.log_export_destinations SET credentials=NULL,deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=$3
         WHERE tenant_id=$1 AND id=$2`,
          [tenant, id, randomUUID()],
        );
        await manager.query(REVOKE_DESTINATION_DELIVERIES_SQL, [tenant, id]);
      }),
    );
  }
}
