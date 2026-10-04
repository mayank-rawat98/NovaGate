import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import { BlockList, isIP } from 'net';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

interface IpRestrictionConfig {
  allow?: string[];
  deny?: string[];
}

@Injectable()
export class IpRestrictionPlugin implements GatewayPlugin {
  readonly name = 'ip-restriction';
  readonly protocols = ['http', 'grpc'] as const;

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const config = this.resolveConfig(ctx);
    if (!config) return;

    const { allow, deny } = config;
    const ip = this.extractIp(ctx.req as IncomingMessage);
    if (!ip) return this.forbidden(ctx.requestId);

    const normalized = this.normalizeIp(ip);
    if (!normalized) return this.forbidden(ctx.requestId);

    if (deny?.some((cidr) => this.matchesCidr(normalized, cidr))) {
      return this.forbidden(ctx.requestId);
    }

    if (
      allow &&
      allow.length > 0 &&
      !allow.some((cidr) => this.matchesCidr(normalized, cidr))
    ) {
      return this.forbidden(ctx.requestId);
    }
  }

  private resolveConfig(ctx: PluginContext): IpRestrictionConfig | undefined {
    const entry = ctx.route.plugins?.find((p) => p.name === 'ip-restriction');
    return entry ? (entry.config as unknown as IpRestrictionConfig) : undefined;
  }

  private forbidden(requestId: string): PluginShortCircuit {
    return {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'IP_RESTRICTED',
        message: 'Access denied from this IP address',
        requestId,
      }),
    };
  }

  private extractIp(req: IncomingMessage): string | null {
    // Express computes ip using the configured trust-proxy policy. Never trust
    // a client-supplied forwarding header directly. Raw upgrades use the peer.
    const ip = (req as IncomingMessage & { ip?: string }).ip;
    if (ip) return ip;
    return (req.socket as { remoteAddress?: string })?.remoteAddress ?? null;
  }

  private normalizeIp(ip: string): string | null {
    if (ip.startsWith('::ffff:')) {
      const v4 = ip.slice(7);
      return isIP(v4) === 4 ? v4 : null;
    }
    return isIP(ip) ? ip : null;
  }

  private matchesCidr(ip: string, cidr: string): boolean {
    const [range, prefix] = cidr.split('/');
    const version = isIP(range);
    if (!version || cidr.split('/').length > 2)
      throw new Error('Invalid IP restriction CIDR');
    const type = version === 4 ? 'ipv4' : 'ipv6';
    const list = new BlockList();
    if (prefix === undefined) list.addAddress(range, type);
    else {
      const bits = Number(prefix);
      if (
        !/^\d+$/.test(prefix) ||
        !Number.isInteger(bits) ||
        bits > (version === 4 ? 32 : 128)
      )
        throw new Error('Invalid IP restriction CIDR');
      list.addSubnet(range, bits, type);
    }
    return list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  }
}
