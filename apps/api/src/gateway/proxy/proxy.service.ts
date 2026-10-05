import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import { performance } from 'node:perf_hooks';
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
  GatewayTraceHandle,
  ResponseWithLocals,
} from '../shared/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService, type TargetLease } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginRunnerService } from '../plugins/plugin-runner.service';
import { Http2SessionPool, Http2PoolError } from './http2-session-pool.service';
import { DEFAULT_PROXY_HANDLERS } from '../../config/configuration';
import { ConfigService } from '@nestjs/config';
import {
  RequestBodyService,
  BodyCaptureError,
} from '../shared/request-body.service';

// Per-request context attached to the request object so cached handlers can
// read retry state without holding per-request closures.
interface RetryContext {
  retryOn: number[];
  isLastAttempt: boolean;
  serviceName: string;
  resolve: (statusCode: number) => void;
  abort?: (error: NodeJS.ErrnoException) => void;
  lease?: TargetLease;
  upstreamStarted?: boolean;
  trace?: GatewayTraceHandle;
  outcome?: number;
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

/** HTTP hop-by-hop headers that must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

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
    private readonly http2Pool: Http2SessionPool,
    private readonly bodies: RequestBodyService = new RequestBodyService(
      new ConfigService(),
    ),
    private readonly config: ConfigService = new ConfigService(),
  ) {}

  async forward(request: Request, response: ResponseWithLocals): Promise<void> {
    const originalUrl = request.originalUrl ?? request.url ?? '';
    const [pathWithoutQuery] = originalUrl.split('?');
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

    const preflightMethod =
      request.method === 'OPTIONS' && request.headers.origin
        ? request.headers['access-control-request-method']
        : undefined;
    const isPreflight = typeof preflightMethod === 'string';
    const route = matchRoute(
      isPreflight ? preflightMethod : request.method,
      normalizedPath,
      config.routes,
    );
    if (!route) {
      throw new GatewayError(
        'SERVICE_NOT_FOUND',
        'No downstream service matches the path',
        404,
      );
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

    response.locals.routePattern = route.pathPattern;
    response.locals.trace?.set({
      'gateway.route.id': route.id,
      'gateway.service.id': service.id,
      'http.route': route.pathPattern,
    });
    response.locals.downstreamService = service.name;
    // Certificate assertions are not downstream identity. mTLS reads original rawHeaders only after source verification.
    for (const name of Object.keys(request.headers))
      if (name.startsWith('ssl_client_') || name.startsWith('x-ssl-client-'))
        delete request.headers[name];

    // Run plugin onRequest hooks before proxying
    let pluginEntries = route.plugins ?? [];
    if (isPreflight) {
      pluginEntries = pluginEntries.filter((entry) => entry.name === 'cors');
      if (!pluginEntries.length)
        throw new GatewayError(
          'SERVICE_NOT_FOUND',
          'CORS is not configured for this route',
          404,
        );
    } else if (
      route.graphql &&
      !pluginEntries.some((entry) => entry.name === 'graphql-guard')
    ) {
      pluginEntries = [...pluginEntries, { name: 'graphql-guard', config: {} }];
    }
    let activePlugins: GatewayPlugin[];
    try {
      activePlugins = this.pluginRegistry.resolve(pluginEntries);
    } catch {
      throw new GatewayError(
        'PLUGIN_CONFIG_INVALID',
        'Route policy configuration is invalid',
        500,
      );
    }

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
      if (pluginCtx.signal?.aborted) return;
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

    const pluginAuthentication = (request as unknown as GwRequest).__gw_plugins
      ?.ctx.authentication;
    if (
      route.authRequired &&
      !(request as RequestWithUser).user &&
      !pluginAuthentication
    ) {
      throw new GatewayError('TOKEN_INVALID', 'Authentication required', 401);
    }

    const start = Date.now();

    // Strip prefix once and reuse across all retry attempts
    const strippedPath = this.stripPrefix(normalizedPath, route.pathPattern);
    const modifiedUrl = request.url ?? originalUrl;
    const queryIndex = modifiedUrl.indexOf('?');
    const query = queryIndex < 0 ? '' : modifiedUrl.slice(queryIndex + 1);
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

    const useH2 = service.h2 === true;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const healthyUrls = this.upstreamHealth.getHealthyUrls(
        service.targets,
        service.id,
      );
      const isLastAttempt = attempt === maxAttempts - 1;
      const lease = this.loadBalancer.acquireTarget(
        service.id,
        service.targets,
        healthyUrls,
        service.unhealthyFallback === true,
        service.loadBalancing,
      );
      const targetUrl = lease.url;
      const attemptTrace = response.locals.trace?.child(
        useH2 ? 'upstream HTTP2' : 'upstream HTTP1',
        {
          'gateway.route.id': route.id,
          'gateway.service.id': service.id,
          'gateway.retry.count': attempt,
          'http.request.method': request.method,
          'http.route': route.pathPattern,
        },
      );

      // Reset the URL for each attempt (safe for GET/HEAD/OPTIONS which have no body)
      request.url = finalUrl;

      const statusCode = useH2
        ? await this.callH2Proxy(
            targetUrl,
            finalUrl,
            service,
            route,
            request,
            response,
            canRetry && !isLastAttempt,
            retryOn,
            lease,
            attemptTrace,
          )
        : await this.callProxy(
            targetUrl,
            service,
            request,
            response,
            !canRetry || isLastAttempt,
            retryOn,
            undefined,
            lease,
            attemptTrace,
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
    absoluteTimeoutMs?: number,
    lease?: TargetLease,
    attemptTrace?: GatewayTraceHandle,
  ): Promise<number> {
    const retryContext: RetryContext = {
      retryOn,
      isLastAttempt,
      serviceName: service.name,
      resolve: () => undefined,
      lease,
      upstreamStarted: false,
      trace: attemptTrace,
      outcome: 499,
    };
    return new Promise<number>((resolve) => {
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      let cleanup: () => void = () => undefined;
      const resolveOnce = (code: number) => {
        if (!settled) {
          settled = true;
          retryContext.outcome = code;
          cleanup();
          delete (request as unknown as GwRequest).__gw_retry;
          resolve(code);
        }
      };

      retryContext.resolve = resolveOnce;
      (request as unknown as GwRequest).__gw_retry = retryContext;

      const handler = this.getHandler(targetUrl, service.timeoutMs ?? 10_000);

      // Fallback: if the handler calls next() without a proxyRes/error event
      const onFinish = () => resolveOnce(response.statusCode ?? 200);
      const onClose = () => {
        retryContext.abort?.(
          Object.assign(new Error('Caller cancelled'), { code: 'ECANCELED' }),
        );
        resolveOnce(response.writableFinished ? response.statusCode : 499);
      };
      cleanup = () => {
        clearTimeout(deadline);
        response.off('finish', onFinish);
        response.off('close', onClose);
      };
      response.once('finish', onFinish);
      response.once('close', onClose);
      if (absoluteTimeoutMs !== undefined) {
        deadline = setTimeout(() => {
          if (settled) return;
          if (response.headersSent) {
            this.metricsService.incrementDownstreamTimeout(service.name);
            retryContext.abort?.(
              Object.assign(new Error('Upstream deadline exceeded'), {
                code: 'ECANCELED',
              }),
            );
            response.destroy();
            resolveOnce(504);
          } else if (retryContext.abort) {
            retryContext.abort(
              Object.assign(new Error('Upstream deadline exceeded'), {
                code: 'ETIMEDOUT',
              }),
            );
          } else {
            if (isLastAttempt) {
              this.metricsService.incrementDownstreamTimeout(service.name);
              response.statusCode = 504;
              response.setHeader('Content-Type', 'application/json');
              response.end(
                JSON.stringify({
                  error: 'DOWNSTREAM_TIMEOUT',
                  message: 'Upstream request timed out',
                  requestId: this.getRequestIdFromRequest(request, response),
                }),
              );
            }
            resolveOnce(504);
          }
        }, absoluteTimeoutMs);
        deadline.unref();
      }

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
    }).finally(() => {
      if (!retryContext.upstreamStarted) {
        lease?.release();
        attemptTrace?.end(retryContext.outcome);
      }
    });
  }

  /** Buffer under shared limits and fall back only before application dispatch. */
  private async callH2Proxy(
    targetUrl: string,
    finalUrl: string,
    service: ServiceConfig,
    route: RouteConfig,
    request: Request,
    response: ResponseWithLocals,
    retriesRemaining: boolean,
    retryOn: number[],
    lease: TargetLease,
    attemptTrace?: GatewayTraceHandle,
  ): Promise<number> {
    const requestId = this.getRequestIdFromRequest(request, response);

    const pluginState = (request as unknown as GwRequest).__gw_plugins;
    const ctx =
      pluginState?.ctx ??
      this.buildPluginContext(request, response, route, service, requestId);
    let started = performance.now();
    let dispatched = false,
      handedOff = false;
    let outcome = 499;

    // Build forward headers (strip hop-by-hop)
    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'host')
        continue;
      if (v !== undefined) forwardHeaders[k] = v as string | string[];
    }
    if (attemptTrace) {
      delete forwardHeaders.traceparent;
      delete forwardHeaders.tracestate;
      delete forwardHeaders.baggage;
      Object.assign(forwardHeaders, attemptTrace.headers());
    }
    forwardHeaders['x-request-id'] = requestId;
    const fwd = this.getForwardedForFromRequest(request);
    if (fwd) forwardHeaders['x-forwarded-for'] = fwd;

    try {
      const body = await this.bodies.read(ctx);
      started = performance.now();
      const h2res = await this.http2Pool.request(
        targetUrl,
        request.method,
        finalUrl,
        forwardHeaders,
        body,
        service.timeoutMs ?? 10_000,
        ctx.signal,
        {
          onDispatch: () => {
            dispatched = true;
          },
          onClose: (status) => {
            lease.release();
            attemptTrace?.end(status);
          },
        },
      );

      outcome = h2res.statusCode;
      // A retryable status with attempts left: don't commit the response —
      // let the outer loop retry, mirroring the HTTP/1 proxy path.
      if (retriesRemaining && retryOn.includes(h2res.statusCode)) {
        return h2res.statusCode;
      }

      if (!response.headersSent) {
        for (const [k, v] of Object.entries(h2res.headers)) {
          if (k.startsWith(':') || HOP_BY_HOP.has(k.toLowerCase())) continue;
          if (v !== undefined) response.setHeader(k, v as string | string[]);
        }
        response.statusCode = h2res.statusCode;
        // Run onResponse plugins
        const pluginState = (request as unknown as GwRequest).__gw_plugins;
        if (pluginState?.plugins.length) {
          await this.pluginRunner.runOnResponse(pluginState.plugins, {
            ...pluginState.ctx,
            statusCode: h2res.statusCode,
            headers: response.getHeaders() as OutgoingHttpHeaders,
          });
        }
        response.end(h2res.body);
      }

      return h2res.statusCode;
    } catch (err) {
      let failure = err;
      if (ctx.signal?.aborted || response.destroyed) return 499;
      if (err instanceof Http2PoolError && err.fallbackSafe) {
        const remaining =
          (service.timeoutMs ?? 10000) - (performance.now() - started);
        if (remaining > 0) {
          handedOff = true;
          attemptTrace?.end(502);
          const fallbackTrace = response.locals.trace?.child(
            'upstream HTTP1 fallback',
            {
              'gateway.route.id': route.id,
              'gateway.service.id': service.id,
              'http.request.method': request.method,
              'http.route': route.pathPattern,
            },
          );
          return this.callProxy(
            targetUrl,
            { ...service, timeoutMs: remaining },
            request,
            response,
            !retriesRemaining,
            retryOn,
            remaining,
            lease,
            fallbackTrace,
          );
        }
        failure = new Http2PoolError(504, 'DOWNSTREAM_TIMEOUT');
      }
      const status =
        failure instanceof Http2PoolError || failure instanceof BodyCaptureError
          ? failure.status
          : 502;
      const code =
        failure instanceof Http2PoolError || failure instanceof BodyCaptureError
          ? failure.code
          : 'DOWNSTREAM_ERROR';
      outcome = status;
      if (status === 504)
        this.metricsService.incrementDownstreamTimeout(service.name);
      this.logger.warn(
        JSON.stringify({
          msg: 'HTTP/2 upstream request failed',
          code,
          routeId: route.id,
          requestId,
        }),
      );
      if (pluginState?.plugins.length) {
        const result = await this.pluginRunner.runOnError(pluginState.plugins, {
          ...ctx,
          error: new Error('Upstream request failed'),
        });
        if (result) {
          this.sendShortCircuit(response, result);
          return result.status;
        }
      }
      if (retriesRemaining && retryOn.includes(status)) return status;
      if (!response.headersSent) {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            error: code,
            message: 'Upstream request failed',
            requestId,
          }),
        );
      }
      return status;
    } finally {
      if (!dispatched && !handedOff) {
        lease.release();
        attemptTrace?.end(outcome);
      }
      this.bodies.releaseDetached(ctx);
    }
  }

  private getForwardedForFromRequest(request: Request): string | undefined {
    if (Array.isArray(request.ips) && request.ips.length > 0)
      return request.ips.join(', ');
    return request.ip ?? undefined;
  }

  private getHandler(
    targetUrl: string,
    timeoutMs: number,
  ): RequestHandler<http.IncomingMessage, http.ServerResponse> {
    const cacheKey = `${targetUrl}:${timeoutMs}`;
    const cached = this.handlers.get(cacheKey);
    if (cached) return cached;

    const options: Options = {
      target: targetUrl,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: timeoutMs,
      timeout: timeoutMs,
      selfHandleResponse: true,
      on: {
        proxyReq: (
          proxyReq: http.ClientRequest,
          req: http.IncomingMessage,
          res: http.ServerResponse,
        ) => {
          if (res.destroyed || res.writableEnded) {
            proxyReq.destroy();
            return;
          }
          const retryContext = (req as unknown as GwRequest).__gw_retry;
          if (retryContext) {
            retryContext.upstreamStarted = true;
            proxyReq.once('close', () => {
              retryContext.lease?.release();
              retryContext.trace?.end(retryContext.outcome);
            });
            if (retryContext.trace) {
              for (const header of ['traceparent', 'tracestate', 'baggage'])
                proxyReq.removeHeader(header);
              for (const [header, value] of Object.entries(
                retryContext.trace.headers(),
              ))
                proxyReq.setHeader(header, value);
            }
            retryContext.abort = (error) => proxyReq.destroy(error);
          }
          const requestId = this.getRequestId(req, res);
          if (requestId) proxyReq.setHeader('X-Request-ID', requestId);
          const fwd = this.getForwardedFor(req);
          if (fwd) proxyReq.setHeader('X-Forwarded-For', fwd);

          // If a plugin (e.g. hmac-auth) consumed the stream and buffered it,
          // replay the buffer directly so the upstream receives the full body.
          const rawBody = (req as http.IncomingMessage & { rawBody?: Buffer })
            .rawBody;
          if (rawBody) {
            // Incoming chunked framing cannot accompany a replayed fixed-size body.
            proxyReq.removeHeader('transfer-encoding');
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
          if (retryCtx) retryCtx.outcome = statusCode;
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
    const maxEntries =
      this.config.get<number>('proxy.maxHandlerCacheEntries') ??
      DEFAULT_PROXY_HANDLERS.maxCacheEntries;
    while (this.handlers.size >= maxEntries) {
      const oldest = this.handlers.keys().next().value;
      if (oldest === undefined) break;
      this.handlers.delete(oldest);
    }
    this.handlers.set(cacheKey, handler);
    return handler;
  }

  private buildPluginContext(
    request: Request,
    response: ResponseWithLocals,
    route: RouteConfig,
    service: ServiceConfig,
    requestId: string,
  ): PluginContext {
    const abort = new AbortController();
    const cancelled = () => abort.abort();
    const cleanup = () => {
      request.off?.('aborted', cancelled);
      response.off?.('close', closed);
      response.off?.('finish', cleanup);
    };
    const closed = () => {
      if (!response.writableFinished) abort.abort();
      cleanup();
    };
    request.once?.('aborted', cancelled);
    response.once?.('close', closed);
    response.once?.('finish', cleanup);
    if (request.aborted || response.destroyed) abort.abort();
    const tenantId = this.configManager.getTenantId() ?? 'unknown';
    const user = (request as RequestWithUser).user;
    return {
      req: Object.assign(request, { requestId, user }) as PluginContext['req'],
      res: response as unknown as http.ServerResponse,
      route,
      service,
      tenantId,
      requestId,
      signal: abort.signal,
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
      (res as unknown as ResponseWithLocals).locals?.requestId ??
      (Array.isArray(h) ? h[0] : h) ??
      uuidv4()
    );
  }

  private getRequestIdFromRequest(
    request: Request,
    response: ResponseWithLocals,
  ): string {
    const h = request.headers['x-request-id'];
    const fromHeader = Array.isArray(h) ? h[0] : h;
    return response.locals?.requestId ?? fromHeader ?? uuidv4();
  }
}
