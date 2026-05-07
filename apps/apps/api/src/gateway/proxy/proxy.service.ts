import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Options } from 'http-proxy-middleware/dist/types';
import { v4 as uuidv4 } from 'uuid';
import type { GatewayConfig, ProxyServiceConfig } from '../../config/configuration';
import { GatewayError } from '../shared/gateway-error';
import type { ResponseWithLocals } from '../shared/request-context';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly timeoutMs: number;
  private readonly services: ProxyServiceConfig[];
  private readonly proxies = new Map<string, ReturnType<typeof createProxyMiddleware>>();

  constructor(
    private readonly configService: ConfigService<GatewayConfig, true>,
    private readonly metricsService: MetricsService,
  ) {
    const proxyConfig = this.configService.get('proxy', { infer: true });
    this.timeoutMs = proxyConfig.timeout;
    this.services = proxyConfig.services;
  }

  async forward(request: Request, response: ResponseWithLocals): Promise<void> {
    const originalUrl = request.originalUrl ?? request.url ?? '';
    const [pathWithoutQuery, query] = originalUrl.split('?');
    const baseUrl = request.baseUrl ?? '';
    const normalizedPath = baseUrl && pathWithoutQuery.startsWith(baseUrl)
      ? pathWithoutQuery.slice(baseUrl.length) || '/'
      : pathWithoutQuery || '/';
    const service = this.matchService(normalizedPath);
    if (!service) {
      throw new GatewayError(
        'SERVICE_NOT_FOUND',
        'No downstream service matches the path',
        404,
      );
    }

    response.locals.downstreamService = service.name;
    const start = Date.now();
    request.url = query ? `${normalizedPath}?${query}` : normalizedPath;

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

      handler(request, response, (error) => {
        cleanup();
        if (!error || response.headersSent) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }

  private matchService(path: string): ProxyServiceConfig | undefined {
    return this.services.find((service) => {
      const prefix = service.pathPrefix;
      return path === prefix || path.startsWith(`${prefix}/`);
    });
  }

  private getProxyHandler(service: ProxyServiceConfig) {
    const existing = this.proxies.get(service.name);
    if (existing) {
      return existing;
    }

    const options: Options = {
      target: service.targetUrl,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: this.timeoutMs,
      timeout: this.timeoutMs,
      selfHandleResponse: true,
      pathRewrite: (path) => this.stripPrefix(path, service.pathPrefix),
      onProxyReq: (proxyReq, req) => {
        const requestIdHeader = req.headers['x-request-id'];
        const requestId = Array.isArray(requestIdHeader)
          ? requestIdHeader[0]
          : requestIdHeader;
        if (requestId) {
          proxyReq.setHeader('X-Request-ID', requestId);
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        const statusCode = proxyRes.statusCode ?? 502;
        const requestIdHeader = req.headers['x-request-id'];
        const requestId = Array.isArray(requestIdHeader)
          ? requestIdHeader[0]
          : requestIdHeader ?? (res as ResponseWithLocals).locals.requestId ?? uuidv4();
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
              downstreamService: service.name,
              requestId,
            }),
          );
          return;
        }

        Object.entries(proxyRes.headers).forEach(([header, value]) => {
          if (value !== undefined) {
            res.setHeader(header, value as string);
          }
        });
        res.statusCode = statusCode;
        proxyRes.pipe(res);
      },
      onError: (error, req, res) => {
        const requestIdHeader = req.headers['x-request-id'];
        const requestId = Array.isArray(requestIdHeader)
          ? requestIdHeader[0]
          : requestIdHeader ?? (res as ResponseWithLocals).locals.requestId ?? uuidv4();
        const response = res as Response;
        if (this.isTimeoutError(error)) {
          this.metricsService.incrementDownstreamTimeout(service.name);
          this.logger.error(
            JSON.stringify({
              msg: 'Downstream request timed out',
              error: error.message,
              downstreamService: service.name,
              requestId,
            }),
          );
          if (!response.headersSent) {
            response.statusCode = 504;
            response.setHeader('Content-Type', 'application/json');
            response.end(
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
            downstreamService: service.name,
            requestId,
          }),
        );
        if (!response.headersSent) {
          response.statusCode = 502;
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              error: 'DOWNSTREAM_ERROR',
              message: 'Downstream service error',
              requestId,
            }),
          );
        }
      },
    };

    const handler = createProxyMiddleware(options);
    this.proxies.set(service.name, handler);
    return handler;
  }

  private stripPrefix(path: string, prefix: string): string {
    if (path === prefix) {
      return '/';
    }
    if (path.startsWith(`${prefix}/`)) {
      return path.slice(prefix.length);
    }
    return path;
  }

  private isTimeoutError(error: NodeJS.ErrnoException): boolean {
    return error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT';
  }
}
