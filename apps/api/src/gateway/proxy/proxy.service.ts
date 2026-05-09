import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import type * as net from 'net';
import type { Request } from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import type { Options } from 'http-proxy-middleware/dist/types';
import { v4 as uuidv4 } from 'uuid';
import type { RouteConfig, ServiceConfig } from '@api-gateway/shared-types';
import { GatewayError } from '../shared/gateway-error';
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly proxies = new Map<
    string,
    RequestHandler<http.IncomingMessage, http.ServerResponse>
  >();

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly metricsService: MetricsService,
  ) {}

  async forward(request: Request, response: ResponseWithLocals): Promise<void> {
    const originalUrl = request.originalUrl ?? request.url ?? '';
    const [pathWithoutQuery, query] = originalUrl.split('?');
    const baseUrl = request.baseUrl ?? '';
    const normalizedPath =
      baseUrl && pathWithoutQuery.startsWith(baseUrl)
        ? pathWithoutQuery.slice(baseUrl.length) || '/'
        : pathWithoutQuery || '/';

    const config = this.configManager.getConfig();
    if (!config) {
      throw new GatewayError('SERVICE_NOT_FOUND', 'No downstream service matches the path', 404);
    }

    const route = this.matchRoute(request.method, normalizedPath, config.routes);
    if (!route) {
      throw new GatewayError('SERVICE_NOT_FOUND', 'No downstream service matches the path', 404);
    }

    const user = (request as RequestWithUser).user;
    if (route.authRequired && !user) {
      throw new GatewayError('TOKEN_INVALID', 'Authentication required', 401);
    }

    const service = config.services.find((s: ServiceConfig) => s.id === route.serviceId);
    if (!service) {
      throw new GatewayError('SERVICE_NOT_FOUND', 'No downstream service matches the path', 404);
    }

    response.locals.downstreamService = service.name;
    const start = Date.now();
    const strippedPath = this.stripPrefix(normalizedPath, route.pathPattern);
    request.url = query ? `${strippedPath}?${query}` : strippedPath;

    await new Promise<void>((resolve, reject) => {
      const handler = this.getProxyHandler(service);
      const cleanup = () => {
        response.off('finish', onFinish);
        response.off('close', onFinish);
      };

      const onFinish = () => {
        response.locals.downstreamLatencyMs = Date.now() - start;
        cleanup();
        resolve();
      };

      response.once('finish', onFinish);
      response.once('close', onFinish);

      handler(request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse, (error?: unknown) => {
        cleanup();
        if (!error || response.headersSent) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }

  private matchRoute(method: string, path: string, routes: RouteConfig[]): RouteConfig | undefined {
    return routes.find((route: RouteConfig) => {
      if (!route.enabled) return false;
      const methodMatches =
        route.method.toUpperCase() === 'ANY' || route.method.toUpperCase() === method.toUpperCase();
      if (!methodMatches) return false;
      const pattern = route.pathPattern;
      if (pattern === '/') return true;
      return path === pattern || path.startsWith(`${pattern}/`);
    });
  }

  private getProxyHandler(
    service: ServiceConfig,
  ): RequestHandler<http.IncomingMessage, http.ServerResponse> {
    const cacheKey = `${service.id}:${service.targetUrl}`;
    const existing = this.proxies.get(cacheKey);
    if (existing) return existing;

    const timeoutMs = service.timeoutMs ?? 10000;
    const serviceName = service.name;

    const options: Options = {
      target: service.targetUrl,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: timeoutMs,
      timeout: timeoutMs,
      selfHandleResponse: true,
      on: {
        proxyReq: (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
          const requestIdHeader = req.headers['x-request-id'];
          const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
          if (requestId) proxyReq.setHeader('X-Request-ID', requestId);
          const forwardedFor = this.getForwardedFor(req);
          if (forwardedFor) proxyReq.setHeader('X-Forwarded-For', forwardedFor);
        },
        proxyRes: (proxyRes: http.IncomingMessage, req: http.IncomingMessage, res: http.ServerResponse) => {
          const statusCode = proxyRes.statusCode ?? 502;
          const requestIdHeader = req.headers['x-request-id'];
          const requestId =
            Array.isArray(requestIdHeader)
              ? requestIdHeader[0]
              : requestIdHeader ?? (res as unknown as ResponseWithLocals).locals?.requestId ?? uuidv4();
          if (statusCode >= 500) {
            proxyRes.resume();
            if (!res.headersSent) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  error: 'DOWNSTREAM_ERROR',
                  message: 'Downstream service error',
                  requestId,
                }),
              );
            }
            this.logger.error(
              JSON.stringify({
                msg: 'Downstream service returned 5xx',
                statusCode,
                downstreamService: serviceName,
                requestId,
              }),
            );
            return;
          }
          Object.entries(proxyRes.headers).forEach(([header, value]) => {
            if (value !== undefined) res.setHeader(header, value as string);
          });
          res.statusCode = statusCode;
          proxyRes.pipe(res);
        },
        error: (error: Error, req: http.IncomingMessage, res: http.ServerResponse | net.Socket) => {
          if (!(res instanceof http.ServerResponse)) return;
          const requestIdHeader = req.headers['x-request-id'];
          const requestId =
            Array.isArray(requestIdHeader)
              ? requestIdHeader[0]
              : requestIdHeader ?? (res as unknown as ResponseWithLocals).locals?.requestId ?? uuidv4();
          const nodeError = error as NodeJS.ErrnoException;
          if (this.isTimeoutError(nodeError)) {
            this.metricsService.incrementDownstreamTimeout(serviceName);
            this.logger.error(
              JSON.stringify({
                msg: 'Downstream request timed out',
                error: error.message,
                downstreamService: serviceName,
                requestId,
              }),
            );
            if (!res.headersSent) {
              res.statusCode = 504;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  error: 'DOWNSTREAM_TIMEOUT',
                  message: 'Downstream request timed out',
                  requestId,
                }),
              );
            }
            return;
          }
          this.logger.error(
            JSON.stringify({
              msg: 'Downstream proxy error',
              error: error.message,
              downstreamService: serviceName,
              requestId,
            }),
          );
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: 'DOWNSTREAM_ERROR',
                message: 'Downstream service error',
                requestId,
              }),
            );
          }
        },
      },
    };

    const handler = createProxyMiddleware(options) as unknown as RequestHandler<
      http.IncomingMessage,
      http.ServerResponse
    >;
    this.proxies.set(cacheKey, handler);
    return handler;
  }

  private stripPrefix(path: string, prefix: string): string {
    if (prefix === '/') return path;
    if (path === prefix) return '/';
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
    return path;
  }

  private isTimeoutError(error: NodeJS.ErrnoException): boolean {
    return error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT';
  }

  private getForwardedFor(request: http.IncomingMessage): string | undefined {
    const req = request as Request;
    if (Array.isArray(req.ips) && req.ips.length > 0) return req.ips.join(', ');
    return req.ip ?? undefined;
  }
}
