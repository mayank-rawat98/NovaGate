import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  GATEWAY_INSTANCE_STALE_MS,
  isControlPlaneRegion,
  type ControlPlaneRegionsState,
  type GatewayInstance,
} from '@api-gateway/shared-types';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';

/** Disconnected gateways stay listed for a day. */
const RETAIN_DISCONNECTED_MS = 86400000;
const MAX_LISTED_GATEWAYS = 100;

/** Validates CONTROL_PLANE_REGIONS ("us-east,eu-west") at startup. */
export function controlPlaneRegions(value: unknown): string[] {
  if (value === undefined || value === '') return [];
  const regions = String(value)
    .split(',')
    .map((region) => region.trim());
  if (
    regions.length > 8 ||
    !regions.every(isControlPlaneRegion) ||
    new Set(regions).size !== regions.length
  )
    throw new Error(
      'CONTROL_PLANE_REGIONS must list up to 8 unique regions such as us-east,eu-west',
    );
  return regions;
}

@Injectable()
export class RegionsService {
  readonly regions: string[];

  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
    config: ConfigService,
  ) {
    this.regions = controlPlaneRegions(config.get('CONTROL_PLANE_REGIONS'));
  }

  private id(tenantId: string) {
    const id = tenantId.toLowerCase();
    tenantSchema(id);
    return id;
  }

  async get(
    tenantId: string,
    now = new Date(),
  ): Promise<ControlPlaneRegionsState> {
    const id = this.id(tenantId);
    const [tenant] = await this.db.query(
      `SELECT "preferredRegion","gatewayConfigVersion" FROM public.tenants WHERE id=$1`,
      [id],
    );
    if (!tenant) throw new NotFoundException('Workspace not found');
    await this.db.query(
      `DELETE FROM public.gateway_instances WHERE "tenantId"=$1 AND "lastSeenAt" < $2`,
      [id, new Date(now.getTime() - RETAIN_DISCONNECTED_MS)],
    );
    const rows = await this.db.query(
      `SELECT "instanceId",name,region,"connectedAt","lastSeenAt","disconnectedAt","configVersion"
         FROM public.gateway_instances WHERE "tenantId"=$1
        ORDER BY "disconnectedAt" IS NOT NULL, "lastSeenAt" DESC LIMIT $2`,
      [id, MAX_LISTED_GATEWAYS],
    );
    const gateways: GatewayInstance[] = rows.map(
      (row: {
        instanceId: string;
        name: string;
        region: string | null;
        connectedAt: Date;
        lastSeenAt: Date;
        disconnectedAt: Date | null;
        configVersion: string | null;
      }) => ({
        instanceId: row.instanceId,
        name: row.name,
        region: row.region,
        connectedAt: row.connectedAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
        configVersion:
          row.configVersion === null ? null : Number(row.configVersion),
        // Heartbeats refresh lastSeenAt every 30s; a dead region stops them.
        online:
          row.disconnectedAt === null &&
          now.getTime() - row.lastSeenAt.getTime() < GATEWAY_INSTANCE_STALE_MS,
      }),
    );
    return {
      regions: this.regions,
      preferredRegion: tenant.preferredRegion,
      configVersion: tenant.gatewayConfigVersion,
      gateways,
    };
  }

  async save(
    tenantId: string,
    input: unknown,
  ): Promise<ControlPlaneRegionsState> {
    const id = this.id(tenantId);
    const body = input as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('preferredRegion' in body) ||
      (body.preferredRegion !== null &&
        !this.regions.includes(body.preferredRegion as string))
    )
      throw new BadRequestException(
        this.regions.length
          ? `preferredRegion must be one of ${this.regions.join(', ')}, or null`
          : 'This installation has one control plane region; preferredRegion must be null',
      );
    const preferred = body.preferredRegion as string | null;
    const payload = await this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        `SELECT "preferredRegion" FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('Workspace not found');
      if (row.preferredRegion === preferred) return undefined;
      await manager.query(
        `UPDATE public.tenants SET "preferredRegion"=$2 WHERE id=$1`,
        [id, preferred],
      );
      return this.push.persistUpdate(id, manager);
    });
    // Persisted with the change; delivery retries and region sync repair it.
    if (payload) await this.push.publish(payload);
    return this.get(id);
  }
}
