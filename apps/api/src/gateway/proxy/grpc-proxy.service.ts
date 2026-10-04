import { Injectable, Logger } from '@nestjs/common';
import * as http2 from 'http2';
import type { Http2Session, ClientHttp2Session } from 'http2';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'http';
import { MetricsService } from '../metrics/metrics.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoadBalancerService } from './load-balancer.service';
import { UpstreamHealthService } from '../health/upstream-health.service';
import { matchRoute } from '../shared/route-matcher';
import type { ServiceConfig } from '@api-gateway/shared-types';

const GRPC_CONTENT_TYPE_PREFIX = 'application/grpc';
const SESSION_IDLE_TIMEOUT_MS = 30_000;
const MAX_SESSIONS_PER_TARGET = 10;

interface SessionEntry {
  session: ClientHttp2Session;
  activeStreams: number;
  lastUsed: number;
}

/** Parses `/ServiceName/MethodName` into { grpcService, grpcMethod } */
export function parseGrpcPath(path: string): {
  grpcService: string;
  grpcMethod: string;
} {
  const parts = path.split('/').filter(Boolean);
  return {
    grpcService: parts[0] ?? 'unknown',
    grpcMethod: parts[1] ?? 'unknown',
  };
}

/** Returns true when the request Content-Type is application/grpc* */
export function isGrpcRequest(headers: IncomingHttpHeaders): boolean {
  const ct = headers['content-type'];
  return typeof ct === 'string' && ct.startsWith(GRPC_CONTENT_TYPE_PREFIX);
}

@Injectable()
export class GrpcProxyService {
  private readonly logger = new Logger(GrpcProxyService.name);
  /** pool[targetUrl] = list of sessions */
  private readonly pool = new Map<string, SessionEntry[]>();

  constructor(
    private readonly configManager: GatewayConfigManagerService,
    private readonly metricsService: MetricsService,
    private readonly loadBalancer: LoadBalancerService,
    private readonly upstreamHealth: UpstreamHealthService,
  ) {}

