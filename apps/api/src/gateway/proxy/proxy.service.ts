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
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';

// Per-request context attached to the request object so cached handlers can
// read retry state without holding per-request closures.
interface RetryContext {
  retryOn: number[];
  isLastAttempt: boolean;
  serviceName: string;
  resolve: (statusCode: number) => void;
}

const RETRY_DELAY_MS = 100;

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  // Handlers are cached per target URL; the retry context on `req` drives behavior.
  private readonly handlers = new Map<string, RequestHandler<http.IncomingMessage, http.ServerResponse>>();

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly metricsService: MetricsService,
    private readonly loadBalancer: LoadBalancerService,
    private readonly upstreamHealth: UpstreamHealthService,
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

    const route = matchRoute(request.method, normalizedPath, config.routes);
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

    // Strip prefix once and reuse across all retry attempts
    const strippedPath = this.stripPrefix(normalizedPath, route.pathPattern);
    const finalUrl = query ? `${strippedPath}?${query}` : strippedPath;

    const retryConfig = route.retry;
    const maxAttempts = retryConfig ? retryConfig.attempts + 1 : 1;
    const retryOn = retryConfig?.on ?? [502, 503, 504];
    const retryMethods = retryConfig?.methods ?? ['GET', 'HEAD', 'OPTIONS'];
    const canRetry = maxAttempts > 1 && retryMethods.includes(request.method.toUpperCase());

    const healthyUrls = this.upstreamHealth.getHealthyUrls(service.targets);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const isLastAttempt = attempt === maxAttempts - 1;
      const targetUrl = this.loadBalancer.selectTarget(service.id, service.targets, healthyUrls);

      // Reset the URL for each attempt (safe for GET/HEAD/OPTIONS which have no body)
      request.url = finalUrl;

      const statusCode = await this.callProxy(
        targetUrl,
        service,
        request,
        response,
        isLastAttempt,
        retryOn,
      );

      if (canRetry && !isLastAttempt && retryOn.includes(statusCode)) {
        this.metricsService.incrementProxyRetry(route.pathPattern, attempt + 1);
        if (attempt > 0) {
          await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }
      break;
    }

    response.locals.downstreamLatencyMs = Date.now() - start;
  }

  private callProxy(
    targetUrl: string,
    service: ServiceConfig,
    request: Request,
    response: ResponseWithLocals,
    isLastAttempt: boolean,
    retryOn: number[],
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      let settled = false;
      const resolveOnce = (code: number) => {
        if (!settled) {
          settled = true;
          delete (request as any).__gw_retry;
          resolve(code);
        }
      };

      (request as any).__gw_retry = {
        retryOn,
        isLastAttempt,
        serviceName: service.name,
        resolve: resolveOnce,
      } satisfies RetryContext;

      const handler = this.getHandler(targetUrl, service.timeoutMs ?? 10_000);

      // Fallback: if the handler calls next() without a proxyRes/error event
      const onFinish = () => resolveOnce(response.statusCode ?? 200);
      response.once('finish', onFinish);

      handler(
        request as unknown as http.IncomingMessage,
        response as unknown as http.ServerResponse,
        (err?: unknown) => {
          response.off('finish', onFinish);
          if (err && !response.headersSent) {
            resolveOnce(502);
          } else {
            resolveOnce(response.statusCode ?? 200);
          }
        },
      );
    });
  }

  private getHandler(
    targetUrl: string,
    timeoutMs: number,
  ): RequestHandler<http.IncomingMessage, http.ServerResponse> {
    const cached = this.handlers.get(targetUrl);
    if (cached) return cached;

    const options: Options = {
      target: targetUrl,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: timeoutMs,
      timeout: timeoutMs,
      selfHandleResponse: true,
      on: {
        proxyReq: (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
          const rid = req.headers['x-request-id'];
          const requestId = Array.isArray(rid) ? rid[0] : rid;
          if (requestId) proxyReq.setHeader('X-Request-ID', requestId);
          const fwd = this.getForwardedFor(req);
          if (fwd) proxyReq.setHeader('X-Forwarded-For', fwd);
        },

        proxyRes: (
          proxyRes: http.IncomingMessage,
          req: http.IncomingMessage,
          res: http.ServerResponse,
        ) => {
          const statusCode = proxyRes.statusCode ?? 502;
          const ctx: RetryContext | undefined = (req as any).__gw_retry;
          const requestId = this.getRequestId(req, res);

          if (ctx && !ctx.isLastAttempt && ctx.retryOn.includes(statusCode)) {
            proxyRes.resume();
            ctx.resolve(statusCode);
            return;
          }

          if (statusCode >= 500) {
            proxyRes.resume();
            this.logger.error(
              JSON.stringify({
                msg: 'Downstream service returned 5xx',
                statusCode,
                downstreamService: ctx?.serviceName,
                requestId,
              }),
            );
            if (!res.headersSent) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'DOWNSTREAM_ERROR', message: 'Downstream service error', requestId }));
            }
            ctx?.resolve(statusCode);
            return;
          }

          Object.entries(proxyRes.headers).forEach(([header, value]) => {
            if (value !== undefined) res.setHeader(header, value as string);
          });
          res.statusCode = statusCode;
          proxyRes.pipe(res);
          ctx?.resolve(statusCode);
        },

        error: (error: Error, req: http.IncomingMessage, res: http.ServerResponse | net.Socket) => {
          const ctx: RetryContext | undefined = (req as any).__gw_retry;
          const nodeError = error as NodeJS.ErrnoException;
          const isTimeout = this.isTimeoutError(nodeError);
          const statusCode = isTimeout ? 504 : 502;

          // Signal retry without sending a response
          if (ctx && !ctx.isLastAttempt && ctx.retryOn.includes(statusCode)) {
            ctx.resolve(statusCode);
            return;
          }

          // Send HTTP response when res is a ServerResponse or a mock that quacks like one
          const httpRes = res instanceof http.ServerResponse
            ? res
            : ('statusCode' in res ? (res as unknown as http.ServerResponse) : null);
          if (httpRes) {
            const requestId = this.getRequestId(req, httpRes);
            if (isTimeout) {
              this.metricsService.incrementDownstreamTimeout(ctx?.serviceName ?? 'unknown');
            }
            this.logger.error(
              JSON.stringify({
                msg: isTimeout ? 'Downstream request timed out' : 'Downstream proxy error',
                error: error.message,
                downstreamService: ctx?.serviceName,
                requestId,
              }),
            );
            if (!httpRes.headersSent) {
              httpRes.statusCode = statusCode;
              httpRes.setHeader('Content-Type', 'application/json');
              const errCode = isTimeout ? 'DOWNSTREAM_TIMEOUT' : 'DOWNSTREAM_ERROR';
              const errMsg = isTimeout ? 'Downstream request timed out' : 'Downstream service error';
              httpRes.end(JSON.stringify({ error: errCode, message: errMsg, requestId }));
            }
          }

          // Always resolve — the response.finish handler may not fire for Socket targets
          ctx?.resolve(statusCode);
        },
      },
    };

    const handler = createProxyMiddleware(options) as unknown as RequestHandler<
      http.IncomingMessage,
      http.ServerResponse
    >;
    this.handlers.set(targetUrl, handler);
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

  private getForwardedFor(req: http.IncomingMessage): string | undefined {
    const r = req as Request;
    if (Array.isArray(r.ips) && r.ips.length > 0) return r.ips.join(', ');
    return r.ip ?? undefined;
  }

  private getRequestId(req: http.IncomingMessage, res: http.ServerResponse): string {
    const h = req.headers['x-request-id'];
    return (
      (Array.isArray(h) ? h[0] : h) ??
      (res as unknown as ResponseWithLocals).locals?.requestId ??
      uuidv4()
    );
  }
}
