import { Injectable } from '@nestjs/common';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service.js';

interface AclConfig {
  allow?: string[];
  deny?: string[];
}

@Injectable()
export class AclPlugin implements GatewayPlugin {
  readonly name = 'acl';
  readonly protocols = ['http', 'grpc'] as const;

  constructor(private readonly configManager: GatewayConfigManagerService) {}

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === 'acl');
    if (!entry) return;

    const config = entry.config as unknown as AclConfig;
    const { allow, deny } = config;

    // If no rules configured, pass through
    if (!allow?.length && !deny?.length) return;

    const consumerId = ctx.req.user?.id;
    if (!consumerId) {
      return this.forbidden(
        ctx.requestId,
        'Consumer identity required for ACL check',
      );
    }

    const tenantConfig = this.configManager.getConfig();
    const consumer = tenantConfig?.consumers.find((c) => c.id === consumerId);
    const groups = consumer?.groups ?? [];

    // Deny takes precedence
    if (deny?.length && groups.some((g) => deny.includes(g))) {
      return this.forbidden(ctx.requestId, 'Consumer group is denied access');
    }

    if (allow?.length && !groups.some((g) => allow.includes(g))) {
      return this.forbidden(
        ctx.requestId,
        'Consumer group is not allowed access',
      );
    }
  }

  private forbidden(requestId: string, message: string): PluginShortCircuit {
    return {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ACL_DENIED', message, requestId }),
    };
  }
}