  /**
   * Proxy an HTTP/2 stream from an incoming HTTP/2 server push session.
   * Called when an `http2.Http2ServerRequest` arrives with a gRPC content-type.
   */
  async proxyStream(
    incomingHeaders: IncomingHttpHeaders & {
      ':path'?: string;
      ':method'?: string;
    },
    incomingBody: Buffer,
    sendResponse: (
      status: number,
      headers: OutgoingHttpHeaders,
      body: Buffer,
      trailers?: OutgoingHttpHeaders,
    ) => void,
  ): Promise<void> {
    const config = this.configManager.getConfig();
    if (!config) {
      this.sendGrpcError(sendResponse, 14, 'Service unavailable');
      return;
    }

    const path = incomingHeaders[':path'] ?? '/';
    const method = incomingHeaders[':method'] ?? 'POST';
    const route = matchRoute(method, path, config.routes);

    if (!route) {
      this.sendGrpcError(sendResponse, 12, 'Route not found');
      return;
    }

    // Enforce route auth on the gRPC path too — there is no JwtMiddleware here,
    // so a route flagged authRequired must at least carry an authorization
    // header (gRPC status 16 = UNAUTHENTICATED).
    if (route.authRequired && !incomingHeaders['authorization']) {
      this.sendGrpcError(sendResponse, 16, 'Authentication required');
      return;
    }

    const service = config.services.find(
      (s: ServiceConfig) => s.id === route.serviceId,
    );
    if (!service || !service.targets || service.targets.length === 0) {
      this.sendGrpcError(sendResponse, 14, 'No targets configured');
      return;
    }

    const healthyUrls = this.upstreamHealth.getHealthyUrls(
      service.targets,
      service.id,
    );
    let targetUrl: string;
    try {
      targetUrl = this.loadBalancer.selectTarget(
        service.id,
        service.targets,
        healthyUrls,
        service.unhealthyFallback === true,
      );
    } catch {
      this.sendGrpcError(
        sendResponse,
        14,
        'No healthy upstream targets are available',
      );
      return;
    }

    const { grpcService, grpcMethod } = parseGrpcPath(path);

    try {
      const { responseHeaders, responseBody, trailers } =
        await this.forwardGrpc(targetUrl, incomingHeaders, incomingBody);

      const grpcStatus =
        (trailers as Record<string, string>)?.['grpc-status'] ?? '0';

      this.metricsService.incrementGrpcRequests(
        grpcService,
        grpcMethod,
        grpcStatus,
      );

      sendResponse(200, responseHeaders, responseBody, trailers);
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          msg: 'gRPC proxy error',
          error: (err as Error).message,
          targetUrl,
          path,
        }),
      );
      this.metricsService.incrementGrpcRequests(grpcService, grpcMethod, '2');
      this.sendGrpcError(sendResponse, 2, 'Internal gateway error');
    }
  }

  private forwardGrpc(
    targetUrl: string,
    incomingHeaders: IncomingHttpHeaders & {
      ':path'?: string;
      ':method'?: string;
    },
    body: Buffer,
  ): Promise<{
    responseHeaders: OutgoingHttpHeaders;
    responseBody: Buffer;
    trailers: OutgoingHttpHeaders;
  }> {
    return new Promise((resolve, reject) => {
      const session = this.acquireSession(targetUrl);
      // Derive scheme from the target so TLS gRPC targets get a consistent
      // :scheme pseudo-header instead of a hard-coded http.
      const scheme = new URL(targetUrl).protocol.slice(0, -1);

      const forwardHeaders: http2.OutgoingHttpHeaders = {
        ':method': incomingHeaders[':method'] ?? 'POST',
        ':path': incomingHeaders[':path'] ?? '/',
        ':scheme': scheme,
        'content-type': incomingHeaders['content-type'],
        'content-length': String(body.length),
        te: 'trailers',
      };

      // Forward grpc-timeout if present
      if (incomingHeaders['grpc-timeout']) {
        forwardHeaders['grpc-timeout'] = incomingHeaders['grpc-timeout'];
      }

      // Forward authorization
      if (incomingHeaders['authorization']) {
        forwardHeaders['authorization'] = incomingHeaders['authorization'];
      }

      const req = session.session.request(forwardHeaders, { endStream: false });

      const chunks: Buffer[] = [];
      let responseHeaders: OutgoingHttpHeaders = {};
      let trailers: OutgoingHttpHeaders = {};

      req.on('response', (headers) => {
        responseHeaders = headers as OutgoingHttpHeaders;
      });

      req.on('trailers', (hdrs) => {
        trailers = hdrs as OutgoingHttpHeaders;
      });

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        session.activeStreams--;
        session.lastUsed = Date.now();
        resolve({
          responseHeaders,
          responseBody: Buffer.concat(chunks),
          trailers,
        });
      });

      req.on('error', (err) => {
        session.activeStreams--;
        reject(err);
      });

      session.activeStreams++;
      req.end(body);
    });
  }

  private acquireSession(targetUrl: string): SessionEntry {
    const existing = this.pool.get(targetUrl) ?? [];
    // Evict dead or idle sessions
    const now = Date.now();
    const live = existing.filter(
      (e) => !e.session.destroyed && now - e.lastUsed < SESSION_IDLE_TIMEOUT_MS,
    );

    // Find a session with capacity
    const available = live.find(
      (e) =>
        e.activeStreams <
        (e.session.remoteSettings?.maxConcurrentStreams ?? 100),
    );
    if (available) {
      this.pool.set(targetUrl, live);
      return available;
    }

    // Create a new session if pool isn't full
    if (live.length < MAX_SESSIONS_PER_TARGET) {
      const session = this.createSession(targetUrl);
      const entry: SessionEntry = { session, activeStreams: 0, lastUsed: now };
      live.push(entry);
      this.pool.set(targetUrl, live);
      return entry;
    }

    // Pool full — reuse the least-used session
    const sorted = live.sort((a, b) => a.activeStreams - b.activeStreams);
    this.pool.set(targetUrl, sorted);
    return sorted[0];
  }

  private createSession(targetUrl: string): ClientHttp2Session {
    const url = new URL(targetUrl);
    const session = http2.connect(url.origin);

    session.on('error', (err) => {
      this.logger.error(
        JSON.stringify({
          msg: 'gRPC HTTP/2 session error',
          targetUrl,
          error: err.message,
        }),
      );
      this.evictSession(targetUrl, session);
    });

    session.on('close', () => {
      this.evictSession(targetUrl, session);
    });

    return session;
  }

  private evictSession(targetUrl: string, session: Http2Session): void {
    const entries = this.pool.get(targetUrl) ?? [];
    this.pool.set(
      targetUrl,
      entries.filter((e) => e.session !== session),
    );
    if (!session.destroyed) session.destroy();
  }

  private sendGrpcError(
    sendResponse: (
      status: number,
      headers: OutgoingHttpHeaders,
      body: Buffer,
      trailers?: OutgoingHttpHeaders,
    ) => void,
    grpcStatus: number,
    message: string,
  ): void {
    sendResponse(
      200,
      {
        'content-type': 'application/grpc',
        'grpc-status': String(grpcStatus),
        'grpc-message': message,
      },
      Buffer.alloc(0),
      {},
    );
  }

  /** Destroy all pooled sessions (for graceful shutdown). */
  destroyAll(): void {
    for (const [, entries] of this.pool) {
      for (const e of entries) {
        if (!e.session.destroyed) e.session.destroy();
      }
    }
    this.pool.clear();
  }
}
