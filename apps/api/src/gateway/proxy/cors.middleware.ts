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

    // For OPTIONS preflight, try matching against ANY method so the route is found
    const method = req.method === 'OPTIONS' ? 'ANY' : req.method;
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
    const origin = req.headers['origin'] as string | undefined;

    if (origin) {
      if (cors.origins.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (cors.origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
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
}
