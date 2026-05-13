import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { matchRoute } from '../shared/route-matcher';
import type { ResponseWithLocals } from '../shared/request-context';

@Injectable()
export class IpRestrictionMiddleware implements NestMiddleware {
  constructor(private readonly configManager: GatewayConfigManagerService) {}

  use(req: Request, res: ResponseWithLocals, next: NextFunction): void {
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

    const requestId = this.ensureRequestId(req, res);
    const { allow, deny } = route.ipRestriction;
    const ip = this.extractIp(req);
    if (!ip) {
      next();
      return;
    }
    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) {
      this.respondForbidden(res, requestId);
      return;
    }

    // Deny takes precedence over allow
    if (deny?.some((cidr) => this.matchesCidr(normalizedIp, cidr))) {
      this.respondForbidden(res, requestId);
      return;
    }

    if (allow && allow.length > 0 && !allow.some((cidr) => this.matchesCidr(normalizedIp, cidr))) {
      this.respondForbidden(res, requestId);
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

  private normalizeIp(ip: string): string | null {
    if (ip.startsWith('::ffff:')) {
      const ipv4 = ip.slice(7);
      return this.toInt(ipv4) === null ? null : ipv4;
    }
    if (ip.includes(':')) {
      return null;
    }
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
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  private ensureRequestId(req: Request, res: ResponseWithLocals): string {
    const headerValue = req.headers['x-request-id'];
    const existing = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const requestId = existing ?? uuidv4();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.locals.requestId = requestId;
    return requestId;
  }

  private respondForbidden(res: ResponseWithLocals, requestId: string): void {
    res.status(403).json({ error: 'IP_RESTRICTED', message: 'Access denied from this IP address', requestId });
  }
}
