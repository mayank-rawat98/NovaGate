import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import type * as net from 'net';
import type { OutgoingHttpHeaders } from 'http';
import type { Request } from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import type { Options } from 'http-proxy-middleware/dist/types';
import { v4 as uuidv4 } from 'uuid';
import type {
  GatewayPlugin,
  PluginContext,
  RouteConfig,
  ServiceConfig,
} from '@api-gateway/shared-types';
import { GatewayError } from '../shared/gateway-error';
import type {
  RequestWithUser,
  ResponseWithLocals,
} from '../shared/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginRunnerService } from '../plugins/plugin-runner.service';

// Per-request context attached to the request object so cached handlers can
// read retry state without holding per-request closures.
interface RetryContext {
  retryOn: number[];
  isLastAttempt: boolean;
  serviceName: string;
  resolve: (statusCode: number) => void;
}

interface PluginState {
  plugins: GatewayPlugin[];
  ctx: PluginContext;
}

type GwRequest = http.IncomingMessage & {
  __gw_plugins?: PluginState;
  __gw_retry?: RetryContext;
};

const RETRY_DELAY_MS = 100;

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  // Handlers are cached per target URL; the retry context on `req` drives behavior.
  private readonly handlers = new Map<
    string,
    RequestHandler<http.IncomingMessage, http.ServerResponse>
  >();

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly metricsService: MetricsService,
    private readonly loadBalancer: LoadBalancerService,
    private readonly upstreamHealth: UpstreamHealthService,
    private readonly pluginRegistry: PluginRegistryService,
    private readonly pluginRunner: PluginRunnerService,
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
      throw new GatewayError(
        'SERVICE_NOT_FOUND',
        'No downstream service matches the path',
        404,
      );
    }

    const route = matchRoute(request.method, normalizedPath, config.routes);
    if (!route) {
      throw new GatewayError(
        'SERVICE_NOT_FOUND',
        'No downstream service matches the path',
        404,
      );
    }

    const user = (request as RequestWithUser).user;
    if (route.authRequired && !user) {
      throw new GatewayError('TOKEN_INVALID', 'Authentication required', 401);
    }

    const service = config.services.find(
      (s: ServiceConfig) => s.id === route.serviceId,
    );
    if (!service) {
      throw new GatewayError(
        'SERVICE_NOT_FOUND',
        'No downstream service matches the path',
        404,
      );
    }
    if (!service.targets || service.targets.length === 0) {
      throw new GatewayError(
        'SERVICE_NOT_FOUND',
        'No downstream targets configured for service',
        404,
      );
    }

    response.locals.downstreamService = service.name;

    // Run plugin onRequest hooks before proxying
    const pluginEntries = route.plugins ?? [];
    const activePlugins = this.pluginRegistry.resolve(pluginEntries);

    if (activePlugins.length > 0) {
      const requestId = this.getRequestIdFromRequest(request, response);
      const pluginCtx = this.buildPluginContext(
        request,
        response,
        route,
        service,
        requestId,
      );
      const shortCircuit = await this.pluginRunner.runOnRequest(
        activePlugins,
        pluginCtx,
      );
      if (shortCircuit) {
        this.sendShortCircuit(response, shortCircuit);
        return;
      }
      // Store plugin state for use in proxyRes / error handlers
      (request as unknown as GwRequest).__gw_plugins = {
        plugins: activePlugins,
        ctx: pluginCtx,
      } satisfies PluginState;
    }

    const start = Date.now();

    // Strip prefix once and reuse across all retry attempts
    const strippedPath = this.stripPrefix(normalizedPath, route.pathPattern);
    const finalUrl = query ? `${strippedPath}?${query}` : strippedPath;

    const retryConfig = route.retry;
    const maxAttempts = retryConfig ? retryConfig.attempts + 1 : 1;
    const retryOn = retryConfig?.on ?? [502, 503, 504];
    const retryMethods = (
      retryConfig?.methods ?? ['GET', 'HEAD', 'OPTIONS']
    ).map((m) => m.toUpperCase());
    const requestMethod = request.method.toUpperCase();
    const safeRetryMethods = ['GET', 'HEAD', 'OPTIONS'];
    const canRetry =
      maxAttempts > 1 &&
      safeRetryMethods.includes(requestMethod) &&
      retryMethods.includes(requestMethod);

    const healthyUrls = this.upstreamHealth.getHealthyUrls(service.targets);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const isLastAttempt = attempt === maxAttempts - 1;
      const targetUrl = this.loadBalancer.selectTarget(
        service.id,
        service.targets,
        healthyUrls,
      );

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
      let cleanup: () => void = () => undefined;
      const resolveOnce = (code: number) => {
        if (!settled) {
          settled = true;
          cleanup();
          delete (request as unknown as GwRequest).__gw_retry;
          resolve(code);
        }
      };

      (request as unknown as GwRequest).__gw_retry = {
        retryOn,
        isLastAttempt,
        serviceName: service.name,
        resolve: resolveOnce,
      } satisfies RetryContext;

      const handler = this.getHandler(targetUrl, service.timeoutMs ?? 10_000);

      // Fallback: if the handler calls next() without a proxyRes/error event
      const onFinish = () => resolveOnce(response.statusCode ?? 200);
      const onClose = () => resolveOnce(response.statusCode ?? 200);
      cleanup = () => {
        response.off('finish', onFinish);
        response.off('close', onClose);
      };
      response.once('finish', onFinish);
      response.once('close', onClose);

      handler(
        request as unknown as http.IncomingMessage,
        response as unknown as http.ServerResponse,
        (err?: unknown) => {
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

          // If a plugin (e.g. hmac-auth) consumed the stream and buffered it,
          // replay the buffer directly so the upstream receives the full body.
          const rawBody = (req as http.IncomingMessage & { rawBody?: Buffer })
            .rawBody;
          if (rawBody) {
            proxyReq.setHeader('Content-Length', rawBody.length);
            proxyReq.write(rawBody);
            proxyReq.end();
          }
        },

        proxyRes: async (
          proxyRes: http.IncomingMessage,
          req: http.IncomingMessage,
          res: http.ServerResponse,
        ) => {
          const statusCode = proxyRes.statusCode ?? 502;
          const retryCtx: RetryContext | undefined = (
            req as unknown as GwRequest
          ).__gw_retry;
          const requestId = this.getRequestId(req, res);

          if (
            retryCtx &&
            !retryCtx.isLastAttempt &&
            retryCtx.retryOn.includes(statusCode)
          ) {
            proxyRes.resume();
            retryCtx.resolve(statusCode);
            return;
          }

          if (statusCode >= 500) {
            proxyRes.resume();
            this.logger.error(
              JSON.stringify({
                msg: 'Downstream service returned 5xx',
                statusCode,
                downstreamService: retryCtx?.serviceName,
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
            return;
          }

          // Set upstream headers on response
          Object.entries(proxyRes.headers).forEach(([header, value]) => {
            if (value !== undefined) res.setHeader(header, value as string);
          });
          res.statusCode = statusCode;

          // Run onResponse plugins — they may mutate headers; errors are logged, not rethrown
          const pluginState: PluginState | undefined = (
            req as unknown as GwRequest
          ).__gw_plugins;
          if (pluginState?.plugins.length) {
            proxyRes.pause();
            await this.pluginRunner.runOnResponse(pluginState.plugins, {
              ...pluginState.ctx,
              statusCode,
              headers: res.getHeaders() as OutgoingHttpHeaders,
            });
            proxyRes.resume();
          }

          proxyRes.pipe(res);
        },

        error: async (
          error: Error,
          req: http.IncomingMessage,
          res: http.ServerResponse | net.Socket,
        ) => {
          const retryCtx: RetryContext | undefined = (
            req as unknown as GwRequest
          ).__gw_retry;
          const nodeError = error as NodeJS.ErrnoException;
          const isTimeout = this.isTimeoutError(nodeError);
          const statusCode = isTimeout ? 504 : 502;

          // Run onError plugins — first short-circuit wins
          const pluginState: PluginState | undefined = (
            req as unknown as GwRequest
          ).__gw_plugins;
          if (pluginState?.plugins.length) {
            const httpRes = this.toHttpServerResponse(res);
            if (httpRes && !httpRes.headersSent) {
              const shortCircuit = await this.pluginRunner.runOnError(
                pluginState.plugins,
                {
                  ...pluginState.ctx,
                  error,
                },
              );
              if (shortCircuit) {
                this.sendShortCircuit(
                  httpRes as unknown as ResponseWithLocals,
                  shortCircuit,
                );
                retryCtx?.resolve(statusCode);
                return;
              }
            }
          }

          // Signal retry without sending a response
          if (
            retryCtx &&
            !retryCtx.isLastAttempt &&
            retryCtx.retryOn.includes(statusCode)
          ) {
            retryCtx.resolve(statusCode);
            return;
          }

          // Send HTTP response when res is a ServerResponse or a mock that quacks like one
          const httpRes = this.toHttpServerResponse(res);
          if (httpRes) {
            const requestId = this.getRequestId(req, httpRes);
            if (isTimeout) {
              this.metricsService.incrementDownstreamTimeout(
                retryCtx?.serviceName ?? 'unknown',
              );
            }
            this.logger.error(
              JSON.stringify({
                msg: isTimeout
                  ? 'Downstream request timed out'
                  : 'Downstream proxy error',
                error: error.message,
                downstreamService: retryCtx?.serviceName,
                requestId,
              }),
            );
            if (!httpRes.headersSent) {
              httpRes.statusCode = statusCode;
              httpRes.setHeader('Content-Type', 'application/json');
              const errCode = isTimeout
                ? 'DOWNSTREAM_TIMEOUT'
                : 'DOWNSTREAM_ERROR';
              const errMsg = isTimeout
                ? 'Downstream request timed out'
                : 'Downstream service error';
              httpRes.end(
                JSON.stringify({ error: errCode, message: errMsg, requestId }),
              );
            }
          } else {
            retryCtx?.resolve(statusCode);
          }
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

  private buildPluginContext(
    request: Request,
    response: ResponseWithLocals,
    route: RouteConfig,
    service: ServiceConfig,
    requestId: string,
  ): PluginContext {
    const tenantId = this.configManager.getTenantId() ?? 'unknown';
    const user = (request as RequestWithUser).user;
    return {
      req: Object.assign(request, { requestId, user }) as PluginContext['req'],
      res: response as unknown as http.ServerResponse,
      route,
      service,
      tenantId,
      requestId,
      logger: {
        info: (msg, meta) => this.logger.log(JSON.stringify({ msg, ...meta })),
        warn: (msg, meta) => this.logger.warn(JSON.stringify({ msg, ...meta })),
        error: (msg, meta) =>
          this.logger.error(JSON.stringify({ msg, ...meta })),
      },
    };
  }

  private sendShortCircuit(
    res: ResponseWithLocals | http.ServerResponse,
    sc: {
      status: number;
      headers?: Record<string, string>;
      body: string | Buffer;
    },
  ): void {
    if ((res as http.ServerResponse).headersSent) return;
    for (const [k, v] of Object.entries(sc.headers ?? {})) {
      (res as http.ServerResponse).setHeader(k, v);
    }
    (res as http.ServerResponse).statusCode = sc.status;
    (res as http.ServerResponse).end(sc.body);
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

  private toHttpServerResponse(
    res: http.ServerResponse | net.Socket,
  ): http.ServerResponse | null {
    if (res instanceof http.ServerResponse) return res;
    if ('statusCode' in res) return res as unknown as http.ServerResponse;
    return null;
  }

  private getForwardedFor(req: http.IncomingMessage): string | undefined {
    const r = req as Request;
    if (Array.isArray(r.ips) && r.ips.length > 0) return r.ips.join(', ');
    return r.ip ?? undefined;
  }

  private getRequestId(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): string {
    const h = req.headers['x-request-id'];
    return (
      (Array.isArray(h) ? h[0] : h) ??
      (res as unknown as ResponseWithLocals).locals?.requestId ??
      uuidv4()
    );
  }

  private getRequestIdFromRequest(
    request: Request,
    response: ResponseWithLocals,
  ): string {
    const h = request.headers['x-request-id'];
    const fromHeader = Array.isArray(h) ? h[0] : h;
    return fromHeader ?? response.locals?.requestId ?? uuidv4();
  }
}
