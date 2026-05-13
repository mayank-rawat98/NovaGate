import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { matchRoute } from '../shared/route-matcher';
import type { RouteConfig } from '@api-gateway/shared-types';

@Injectable()
export class CorsMiddleware implements NestMiddleware {
  constructor(private readonly configManager: GatewayConfigManagerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const config = this.configManager.getConfig();
    if (!config) {
      next();
      return;
    }

    const preflightHeader = req.headers['access-control-request-method'];
    const preflightMethod = Array.isArray(preflightHeader) ? preflightHeader[0] : preflightHeader;
    const method = req.method === 'OPTIONS' ? (preflightMethod ?? 'ANY') : req.method;
    const route = matchRoute(method, req.path, config.routes) ??
      matchRoute(req.method, req.path, config.routes);

    if (!route?.cors) {
      next();
      return;
    }

    this.applyCorsHeaders(req, res, route);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  }

  private applyCorsHeaders(req: Request, res: Response, route: RouteConfig): void {
    const cors = route.cors!;
    const originHeader = req.headers['origin'];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;

    const allowOrigin = this.resolveOrigin(cors.origins, origin, cors.credentials);
    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      if (allowOrigin !== '*') {
        this.appendVary(res, 'Origin');
      }
    }

    if (cors.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
      const routeMethod = route.method.toUpperCase();
      const methods = cors.methods ?? (routeMethod === 'ANY'
        ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
        : [routeMethod]);

      const baseHeaders = ['Content-Type', 'Authorization', 'X-Request-ID'];
      const allowedHeaders = [...baseHeaders, ...(cors.headers ?? [])];

      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', String(cors.maxAge ?? 86400));
    }
  }

  private resolveOrigin(
    allowedOrigins: string[],
    origin: string | undefined,
    credentials?: boolean,
  ): string | undefined {
    if (!origin) return allowedOrigins.includes('*') && !credentials ? '*' : undefined;
    if (allowedOrigins.includes('*')) {
      return credentials ? origin : '*';
    }
    if (allowedOrigins.includes(origin)) {
      return origin;
    }
    return undefined;
  }

  private appendVary(res: Response, value: string): void {
    const existing = res.getHeader('Vary');
    if (!existing) {
      res.setHeader('Vary', value);
      return;
    }
    const current = Array.isArray(existing) ? existing.join(',') : String(existing);
    const values = current.split(',').map((v) => v.trim()).filter(Boolean);
    if (!values.includes(value)) {
      values.push(value);
      res.setHeader('Vary', values.join(', '));
    }
  }
}
