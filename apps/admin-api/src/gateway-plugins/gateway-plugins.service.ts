import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  MAX_THIRD_PARTY_PLUGINS,
  disabledPluginList,
  isThirdPartyPluginName,
  type GatewayPluginState,
} from '@api-gateway/shared-types';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';

/**
 * Workspace view of third-party gateway plugins: what the gateway last
 * reported, and the workspace-wide kill switch that fails their routes closed.
 */
@Injectable()
export class GatewayPluginsService {
  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
  ) {}

  async get(tenantId: string): Promise<GatewayPluginState> {
    const id = tenantId.toLowerCase();
    tenantSchema(id);
    const [row] = await this.db.query(
      `SELECT "disabledPlugins" FROM public.tenants WHERE id=$1`,
      [id],
    );
    if (!row) throw new NotFoundException('Workspace not found');
    return {
      ...(await this.push.pluginReport(id)),
      disabled: disabledPluginList(row.disabledPlugins),
    };
  }

  async save(tenantId: string, input: unknown): Promise<GatewayPluginState> {
    const id = tenantId.toLowerCase();
    tenantSchema(id);
    const body = input as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Array.isArray(body.disabled) ||
      body.disabled.length > MAX_THIRD_PARTY_PLUGINS ||
      !body.disabled.every(isThirdPartyPluginName) ||
      new Set(body.disabled).size !== body.disabled.length
    )
      throw new BadRequestException(
        `disabled must list at most ${MAX_THIRD_PARTY_PLUGINS} unique scoped plugin names`,
      );
    const disabled = [...(body.disabled as string[])].sort();
    const payload = await this.db.transaction(async (manager) => {
      const [row] = await manager.query(
        `SELECT "disabledPlugins" FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('Workspace not found');
      if (
        JSON.stringify(disabledPluginList(row.disabledPlugins)) ===
        JSON.stringify(disabled)
      )
        return undefined;
      await manager.query(
        `UPDATE public.tenants SET "disabledPlugins"=$2::jsonb WHERE id=$1`,
        [id, JSON.stringify(disabled)],
      );
      return this.push.persistUpdate(id, manager);
    });
    // Persisted with the change; the retry loop redelivers if this fails.
    if (payload) await this.push.publish(payload);
    return this.get(id);
  }
}
