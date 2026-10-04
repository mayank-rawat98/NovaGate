import {
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import jwt, { TokenExpiredError } from 'jsonwebtoken';
import type { PluginContext } from '@api-gateway/shared-types';
import {
  DEFAULT_GRPC,
  GatewayConfig,
  GrpcSettings,
} from '../../config/configuration';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginRunnerService } from '../plugins/plugin-runner.service';
import {
  GrpcFailure,
  GrpcFrameValidator,
  grpcTimeoutMs,
  grpcMetadata,
  grpcHeaderBytes,
} from './grpc-wire';

interface SessionEntry {
  tenantId: string | null;
  serviceId: string;
  target: string;
  session: http2.ClientHttp2Session;
  active: number;
  lastUsed: number;
  ready: boolean;
  retiring: boolean;
}
interface Call {
  tenantId: string | null;
  serviceId: string;
  target?: string;
  upstream?: http2.ClientHttp2Stream;
  request: http2.Http2ServerRequest;
  response: http2.Http2ServerResponse;
  done: boolean;
  admitting: boolean;
  abort: AbortController;
  finish: (status: number) => void;
  fail: (error: GrpcFailure) => void;
}
export function parseGrpcPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  return {
    grpcService: parts[0] ?? 'unknown',
    grpcMethod: parts[1] ?? 'unknown',
  };
}
export function isGrpcRequest(headers: http2.IncomingHttpHeaders): boolean {
  return (
    typeof headers['content-type'] === 'string' &&
    /^application\/grpc(?:\+[\w.-]+)?(?:\s*;.*)?$/i.test(
      headers['content-type'],
    )
  );
}

