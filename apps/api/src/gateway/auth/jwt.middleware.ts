import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request } from 'express';
import { ConfigService } from '@nestjs/config';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { GatewayConfig } from '../../config/configuration';
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

interface JwtPayload {
  sub?: string;
  userId?: string;
  id?: string;
}

@Injectable()
export class JwtMiddleware implements NestMiddleware {
  private readonly logger = new Logger(JwtMiddleware.name);

  constructor(
    private readonly configService: ConfigService<GatewayConfig, true>,
    private readonly configManager: GatewayConfigManagerService,
  ) {}

  use(req: RequestWithUser, res: ResponseWithLocals, next: NextFunction): void {
    const requestId = this.ensureRequestId(req, res);
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      next();
      return;
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      this.respondUnauthorized(
        req,
        res,
        requestId,
        'TOKEN_INVALID',
        'Access token is invalid',
      );
      return;
    }

    const secret = this.configService.get('jwt', { infer: true }).secret;
    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      const userId = payload.sub ?? payload.userId ?? payload.id;
      if (userId) {
        req.user = { id: userId };
      }
      next();
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        this.respondUnauthorized(
          req,
          res,
          requestId,
          'TOKEN_EXPIRED',
          'Access token has expired',
        );
        return;
      }
      if (error instanceof JsonWebTokenError) {
        const hash = createHash('sha256').update(token).digest('hex');
        const consumer = this.configManager.getConfig()?.consumers.find(c => c.keyHash === hash);
        if (consumer) {
          req.user = { id: consumer.id };
          next();
          return;
        }
        this.respondUnauthorized(
          req,
          res,
          requestId,
          'TOKEN_INVALID',
          'Access token is invalid',
        );
        return;
      }
      this.logger.warn(
        JSON.stringify({
          msg: 'Unexpected JWT verification error',
          error: (error as Error).message,
          requestId,
        }),
      );
      this.respondUnauthorized(
        req,
        res,
        requestId,
        'TOKEN_INVALID',
        'Access token is invalid',
      );
    }
  }

  private ensureRequestId(req: Request, res: ResponseWithLocals): string {
    const headerValue = req.headers['x-request-id'];
    const existing = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const requestId = existing ?? uuidv4();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.locals.requestId = requestId;
    if (!res.locals.requestStart) {
      res.locals.requestStart = Date.now();
    }
    return requestId;
  }

  private respondUnauthorized(
    req: Request,
    res: ResponseWithLocals,
    requestId: string,
    code: 'TOKEN_EXPIRED' | 'TOKEN_INVALID',
    message: string,
  ): void {
    this.logRequest(req, res, requestId, 401);
    res.status(401).json({
      error: code,
      message,
      requestId,
    });
  }

  private logRequest(
    req: Request,
    res: ResponseWithLocals,
    requestId: string,
    statusCode: number,
  ): void {
    const start = res.locals.requestStart ?? Date.now();
    const responseTimeMs = Date.now() - start;
    const logEntry: Record<string, string | number | undefined> = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      statusCode,
      responseTimeMs,
      requestId,
    };

    if (req.ip) {
      logEntry.clientIp = req.ip;
    }

    this.logger.warn(JSON.stringify(logEntry));
  }
}
