import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import jwt, { TokenExpiredError } from 'jsonwebtoken';
import type {
  GatewayPlugin,
  PluginContext,
  RouteConfig,
  ServiceConfig,
} from '@api-gateway/shared-types';
import {
  DEFAULT_WEBSOCKET,
  type GatewayConfig,
  type WebSocketSettings,
} from '../../config/configuration';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { MetricsService } from '../metrics/metrics.service';
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginRunnerService } from '../plugins/plugin-runner.service';
import {
  WsFailure,
  wsHandshake,
  wsHeaders,
  wsHeaderBytes,
  wsSerialize,
  wsValidateResponse,
} from './ws-wire';

interface Connection {
  socket: net.Socket;
  requestId: string;
  upstream?: net.Socket;
  request?: http.ClientRequest;
  tenantId: string | null;
  route: RouteConfig;
  service: ServiceConfig;
  target?: string;
  principal?: string;
  policy: string;
  opened: boolean;
  done: boolean;
  admitting: boolean;
  abort: AbortController;
  timer?: NodeJS.Timeout;
  earlyChunks: Buffer[];
  earlyBytes: number;
  collect?: (chunk: Buffer) => void;
}

@Injectable()
export class WsProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsProxyService.name);
  private readonly connections = new Set<Connection>();
  // Disconnected callers cannot free quota/auth capacity while unabortable work is still running.
  private readonly detachedAdmissions = new Set<Connection>();
  private readonly settings: WebSocketSettings;
  private stopping = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly metricsService: MetricsService,
    private readonly loadBalancer: LoadBalancerService,
    private readonly upstreamHealth: UpstreamHealthService,
    private readonly configService: ConfigService<GatewayConfig, true>,
    private readonly rateLimit: RateLimitService,
    private readonly registry: PluginRegistryService,
    private readonly runner: PluginRunnerService,
  ) {
    this.settings = {
      ...DEFAULT_WEBSOCKET,
      ...this.configService.get('websocket', { infer: true }),
    };
  }
  get occupiedConnections() {
    return this.connections.size + this.detachedAdmissions.size;
  }
  onModuleInit() {
    this.unsubscribe = this.configManager.subscribeConfig(() =>
      this.reconcile(),
    );
  }
  private policy(
    route: RouteConfig,
    service: ServiceConfig,
    principal?: string,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          route,
          supportsWebSocket: service.supportsWebSocket,
          consumer: principal
            ? this.configManager
                .getConfig()
                ?.consumers.find((item) => item.id === principal)
            : undefined,
        }),
      )
      .digest('hex');
  }
  private current(connection: Connection): boolean {
    const config = this.configManager.getConfig();
    const route = config?.routes.find(
      (item) => item.id === connection.route.id,
    );
    const service = config?.services.find(
      (item) => item.id === connection.service.id,
    );
    return !!(
      this.configManager.getTenantId() === connection.tenantId &&
      route?.enabled &&
      service?.supportsWebSocket &&
      this.policy(route, service, connection.principal) === connection.policy &&
      (!connection.target ||
        service.targets.some((item) => item.url === connection.target))
    );
  }
  private reconcile() {
    for (const connection of this.connections) {
      if (!this.current(connection))
        this.fail(
          connection,
          new WsFailure(
            503,
            'SERVICE_UNAVAILABLE',
            'WebSocket configuration changed',
          ),
        );
    }
  }
  private finish(
    connection: Connection,
    destroyClient = true,
    reason = 'CONNECTION_CLOSED',
  ) {
    if (connection.done) return;
    connection.done = true;
    clearTimeout(connection.timer);
    connection.abort.abort();
    this.connections.delete(connection);
    if (connection.admitting) this.detachedAdmissions.add(connection);
    if (connection.collect)
      connection.socket.removeListener('data', connection.collect);
    connection.earlyChunks.length = 0;
    connection.socket.unpipe();
    connection.upstream?.unpipe();
    connection.request?.destroy();
    connection.upstream?.destroy();
    if (destroyClient) connection.socket.destroy();
    if (connection.opened) {
      this.metricsService.decrementWsConnections();
      this.logger.log(
        JSON.stringify({
          msg: 'WebSocket connection closed',
          tenantId: connection.tenantId,
          routeId: connection.route.id,
          serviceId: connection.service.id,
          requestId: connection.requestId,
          reason,
        }),
      );
    }
  }
  private fail(connection: Connection, failure: WsFailure) {
    if (connection.done) return;
    if (!connection.opened)
      this.reject(connection.socket, failure, connection.requestId);
    this.finish(connection, connection.opened, failure.code);
  }
  private reject(socket: net.Socket, failure: WsFailure, requestId: string) {
    if (socket.destroyed || socket.writableEnded) return;
    const challenge: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(failure.headers)) {
      if (
        !['www-authenticate', 'retry-after'].includes(name.toLowerCase()) ||
        typeof value !== 'string'
      )
        continue;
      try {
        http.validateHeaderValue(name, value);
        challenge[name.toLowerCase()] = value;
      } catch {
        /* Reject unsafe plugin challenge headers without breaking the error boundary. */
      }
    }
    const body = JSON.stringify({
      error: failure.code,
      message: failure.message,
      requestId,
    });
    socket.setTimeout(this.settings.handshakeTimeoutMs, () => socket.destroy());
    socket.resume();
    socket.end(
      wsSerialize(failure.status, {
        ...challenge,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
        'x-request-id': requestId,
      }) + body,
      () => socket.destroy(),
    );
  }
  private authenticate(ctx: PluginContext) {
    const header = ctx.req.headers.authorization;
    const match =
      typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match) return;
    const token = match[1];
    const hash = createHash('sha256').update(token).digest('hex');
    const consumer = this.configManager
      .getConfig()
      ?.consumers.find((item) => item.keyHash === hash);
    if (consumer) {
      ctx.req.user = { id: consumer.id };
      return;
    }
    try {
      const payload = jwt.verify(
        token,
        this.configService.get('jwt', { infer: true }).secret,
        { algorithms: ['HS256'] },
      );
      if (typeof payload === 'string') return;
      const subject = payload.sub ?? payload.userId ?? payload.id;
      if (
        typeof subject === 'string' &&
        subject.length > 0 &&
        subject.length <= 128
      )
        ctx.req.user = { id: subject };
    } catch (error) {
      if (error instanceof TokenExpiredError)
        throw new WsFailure(401, 'TOKEN_EXPIRED', 'Access token has expired');
    }
  }
  /** All upgrade errors terminate inside this boundary, never at the raw HTTP server event. */
  async handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    socket.pause();
    socket.on('error', () => socket.destroy());
    const requestId = randomUUID();
    let connection: Connection | undefined;
    try {
      if (this.stopping)
        throw new WsFailure(
          503,
          'SERVICE_UNAVAILABLE',
          'Gateway shutting down',
        );
      if (this.occupiedConnections >= this.settings.maxConnections)
        throw new WsFailure(
          503,
          'WS_CAPACITY_EXHAUSTED',
          'WebSocket connection capacity exhausted',
        );
      const queryToken = wsHandshake(req, head, this.settings);
      const key = req.headers['sec-websocket-key'] as string;
      const protocols = req.headers['sec-websocket-protocol'] as
        | string
        | undefined;
      const extensions = req.headers['sec-websocket-extensions'] as
        | string
        | undefined;
      if (queryToken) req.headers.authorization = `Bearer ${queryToken}`;
      const config = this.configManager.getConfig();
      if (!config)
        throw new WsFailure(503, 'SERVICE_UNAVAILABLE', 'Service unavailable');
      const route = matchRoute(
        'GET',
        (req.url ?? '/').split('?')[0],
        config.routes,
      );
      if (!route)
        throw new WsFailure(404, 'SERVICE_NOT_FOUND', 'Route not found');
      const service = config.services.find(
        (item) => item.id === route.serviceId,
      );
      if (!service?.targets.length)
        throw new WsFailure(404, 'SERVICE_NOT_FOUND', 'Service not found');
      if (!service.supportsWebSocket)
        throw new WsFailure(
          400,
          'WS_NOT_SUPPORTED',
          'Service does not support WebSocket',
        );
      connection = {
        socket,
        requestId,
        tenantId: this.configManager.getTenantId(),
        route,
        service,
        policy: this.policy(route, service),
        opened: false,
        done: false,
        admitting: true,
        abort: new AbortController(),
        earlyChunks: head.length ? [head] : [],
        earlyBytes: head.length,
      };
      const active = connection;
      this.connections.add(active);
      socket.once('close', () => this.finish(active));
      socket.once('end', () => {
        if (!active.opened) this.finish(active);
      });
      active.collect = (chunk: Buffer) => {
        active.earlyBytes += chunk.length;
        if (active.earlyBytes > this.settings.maxBufferedHeadBytes) {
          this.fail(
            active,
            new WsFailure(
              413,
              'REQUEST_TOO_LARGE',
              'Buffered upgrade data exceeds configured limit',
            ),
          );
          return;
        }
        active.earlyChunks.push(chunk);
      };
      socket.on('data', active.collect);
      // Observe FIN while auth/quota is pending, without unbounded early-frame buffering.
      socket.resume();
      const timeout = Math.min(
        this.settings.handshakeTimeoutMs,
        service.timeoutMs,
      );
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new WsFailure(
          504,
          'DOWNSTREAM_TIMEOUT',
          'Invalid WebSocket deadline',
        );
      active.timer = setTimeout(
        () =>
          this.fail(
            active,
            new WsFailure(
              504,
              'DOWNSTREAM_TIMEOUT',
              'WebSocket handshake deadline exceeded',
            ),
          ),
        timeout,
      );
      const ctx: PluginContext = {
        req: Object.assign(req, { requestId }),
        res: new http.ServerResponse(req),
        route,
        service,
        tenantId: active.tenantId ?? '',
        requestId,
        signal: active.abort.signal,
        logger: {
          info: (msg) => this.logger.log(msg),
          warn: (msg) => this.logger.warn(msg),
          error: (msg) => this.logger.error(msg),
        },
      };
      this.authenticate(ctx);
      active.principal = ctx.req.user?.id;
      active.policy = this.policy(route, service, active.principal);
      const plugins = this.registry.resolve(route.plugins ?? []);
      if (plugins.some((plugin) => !plugin.protocols?.includes('websocket')))
        throw new WsFailure(
          500,
          'WS_PLUGIN_UNSUPPORTED',
          'A configured plugin does not support WebSocket',
        );
      const stopped = await this.runner.runOnRequest(plugins, ctx);
      if (active.done) return;
      if (stopped) {
        let code = 'PLUGIN_REJECTED';
        let message = 'Request rejected by configured plugin';
        try {
          const body = JSON.parse(String(stopped.body));
          if (typeof body.error === 'string') code = body.error;
          if (typeof body.message === 'string') message = body.message;
        } catch {
          /* Non-JSON plugin bodies are normalized. */
        }
        const status =
          Number.isInteger(stopped.status) &&
          stopped.status >= 400 &&
          stopped.status <= 599
            ? stopped.status
            : 500;
        throw new WsFailure(status, code, message, stopped.headers);
      }
      if (route.authRequired && !ctx.req.user && !ctx.authentication)
        throw new WsFailure(401, 'TOKEN_INVALID', 'Authentication required');
      const limits = this.configService.get('rateLimit', { infer: true });
      const identity =
        ctx.req.user?.id ??
        (ctx.authentication?.subject
          ? `${ctx.authentication.method}:${ctx.authentication.subject}`
          : (socket.remoteAddress ?? 'unknown'));
      const quota = await this.rateLimit.check(
        `ws:${ctx.tenantId}:${route.id}:${identity}`,
        route.rateLimitOverride ??
          (ctx.req.user || ctx.authentication
            ? limits.authMax
            : limits.unauthMax),
      );
      if (active.done) return;
      if (!quota.allowed)
        throw new WsFailure(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
      if (!this.current(active))
        throw new WsFailure(
          503,
          'SERVICE_UNAVAILABLE',
          'WebSocket configuration changed',
        );
      const currentService = this.configManager
        .getConfig()
        ?.services.find((item) => item.id === service.id);
      const targets = service.targets.filter((target) =>
        currentService?.targets.some((current) => current.url === target.url),
      );
      try {
        active.target = this.loadBalancer.selectTarget(
          service.id,
          targets,
          this.upstreamHealth.getHealthyUrls(targets, service.id),
          currentService?.unhealthyFallback === true,
        );
      } catch {
        throw new WsFailure(
          503,
          'NO_HEALTHY_TARGETS',
          'No healthy upstream targets',
        );
      }
      const url = new URL(active.target);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new WsFailure(
          502,
          'DOWNSTREAM_ERROR',
          'Invalid WebSocket upstream configuration',
        );
      url.pathname =
        url.pathname.replace(/\/$/, '') + (req.url ?? '/').split('?')[0];
      url.search = (req.url ?? '/').includes('?')
        ? (req.url ?? '/').slice((req.url ?? '/').indexOf('?'))
        : '';
      const headers: http.OutgoingHttpHeaders = {
        ...wsHeaders(req.headers),
        host: url.host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        'x-request-id': requestId,
      };
      if (protocols) headers['sec-websocket-protocol'] = protocols;
      if (extensions) headers['sec-websocket-extensions'] = extensions;
      if (wsHeaderBytes(headers) > this.settings.maxHeaderBytes)
        throw new WsFailure(
          431,
          'WS_HEADERS_TOO_LARGE',
          'Upstream headers exceed configured limit',
        );
      active.request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET',
        headers,
        agent: false,
        signal: active.abort.signal,
        maxHeaderSize: this.settings.maxHeaderBytes,
      });
      active.request.on('error', () =>
        this.fail(
          active,
          new WsFailure(
            502,
            'DOWNSTREAM_ERROR',
            'WebSocket upstream unavailable',
          ),
        ),
      );
      active.request.once('response', (response) => {
        response.destroy();
        this.fail(
          active,
          new WsFailure(
            502,
            'DOWNSTREAM_ERROR',
            'Upstream refused WebSocket upgrade',
          ),
        );
      });
      active.request.once('upgrade', (response, upstream, upstreamHead) => {
        // Async event callbacks always handle their own rejections.
        void this.accept(
          active,
          ctx,
          plugins,
          response,
          upstream,
          upstreamHead,
          key,
          protocols,
          extensions,
        );
      });
      active.request.end();
    } catch (error) {
      const failure =
        error instanceof WsFailure
          ? error
          : new WsFailure(
              503,
              'SERVICE_UNAVAILABLE',
              'WebSocket admission unavailable',
            );
      if (connection) this.fail(connection, failure);
      else this.reject(socket, failure, requestId);
    } finally {
      if (connection) {
        connection.admitting = false;
        this.detachedAdmissions.delete(connection);
      }
    }
  }
  private async accept(
    connection: Connection,
    ctx: PluginContext,
    plugins: GatewayPlugin[],
    response: http.IncomingMessage,
    upstream: net.Socket,
    upstreamHead: Buffer,
    key: string,
    protocols?: string,
    extensions?: string,
  ) {
    if (connection.done) {
      upstream.destroy();
      return;
    }
    connection.admitting = true;
    connection.upstream = upstream;
    upstream.pause();
    upstream.on('error', () =>
      this.fail(
        connection,
        new WsFailure(
          502,
          'DOWNSTREAM_ERROR',
          'WebSocket upstream unavailable',
        ),
      ),
    );
    upstream.once('close', () => {
      if (!upstream.readableEnded) this.finish(connection);
    });
    try {
      wsValidateResponse(response, key, protocols, extensions);
      if (
        wsHeaderBytes(response.headers) > this.settings.maxHeaderBytes ||
        upstreamHead.length > this.settings.maxBufferedHeadBytes
      )
        throw new WsFailure(
          502,
          'DOWNSTREAM_ERROR',
          'Upstream upgrade exceeds configured limits',
        );
      const output = wsHeaders(response.headers);
      await this.runner.runOnResponse(plugins, {
        ...ctx,
        statusCode: 101,
        headers: output,
      });
      if (connection.done) return;
      if (!this.current(connection))
        throw new WsFailure(
          503,
          'SERVICE_UNAVAILABLE',
          'WebSocket configuration changed',
        );
      Object.assign(output, ctx.res.getHeaders(), {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-accept': response.headers['sec-websocket-accept'],
        'x-request-id': ctx.requestId,
      });
      // Auth/response plugins cannot replace the negotiated protocol or extensions.
      for (const name of [
        'sec-websocket-protocol',
        'sec-websocket-extensions',
      ]) {
        delete output[name];
        if (response.headers[name]) output[name] = response.headers[name];
      }
      if (wsHeaderBytes(output) > this.settings.maxHeaderBytes)
        throw new WsFailure(
          502,
          'DOWNSTREAM_ERROR',
          'Upgrade headers exceed configured limit',
        );
      connection.socket.write(wsSerialize(101, output));
      connection.opened = true;
      clearTimeout(connection.timer);
      this.metricsService.incrementWsConnections();
      const expired = () => this.finish(connection, true, 'IDLE_TIMEOUT');
      connection.socket.setTimeout(this.settings.idleTimeoutMs, expired);
      upstream.setTimeout(this.settings.idleTimeoutMs, expired);
      connection.socket.on('data', (chunk: Buffer) =>
        this.metricsService.incrementWsBytes('inbound', chunk.length),
      );
      upstream.on('data', (chunk: Buffer) =>
        this.metricsService.incrementWsBytes('outbound', chunk.length),
      );
      // Reinsert upgrade-coalesced bytes so pipe handles them under normal backpressure.
      connection.socket.pause();
      if (connection.collect)
        connection.socket.removeListener('data', connection.collect);
      if (connection.earlyBytes)
        connection.socket.unshift(Buffer.concat(connection.earlyChunks));
      connection.earlyChunks.length = 0;
      if (upstreamHead.length) upstream.unshift(upstreamHead);
      connection.socket.pipe(upstream);
      upstream.pipe(connection.socket);
      this.logger.log(
        JSON.stringify({
          msg: 'WebSocket connection accepted',
          tenantId: connection.tenantId,
          routeId: connection.route.id,
          serviceId: connection.service.id,
          requestId: ctx.requestId,
        }),
      );
    } catch (error) {
      this.fail(
        connection,
        error instanceof WsFailure
          ? error
          : new WsFailure(
              502,
              'DOWNSTREAM_ERROR',
              'Invalid WebSocket upstream response',
            ),
      );
    } finally {
      connection.admitting = false;
      this.detachedAdmissions.delete(connection);
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    for (const connection of this.connections)
      if (!connection.opened)
        this.fail(
          connection,
          new WsFailure(503, 'SERVICE_UNAVAILABLE', 'Gateway shutting down'),
        );
    if (this.connections.size && this.settings.shutdownGraceMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.settings.shutdownGraceMs);
        const closed = () => {
          if (!this.connections.size) {
            clearTimeout(timer);
            resolve();
          }
        };
        for (const connection of this.connections)
          connection.socket.once('close', closed);
      });
    }
    // Opaque tunnels drain during grace. Injecting a close frame could interrupt a partial frame.
    for (const connection of this.connections)
      this.finish(connection, true, 'GATEWAY_SHUTDOWN');
  }
}