@Injectable()
export class GrpcProxyService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GrpcProxyService.name);
  private readonly settings: GrpcSettings;
  private readonly pool = new Map<string, SessionEntry[]>();
  private readonly calls = new Set<Call>();
  // Providers that cannot cancel still occupy admission capacity until they settle.
  private readonly detachedAdmissions = new Set<Call>();
  private readonly clients = new Set<http2.ServerHttp2Session>();
  private server?: http2.Http2Server | http2.Http2SecureServer;
  private sweep?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private stopping = false;

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
    this.settings = configService.get('grpc', { infer: true }) ?? DEFAULT_GRPC;
  }
  onModuleInit() {
    this.unsubscribe = this.configManager.subscribeConfig(() =>
      this.reconcile(),
    );
    this.sweep = setInterval(
      () => this.reconcile(),
      Math.min(this.settings.idleTimeoutMs, 1000),
    );
    this.sweep.unref();
  }
  async onApplicationBootstrap() {
    if (!this.settings.enabled) return;
    const options: http2.ServerOptions = {
      settings: {
        maxConcurrentStreams: this.settings.maxConcurrentStreams,
        maxHeaderListSize: this.settings.maxHeaderBytes,
      },
      maxHeaderListPairs: Math.floor(this.settings.maxHeaderBytes / 32),
    };
    if (this.settings.tlsCertFile && this.settings.tlsKeyFile) {
      this.server = http2.createSecureServer({
        ...options,
        key: readFileSync(this.settings.tlsKeyFile),
        cert: readFileSync(this.settings.tlsCertFile),
        allowHTTP1: false,
      });
    } else {
      if (!this.settings.allowInsecure)
        throw new Error(
          'gRPC listener requires TLS or explicit private cleartext configuration',
        );
      this.server = http2.createServer(options);
    }
    this.server.on('session', (session) => {
      if (this.stopping || this.clients.size >= this.settings.maxActiveCalls) {
        session.destroy();
        return;
      }
      this.clients.add(session);
      session.on('error', () => session.destroy());
      session.once('close', () => this.clients.delete(session));
      if (this.stopping) session.close();
    });
    this.server.on('request', (req, res) => {
      void this.handle(req, res);
    });
    this.server.on('sessionError', () =>
      this.logger.warn('gRPC client session failed'),
    );
    await new Promise<void>((resolve, reject) => {
      const server = this.server as http2.Http2Server;
      server.once('error', reject);
      server.listen(this.settings.port, this.settings.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server.on('error', () => this.logger.error('gRPC listener error'));
    this.logger.log('gRPC listener is ready');
  }
  get listeningPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address.port : undefined;
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.sweep);
    this.unsubscribe?.();
    const closed = this.server
      ? new Promise<void>((resolve) => this.server?.close(() => resolve()))
      : Promise.resolve();
    for (const session of this.clients) session.close();
    const deadline = Date.now() + this.settings.shutdownGraceMs;
    while (this.calls.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (const call of this.calls)
      call.fail(new GrpcFailure(14, 'Gateway shutting down'));
    for (const session of this.clients) session.destroy();
    this.destroyAll();
    await closed;
  }
  destroyAll() {
    for (const entries of this.pool.values())
      for (const entry of entries) entry.session.destroy();
    this.pool.clear();
  }
  private reconcile() {
    const config = this.configManager.getConfig();
    const tenantId = this.configManager.getTenantId();
    const retained = new Map(
      (config?.services ?? []).map((service) => [
        service.id,
        new Set(service.targets.map((target) => target.url)),
      ]),
    );
    for (const call of this.calls)
      if (
        call.tenantId !== tenantId ||
        !retained.has(call.serviceId) ||
        (call.target && !retained.get(call.serviceId)?.has(call.target))
      )
        call.fail(new GrpcFailure(14, 'Upstream configuration removed'));
    for (const entries of this.pool.values())
      for (const entry of [...entries]) {
        if (
          entry.tenantId !== tenantId ||
          !retained.get(entry.serviceId)?.has(entry.target)
        )
          this.retire(entry, true);
        else if (
          !entry.active &&
          Date.now() - entry.lastUsed >= this.settings.idleTimeoutMs
        )
          this.retire(entry, true);
      }
  }
  private retire(entry: SessionEntry, force = false) {
    entry.retiring = true;
    if (force || !entry.active) entry.session.destroy();
    else entry.session.close();
  }
  private acquire(serviceId: string, target: string): SessionEntry {
    const key = JSON.stringify([
      this.configManager.getTenantId(),
      serviceId,
      target,
    ]);
    const entries = this.pool.get(key) ?? [];
    const usable = entries.filter(
      (entry) =>
        !entry.retiring && !entry.session.destroyed && !entry.session.closed,
    );
    let entry = usable.find(
      (candidate) =>
        candidate.active <
        (candidate.ready
          ? Math.min(
              this.settings.maxConcurrentStreams,
              candidate.session.remoteSettings.maxConcurrentStreams ??
                this.settings.maxConcurrentStreams,
            )
          : 1),
    );
    if (!entry) {
      if (
        entries.filter((candidate) => !candidate.session.destroyed).length >=
        this.settings.maxSessionsPerTarget
      )
        throw new GrpcFailure(8, 'Upstream session capacity exhausted');
      const url = new URL(target);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new GrpcFailure(14, 'Invalid gRPC upstream origin');
      const session = http2.connect(url.origin, {
        settings: { maxHeaderListSize: this.settings.maxHeaderBytes },
        maxHeaderListPairs: Math.floor(this.settings.maxHeaderBytes / 32),
      });
      const created: SessionEntry = {
        tenantId: this.configManager.getTenantId(),
        serviceId,
        target,
        session,
        active: 0,
        lastUsed: Date.now(),
        ready: false,
        retiring: false,
      };
      entry = created;
      entries.push(created);
      this.pool.set(key, entries);
      session.on('remoteSettings', () => {
        created.ready = true;
      });
      session.on('goaway', () => this.retire(created));
      session.on('error', () => this.retire(created, true));
      session.once('close', () => {
        const survivors = (this.pool.get(key) ?? []).filter(
          (candidate) => candidate !== created,
        );
        if (survivors.length) this.pool.set(key, survivors);
        else this.pool.delete(key);
      });
    }
    entry.active++;
    return entry;
  }
  private get occupiedCalls(): number {
    return this.calls.size + this.detachedAdmissions.size;
  }
  private async awaitReady(entry: SessionEntry, signal: AbortSignal) {
    const unavailable = () => new GrpcFailure(14, 'Upstream unavailable');
    if (signal.aborted) throw unavailable();
    if (entry.session.destroyed || entry.session.closed) throw unavailable();
    if (!entry.ready)
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          entry.session.removeListener('remoteSettings', ready);
          entry.session.removeListener('error', failed);
          entry.session.removeListener('close', failed);
          signal.removeEventListener('abort', failed);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(unavailable());
        };
        entry.session.once('remoteSettings', ready);
        entry.session.once('error', failed);
        entry.session.once('close', failed);
        signal.addEventListener('abort', failed, { once: true });
      });
    if ((entry.session.remoteSettings.maxConcurrentStreams ?? 1) === 0)
      throw new GrpcFailure(8, 'Upstream session capacity exhausted');
  }
  private authenticate(ctx: PluginContext) {
    const authorization = ctx.req.headers.authorization;
    if (typeof authorization !== 'string') return;
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) return;
    const token = match[1];
    const config = this.configManager.getConfig();
    const hash = createHash('sha256').update(token).digest('hex');
    const consumer = config?.consumers.find((item) => item.keyHash === hash);
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
        throw new GrpcFailure(16, 'Access token has expired');
    }
  }
  private error(response: http2.Http2ServerResponse, error: GrpcFailure) {
    if (response.destroyed || response.writableEnded) return;
    // Drain buffered input while the error is sent; wantTrailers closes an
    // unfinished upload, so rejection never leaves a paused stream retained.
    response.req?.resume();
    if (!response.headersSent) {
      response.writeHead(200, {
        'content-type': 'application/grpc',
        'grpc-status': String(error.status),
        'grpc-message': encodeURIComponent(error.message),
      });
      response.end();
    } else {
      response.addTrailers({
        'grpc-status': String(error.status),
        'grpc-message': encodeURIComponent(error.message),
      });
      response.end();
    }
  }
  async handle(
    request: http2.Http2ServerRequest,
    response: http2.Http2ServerResponse,
  ): Promise<void> {
    request.pause();
    request.on('error', () => response.destroy());
    response.on('error', () => request.destroy());
    request.stream.once('wantTrailers', () => {
      // The compatibility response emits finish only after stream closure.
      // Release paused input after trailers are queued so early errors cannot
      // retain a closed stream's memory and consume the next admission slot.
      setImmediate(() => {
        if (
          response.writableEnded &&
          !request.readableEnded &&
          !request.stream.destroyed
        ) {
          request.stream.close(http2.constants.NGHTTP2_NO_ERROR);
          request.destroy();
        }
      });
    });
    if (!isGrpcRequest(request.headers)) {
      request.resume();
      response.writeHead(415);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      response.writeHead(405);
      response.end();
      return;
    }
    if (this.stopping) {
      this.error(response, new GrpcFailure(14, 'Gateway shutting down'));
      return;
    }
    if (this.occupiedCalls >= this.settings.maxActiveCalls) {
      this.error(
        response,
        new GrpcFailure(8, 'Gateway call capacity exhausted'),
      );
      return;
    }
    const config = this.configManager.getConfig();
    const route =
      config && matchRoute(request.method, request.url, config.routes);
    if (!config) {
      this.error(response, new GrpcFailure(14, 'Service unavailable'));
      return;
    }
    if (!route) {
      this.error(response, new GrpcFailure(12, 'Route not found'));
      return;
    }
    const service = config.services.find((item) => item.id === route.serviceId);
    if (!service) {
      this.error(response, new GrpcFailure(14, 'Service unavailable'));
      return;
    }
    const labels = parseGrpcPath(route.pathPattern);
    let timer: NodeJS.Timeout | undefined;
    let requestFrames: GrpcFrameValidator | undefined;
    let responseFrames: GrpcFrameValidator | undefined;
    const call: Call = {
      tenantId: this.configManager.getTenantId(),
      serviceId: service.id,
      request,
      response,
      done: false,
      admitting: true,
      abort: new AbortController(),
      finish: (status) => {
        if (call.done) return;
        call.done = true;
        clearTimeout(timer);
        call.abort.abort();
        this.calls.delete(call);
        if (call.admitting) this.detachedAdmissions.add(call);
        this.metricsService.setGrpcActiveCalls(this.occupiedCalls);
        request.unpipe(requestFrames);
        requestFrames?.unpipe();
        requestFrames?.destroy();
        call.upstream?.unpipe(responseFrames);
        responseFrames?.unpipe();
        responseFrames?.destroy();
        if (call.upstream && !call.upstream.destroyed)
          call.upstream.close(http2.constants.NGHTTP2_CANCEL);
        this.metricsService.incrementGrpcRequests(
          labels.grpcService,
          labels.grpcMethod,
          String(status),
        );
      },
      fail: (error) => {
        if (call.done) return;
        this.error(response, error);
        call.finish(error.status);
      },
    };
    this.calls.add(call);
    this.metricsService.setGrpcActiveCalls(this.occupiedCalls);
    request.stream.once('aborted', () => call.finish(1));
    response.once('close', () => call.finish(response.writableEnded ? 0 : 1));
    try {
      if (grpcHeaderBytes(request.headers) > this.settings.maxHeaderBytes)
        throw new GrpcFailure(8, 'gRPC headers exceed configured limit');
      if (!/^\/[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/.test(request.url))
        throw new GrpcFailure(3, 'Invalid gRPC method path');
      const clientDeadline = grpcTimeoutMs(request.headers['grpc-timeout']);
      const duration = Math.min(
        clientDeadline ?? Infinity,
        service.timeoutMs,
        this.settings.deadlineMs,
      );
      if (!Number.isFinite(duration) || duration <= 0)
        throw new GrpcFailure(4, 'Deadline exceeded');
      const expires = Date.now() + duration;
      timer = setTimeout(
        () => call.fail(new GrpcFailure(4, 'Deadline exceeded')),
        duration,
      );
      // Raw HTTP/2 handlers trust the socket peer. Remove client assertions before plugins.
      for (const name of [
        'forwarded',
        'x-forwarded-for',
        'x-real-ip',
        'ssl_client_cert',
        'x-ssl-client-cert',
        'x-ssl-client-subject',
        'x-ssl-client-san',
      ])
        delete request.headers[name];
      const ctx: PluginContext = {
        req: Object.assign(request, {
          requestId: randomUUID(),
        }) as unknown as PluginContext['req'],
        res: response as unknown as PluginContext['res'],
        route,
        service,
        signal: call.abort.signal,
        tenantId: call.tenantId ?? '',
        requestId: randomUUID(),
        logger: {
          info: (msg) => this.logger.log(msg),
          warn: (msg) => this.logger.warn(msg),
          error: (msg) => this.logger.error(msg),
        },
      };
      ctx.req.requestId = ctx.requestId;
      this.authenticate(ctx);
      const plugins = this.registry.resolve(route.plugins ?? []);
      if (plugins.some((plugin) => !plugin.protocols?.includes('grpc')))
        throw new GrpcFailure(12, 'A configured plugin does not support gRPC');
      const stopped = await this.runner.runOnRequest(plugins, ctx);
      if (call.done) return;
      if (stopped)
        throw new GrpcFailure(
          stopped.status === 401
            ? 16
            : stopped.status === 403
              ? 7
              : stopped.status === 429
                ? 8
                : 13,
          'Request rejected by configured plugin',
        );
      if (route.authRequired && !ctx.req.user && !ctx.authentication)
        throw new GrpcFailure(16, 'Authentication required');
      const limits = this.configService.get('rateLimit', { infer: true });
      const limit =
        route.rateLimitOverride ??
        (ctx.req.user || ctx.authentication
          ? limits.authMax
          : limits.unauthMax);
      const peer = request.socket.remoteAddress ?? 'unknown';
      const quota = await this.rateLimit.check(
        `grpc:${ctx.tenantId}:${route.id}:${ctx.req.user?.id ?? peer}`,
        limit,
      );
      if (call.done) return;
      if (!quota.allowed) throw new GrpcFailure(8, 'Rate limit exceeded');
      const currentService = this.configManager
        .getConfig()
        ?.services.find((item) => item.id === service.id);
      if (!currentService)
        throw new GrpcFailure(14, 'Upstream configuration removed');
      const targets = service.targets.filter((target) =>
        currentService.targets.some((current) => current.url === target.url),
      );
      const target = this.loadBalancer.selectTarget(
        service.id,
        targets,
        this.upstreamHealth.getHealthyUrls(targets, service.id),
        currentService.unhealthyFallback === true,
      );
      call.target = target;
      const entry = this.acquire(service.id, target);
      let upstream: http2.ClientHttp2Stream;
      try {
        await this.awaitReady(entry, call.abort.signal);
        if (call.done) throw new GrpcFailure(14, 'Call cancelled');
        const url = new URL(target);
        const remaining = Math.ceil(expires - Date.now());
        if (remaining <= 0) throw new GrpcFailure(4, 'Deadline exceeded');
        const headers: http2.OutgoingHttpHeaders = {
          ':method': 'POST',
          ':scheme': url.protocol.slice(0, -1),
          ':authority': url.host,
          ':path': request.url,
          ...grpcMetadata(request.headers),
          'grpc-timeout': `${remaining}m`,
          te: 'trailers',
        };
        upstream = entry.session.request(headers);
      } catch (error) {
        entry.active--;
        entry.lastUsed = Date.now();
        if (!entry.ready && !entry.active) this.retire(entry, true);
        throw error;
      }
      call.upstream = upstream;
      upstream.once('close', () => {
        entry.active = Math.max(0, entry.active - 1);
        entry.lastUsed = Date.now();
        if (entry.retiring && !entry.active) entry.session.destroy();
        // A normal upstream END_STREAM can precede draining the validator
        // into a slow downstream. Keep those buffered bytes and trailers alive.
        if (!call.done && !upstream.readableEnded)
          call.fail(new GrpcFailure(14, 'Upstream stream closed'));
      });
      upstream.on('error', () =>
        call.fail(new GrpcFailure(14, 'Upstream unavailable')),
      );
      let trailers: http2.IncomingHttpHeaders = {};
      let status = 2;
      upstream.once('response', async (headers) => {
        if (call.done) return;
        try {
          if (grpcHeaderBytes(headers) > this.settings.maxHeaderBytes)
            throw new GrpcFailure(
              8,
              'Upstream headers exceed configured limit',
            );
          if (headers[':status'] !== 200 || !isGrpcRequest(headers))
            throw new GrpcFailure(
              14,
              'Upstream returned an invalid gRPC response',
            );
          if (headers['grpc-status'] !== undefined) {
            status = this.status(headers['grpc-status']);
            trailers = headers;
          }
          const output = grpcMetadata(headers);
          await this.runner.runOnResponse(plugins, {
            ...ctx,
            statusCode: 200,
            headers: output,
          });
          if (call.done) return;
          response.writeHead(200, output);
          responseFrames = new GrpcFrameValidator(
            this.settings.maxMessageBytes,
            typeof headers['grpc-encoding'] === 'string'
              ? headers['grpc-encoding']
              : undefined,
          );
          responseFrames.on('error', (error) =>
            call.fail(
              error instanceof GrpcFailure
                ? error
                : new GrpcFailure(13, 'Invalid upstream frame'),
            ),
          );
          responseFrames.once('end', () => {
            if (call.done) return;
            response.addTrailers({
              ...grpcMetadata(trailers),
              'grpc-status': String(status),
            });
            response.end();
            call.finish(status);
          });
          upstream.pipe(responseFrames).pipe(response, { end: false });
        } catch (error) {
          call.fail(
            error instanceof GrpcFailure
              ? error
              : new GrpcFailure(13, 'Invalid upstream response'),
          );
        }
      });
      upstream.on('trailers', (headers) => {
        if (call.done) return;
        if (grpcHeaderBytes(headers) > this.settings.maxHeaderBytes) {
          call.fail(
            new GrpcFailure(8, 'Upstream trailers exceed configured limit'),
          );
          return;
        }
        trailers = headers;
        status = this.status(headers['grpc-status']);
      });
      requestFrames = new GrpcFrameValidator(
        this.settings.maxMessageBytes,
        typeof request.headers['grpc-encoding'] === 'string'
          ? request.headers['grpc-encoding']
          : undefined,
      );
      requestFrames.on('error', (error) =>
        call.fail(
          error instanceof GrpcFailure
            ? error
            : new GrpcFailure(13, 'Invalid request frame'),
        ),
      );
      request.pipe(requestFrames).pipe(upstream);
    } catch (error) {
      if (!(error instanceof GrpcFailure))
        this.logger.warn('gRPC dispatch failed');
      call.fail(
        error instanceof GrpcFailure
          ? error
          : new GrpcFailure(14, 'Upstream unavailable'),
      );
    } finally {
      call.admitting = false;
      this.detachedAdmissions.delete(call);
      this.metricsService.setGrpcActiveCalls(this.occupiedCalls);
    }
  }
  private status(value: string | string[] | number | undefined): number {
    return typeof value === 'string' && /^(?:[0-9]|1[0-6])$/.test(value)
      ? Number(value)
      : 2;
  }
}
