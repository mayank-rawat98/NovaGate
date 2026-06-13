import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';
import * as net from 'net';
import {
  createProxyMiddleware,
  type RequestHandler,
} from 'http-proxy-middleware';
import { ConfigService } from '@nestjs/config';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import type { ServiceConfig } from '@api-gateway/shared-types';
import type { GatewayConfig } from '../../config/configuration';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { MetricsService } from '../metrics/metrics.service';
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';

@Injectable()
export class WsProxyService {
  private readonly logger = new Logger(WsProxyService.name);
  private readonly upgradeHandlers = new Map<
    string,
    RequestHandler<http.IncomingMessage, http.ServerResponse>
  >();

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly metricsService: MetricsService,
    private readonly loadBalancer: LoadBalancerService,
    private readonly upstreamHealth: UpstreamHealthService,
    private readonly configService: ConfigService<GatewayConfig, true>,
  ) {}

  /**
   * Handle an HTTP upgrade event from the raw HTTP server. Should be wired to
   * `httpServer.on('upgrade', ...)` at bootstrap time.
   */
  handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    const upgrade = req.headers['upgrade'];
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }

    const config = this.configManager.getConfig();
    if (!config) {
      this.rejectSocket(socket, 503, 'SERVICE_UNAVAILABLE');
      return;
    }

    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    const method = 'GET'; // WebSocket upgrades are always GET
    const route = matchRoute(method, path, config.routes);

    if (!route || !route.enabled) {
      this.rejectSocket(socket, 404, 'SERVICE_NOT_FOUND');
      return;
    }

    // Auth check
    if (route.authRequired) {
      const userId = this.extractUserId(req);
      if (!userId) {
        this.rejectSocket(socket, 401, 'TOKEN_INVALID');
        return;
      }
    }

    const service = config.services.find(
      (s: ServiceConfig) => s.id === route.serviceId,
    );
    if (!service || !service.targets || service.targets.length === 0) {
      this.rejectSocket(socket, 404, 'SERVICE_NOT_FOUND');
      return;
    }

    if (!service.supportsWebSocket) {
      this.rejectSocket(socket, 400, 'WS_NOT_SUPPORTED');
      return;
    }

    const healthyUrls = this.upstreamHealth.getHealthyUrls(service.targets);
    const targetUrl = this.loadBalancer.selectTarget(
      service.id,
      service.targets,
      healthyUrls,
    );

    const handler = this.getUpgradeHandler(targetUrl, service.timeoutMs);

    this.metricsService.incrementWsConnections();

    socket.once('close', () => {
      this.metricsService.decrementWsConnections();
    });

    // Track inbound bytes via the socket data event
    socket.on('data', (chunk: Buffer) => {
      this.metricsService.incrementWsBytes('inbound', chunk.length);
    });

    this.logger.log(
      JSON.stringify({
        msg: 'WebSocket connection opened',
        path,
        targetUrl,
        routeId: route.id,
      }),
    );

    if (handler.upgrade) {
      handler.upgrade(req, socket, head);
    } else {
      this.rejectSocket(socket, 503, 'WS_UPGRADE_UNAVAILABLE');
    }
  }

  private getUpgradeHandler(
    targetUrl: string,
    timeoutMs: number,
  ): RequestHandler<http.IncomingMessage, http.ServerResponse> {
    const cached = this.upgradeHandlers.get(targetUrl);
    if (cached) return cached;

    const handler = createProxyMiddleware<
      http.IncomingMessage,
      http.ServerResponse
    >({
      target: targetUrl,
      changeOrigin: true,
      ws: true,
      xfwd: true,
      proxyTimeout: timeoutMs,
      on: {
        error: (err: Error, _req: http.IncomingMessage, res) => {
          this.logger.error(
            JSON.stringify({
              msg: 'WebSocket proxy error',
              error: err.message,
              targetUrl,
            }),
          );
          if (res instanceof net.Socket) {
            res.destroy();
          }
        },
        open: () => {
          this.logger.log(
            JSON.stringify({ msg: 'WebSocket upstream opened', targetUrl }),
          );
        },
        close: () => {
          this.logger.log(
            JSON.stringify({ msg: 'WebSocket upstream closed', targetUrl }),
          );
        },
      },
    });

    this.upgradeHandlers.set(targetUrl, handler);
    return handler;
  }

  private extractUserId(req: http.IncomingMessage): string | undefined {
    const authHeader = req.headers['authorization'];
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!header) {
      // Also check token query param (common for WebSocket auth)
      const url = req.url ?? '';
      const match = url.match(/[?&]token=([^&]+)/);
      if (!match) return undefined;
      const token = decodeURIComponent(match[1]);
      return this.verifyToken(token);
    }
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
    return this.verifyToken(token);
  }

  private verifyToken(token: string): string | undefined {
    try {
      const secret = this.configService.get('jwt', { infer: true }).secret;
      const payload = jwt.verify(token, secret) as {
        sub?: string;
        userId?: string;
        id?: string;
      };
      return payload.sub ?? payload.userId ?? payload.id;
    } catch (err) {
      if (
        err instanceof TokenExpiredError ||
        err instanceof JsonWebTokenError
      ) {
        return undefined;
      }
      return undefined;
    }
  }

  private rejectSocket(
    socket: net.Socket,
    statusCode: number,
    errorCode: string,
  ): void {
    const statusText =
      statusCode === 404
        ? 'Not Found'
        : statusCode === 401
          ? 'Unauthorized'
          : statusCode === 400
            ? 'Bad Request'
            : 'Service Unavailable';
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
        JSON.stringify({ error: errorCode }),
    );
    socket.destroy();
  }
}
