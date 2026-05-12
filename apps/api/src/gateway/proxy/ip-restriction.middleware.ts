import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { matchRoute } from '../shared/route-matcher';

@Injectable()
export class IpRestrictionMiddleware implements NestMiddleware {
  constructor(private readonly configManager: GatewayConfigManagerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const config = this.configManager.getConfig();
    if (!config) {
      next();
      return;
    }

    const route = matchRoute(req.method, req.path, config.routes);
    if (!route?.ipRestriction) {
      next();
      return;
    }

    const { allow, deny } = route.ipRestriction;
    const ip = this.extractIp(req);
    if (!ip) {
      next();
      return;
    }

    // Deny takes precedence over allow
    if (deny?.some((cidr) => this.matchesCidr(ip, cidr))) {
      res.status(403).json({ error: 'IP_RESTRICTED', message: 'Access denied from this IP address' });
      return;
    }

    if (allow && allow.length > 0 && !allow.some((cidr) => this.matchesCidr(ip, cidr))) {
      res.status(403).json({ error: 'IP_RESTRICTED', message: 'Access denied from this IP address' });
      return;
    }

    next();
  }

  private extractIp(req: Request): string | null {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = Array.isArray(fwd) ? fwd[0] : fwd;
      return first.split(',')[0].trim();
    }
    return req.ip ?? null;
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
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }
}
