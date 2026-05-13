import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { matchRoute } from '../shared/route-matcher';
import type { ResponseWithLocals } from '../shared/request-context';

@Injectable()
export class RequestSizeLimitMiddleware implements NestMiddleware {
  constructor(private readonly configManager: GatewayConfigManagerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const config = this.configManager.getConfig();
    if (!config) {
      next();
      return;
    }

    const route = matchRoute(req.method, req.path, config.routes);
    if (!route?.maxBodyBytes) {
      next();
      return;
    }

    const limit = route.maxBodyBytes;
    const contentLength = parseInt(req.headers['content-length'] ?? '', 10);

    if (!isNaN(contentLength) && contentLength > limit) {
      const requestId = this.getRequestId(req, res);
      res.status(413).json({
        error: 'REQUEST_TOO_LARGE',
        message: 'Request body exceeds the configured size limit',
        requestId,
      });
      return;
    }

    next();
  }

  private getRequestId(req: Request, res: Response): string {
    const headerValue = req.headers['x-request-id'];
    const existing = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const locals = (res as ResponseWithLocals).locals;
    const requestId = existing ?? locals?.requestId ?? uuidv4();
    if (!existing) {
      req.headers['x-request-id'] = requestId;
    }
    res.setHeader('X-Request-ID', requestId);
    if (locals) {
      locals.requestId = requestId;
    }
    return requestId;
  }
}
