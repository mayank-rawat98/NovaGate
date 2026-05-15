import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';
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

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const config = this.resolveConfig(ctx);
    if (!config) return;

    const { allow, deny } = config;
    const ip = this.extractIp(ctx.req as IncomingMessage);
    if (!ip) return;

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
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = Array.isArray(fwd) ? fwd[0] : fwd;
      return first.split(',')[0].trim();
    }
    return (req.socket as { remoteAddress?: string })?.remoteAddress ?? null;
  }

  private normalizeIp(ip: string): string | null {
    if (ip.startsWith('::ffff:')) {
      const v4 = ip.slice(7);
      return this.toInt(v4) === null ? null : v4;
    }
    if (ip.includes(':')) return null;
    return this.toInt(ip) === null ? null : ip;
  }

  private matchesCidr(ip: string, cidr: string): boolean {
    if (!cidr.includes('/')) return ip === cidr;
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits) || bits < 0 || bits > 32) return false;
    const ipInt = this.toInt(ip);
    const rangeInt = this.toInt(range);
    if (ipInt === null || rangeInt === null) return false;
    if (bits === 0) return true;
    const mask = (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) >>> 0 === (rangeInt & mask) >>> 0;
  }

  private toInt(ip: string): number | null {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
      return null;
    return (
      ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
    );
  }
}
