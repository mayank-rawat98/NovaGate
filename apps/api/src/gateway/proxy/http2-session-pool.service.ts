import {
  Injectable,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http2 from 'http2';
import { performance } from 'node:perf_hooks';
import { isHttp2NegotiationFallback } from '../shared/http2-negotiation';
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  IncomingHttpHeaders,
} from 'http2';
import type { OutgoingHttpHeaders } from 'http';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { DEFAULT_HTTP2, type Http2Settings } from '../../config/configuration';

export class Http2PoolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly fallbackSafe = false,
  ) {
    super('HTTP/2 upstream request failed');
  }
}
interface PoolEntry {
  session: ClientHttp2Session;
  ready: Promise<void>;
  active: number;
  lastUsed: number;
  draining: boolean;
  peerReady: boolean;
}
interface H2Response {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  trailers: IncomingHttpHeaders;
}
const forbidden = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'host',
]);

/** Admission includes connecting calls and is released only after stream closure.
 * No application stream is opened before peer SETTINGS have been received. */
@Injectable()
export class Http2SessionPool implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Map<string, PoolEntry[]>();
  private readonly settings: Http2Settings;
  private readonly sweep: NodeJS.Timeout;
  private active = 0;
  private stopping = false;
  private unsubscribe?: () => void;
  private tenantId?: string | null;
  constructor(
    config: ConfigService = new ConfigService(),
    @Optional() private readonly manager?: GatewayConfigManagerService,
  ) {
    this.settings = { ...DEFAULT_HTTP2, ...config.get<Http2Settings>('http2') };
    this.sweep = setInterval(
      () => this.expireIdle(),
      Math.min(1000, this.settings.idleTimeoutMs),
    );
    this.sweep.unref();
  }
  onModuleInit(): void {
    this.tenantId = this.manager?.getTenantId();
    this.unsubscribe = this.manager?.subscribeConfig?.(() => {
      const tenantId = this.manager?.getTenantId();
      const retained = new Set(
        (this.manager?.getConfig()?.services ?? [])
          .filter((service) => service.h2)
          .flatMap((service) =>
            service.targets.map((target) => new URL(target.url).origin),
          ),
      );
      for (const [origin, entries] of this.pool)
        if (tenantId !== this.tenantId || !retained.has(origin))
          for (const entry of entries) {
            entry.draining = true;
            entry.session.destroy();
          }
      this.tenantId = tenantId;
    });
  }
  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.destroyAll();
  }
  get activeRequests(): number {
    return this.active;
  }
  get sessionCount(): number {
    return [...this.pool.values()].reduce(
      (n, entries) => n + entries.length,
      0,
    );
  }
  get targetCount(): number {
    return this.pool.size;
  }

  async request(
    targetUrl: string,
    method: string,
    path: string,
    requestHeaders: OutgoingHttpHeaders,
    body: Buffer | null,
    timeoutMs = 10000,
    signal?: AbortSignal,
  ): Promise<H2Response> {
    if (signal?.aborted) throw new Http2PoolError(499, 'HTTP2_CANCELLED');
    if (this.stopping || this.active >= this.settings.maxActiveRequests)
      throw new Http2PoolError(503, 'HTTP2_CAPACITY_EXCEEDED');
    const url = new URL(targetUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Http2PoolError(502, 'HTTP2_TARGET_INVALID');
    const headers: http2.OutgoingHttpHeaders = {};
    const nominated = String(requestHeaders.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim());
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (
        name.startsWith(':') ||
        forbidden.has(name.toLowerCase()) ||
        nominated.includes(name.toLowerCase())
      )
        continue;
      if (value !== undefined) headers[name.toLowerCase()] = value;
    }
    const queryIndex = path.indexOf('?');
    const requestPath = queryIndex < 0 ? path : path.slice(0, queryIndex);
    const requestQuery = queryIndex < 0 ? '' : path.slice(queryIndex + 1);
    const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const query = [url.search.slice(1), requestQuery].filter(Boolean).join('&');
    const forwardPath = `${prefix}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}${query ? `?${query}` : ''}`;
    Object.assign(headers, {
      ':method': method,
      ':path': forwardPath,
      ':scheme': url.protocol.slice(0, -1),
      ':authority': url.host,
    });
    if (body) headers['content-length'] = String(body.length);
    if (this.headerBytes(headers) > this.settings.maxHeaderBytes)
      throw new Http2PoolError(431, 'HTTP2_REQUEST_HEADERS_TOO_LARGE');
    const entry = this.acquire(url.origin);
    entry.active++;
    this.active++;
    return new Promise<H2Response>((resolve, reject) => {
      let stream: ClientHttp2Stream | undefined;
      let settled = false,
        released = false;
      let chunks: Buffer[] = [],
        bytes = 0;
      let responseHeaders: IncomingHttpHeaders | undefined;
      let trailers: IncomingHttpHeaders = {};
      const release = () => {
        if (released) return;
        released = true;
        entry.active--;
        this.active--;
        entry.lastUsed = performance.now();
        if (entry.draining && entry.active === 0) entry.session.destroy();
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        chunks = [];
        cleanup();
        reject(
          error instanceof Http2PoolError
            ? error
            : new Http2PoolError(502, 'DOWNSTREAM_ERROR'),
        );
        if (stream) stream.close(http2.constants.NGHTTP2_CANCEL);
        else release();
      };
      const cancelled = () => fail(new Http2PoolError(499, 'HTTP2_CANCELLED'));
      const timer = setTimeout(
        () => fail(new Http2PoolError(504, 'DOWNSTREAM_TIMEOUT')),
        timeoutMs,
      );
      timer.unref();
      signal?.addEventListener('abort', cancelled, { once: true });
      entry.ready.then(() => {
        if (settled) return;
        if (signal?.aborted) return cancelled();
        if (entry.draining || entry.session.closed || entry.session.destroyed)
          return fail(new Http2PoolError(502, 'DOWNSTREAM_ERROR'));
        const peer =
          entry.session.remoteSettings.maxConcurrentStreams ??
          this.settings.maxStreamsPerSession;
        if (entry.active > Math.min(peer, this.settings.maxStreamsPerSession))
          return fail(new Http2PoolError(503, 'HTTP2_CAPACITY_EXCEEDED'));
        try {
          stream = entry.session.request(headers, { endStream: !body?.length });
          stream.once('close', () => {
            release();
            if (!settled) fail(new Http2PoolError(502, 'DOWNSTREAM_ERROR'));
          });
          stream.on('error', () =>
            fail(new Http2PoolError(502, 'DOWNSTREAM_ERROR')),
          );
          stream.once('response', (value) => {
            if (this.headerBytes(value) > this.settings.maxHeaderBytes)
              return fail(
                new Http2PoolError(502, 'HTTP2_RESPONSE_HEADERS_TOO_LARGE'),
              );
            responseHeaders = value;
          });
          stream.once('trailers', (value) => {
            if (this.headerBytes(value) > this.settings.maxHeaderBytes)
              return fail(
                new Http2PoolError(502, 'HTTP2_RESPONSE_HEADERS_TOO_LARGE'),
              );
            trailers = value;
          });
          stream.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > this.settings.maxResponseBytes)
              return fail(new Http2PoolError(502, 'HTTP2_RESPONSE_TOO_LARGE'));
            chunks.push(chunk);
          });
          stream.once('end', () => {
            if (settled) return;
            const statusCode = Number(responseHeaders?.[':status']);
            if (
              !responseHeaders ||
              !Number.isInteger(statusCode) ||
              statusCode < 100 ||
              statusCode > 599 ||
              stream?.rstCode
            )
              return fail(new Http2PoolError(502, 'DOWNSTREAM_ERROR'));
            settled = true;
            cleanup();
            resolve({
              statusCode,
              headers: responseHeaders,
              body: Buffer.concat(chunks, bytes),
              trailers,
            });
            chunks = [];
          });
          if (body?.length) stream.end(body);
        } catch {
          fail(new Http2PoolError(502, 'DOWNSTREAM_ERROR'));
        }
      }, fail);
    });
  }
  private headerBytes(headers: OutgoingHttpHeaders): number {
    return Object.entries(headers).reduce(
      (n, [name, value]) =>
        n +
        Buffer.byteLength(name) +
        32 +
        (Array.isArray(value)
          ? value.reduce(
              (sum, part) => sum + Buffer.byteLength(String(part)),
              0,
            )
          : Buffer.byteLength(String(value ?? ''))),
      0,
    );
  }
  private acquire(origin: string): PoolEntry {
    this.expireIdle();
    const entries = this.pool.get(origin) ?? [];
    const available = entries.find(
      (entry) =>
        !entry.draining &&
        !entry.session.closed &&
        !entry.session.destroyed &&
        entry.active <
          Math.min(
            this.settings.maxStreamsPerSession,
            entry.peerReady
              ? (entry.session.remoteSettings.maxConcurrentStreams ??
                  this.settings.maxStreamsPerSession)
              : this.settings.maxStreamsPerSession,
          ),
    );
    if (available) return available;
    if (
      (!entries.length && this.pool.size >= this.settings.maxTargets) ||
      entries.length >= this.settings.maxSessionsPerTarget ||
      this.sessionCount >= this.settings.maxSessions
    )
      throw new Http2PoolError(503, 'HTTP2_CAPACITY_EXCEEDED');
    const entry = this.createEntry(origin);
    entries.push(entry);
    this.pool.set(origin, entries);
    return entry;
  }
  private createEntry(origin: string): PoolEntry {
    const session = http2.connect(origin, {
      maxHeaderListPairs: Math.floor(this.settings.maxHeaderBytes / 32),
      settings: {
        enablePush: false,
        maxHeaderListSize: this.settings.maxHeaderBytes,
      },
    });
    const entry: PoolEntry = {
      session,
      ready: Promise.resolve(),
      active: 0,
      lastUsed: performance.now(),
      draining: false,
      peerReady: false,
    };
    entry.ready = new Promise<void>((resolve, reject) => {
      let complete = false;
      const finish = (error?: Http2PoolError) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        session.off('remoteSettings', settings);
        session.off('error', failed);
        session.off('close', closed);
        if (error) reject(error);
        else resolve();
      };
      const settings = () => {
        entry.peerReady = true;
        finish();
      };
      const failed = (error: NodeJS.ErrnoException) => {
        const safe = isHttp2NegotiationFallback(error);
        finish(new Http2PoolError(502, 'DOWNSTREAM_ERROR', safe));
        session.destroy();
      };
      const closed = () => finish(new Http2PoolError(502, 'DOWNSTREAM_ERROR'));
      const timer = setTimeout(() => {
        finish(new Http2PoolError(504, 'DOWNSTREAM_TIMEOUT'));
        session.destroy();
      }, this.settings.connectTimeoutMs);
      timer.unref();
      session.once('remoteSettings', settings);
      session.once('error', failed);
      session.once('close', closed);
    });
    // A cancelled caller may leave a shared handshake finishing without waiters.
    void entry.ready.catch(() => undefined);
    session.on('error', () => {
      entry.draining = true;
      session.destroy();
    });
    session.on('goaway', () => {
      entry.draining = true;
      if (!entry.active) session.destroy();
    });
    session.on('stream', (stream) =>
      stream.close(http2.constants.NGHTTP2_CANCEL),
    );
    session.once('close', () => {
      const retained = (this.pool.get(origin) ?? []).filter(
        (value) => value !== entry,
      );
      if (retained.length) this.pool.set(origin, retained);
      else this.pool.delete(origin);
    });
    return entry;
  }
  private expireIdle(): void {
    for (const entries of this.pool.values())
      for (const entry of entries)
        if (
          !entry.active &&
          performance.now() - entry.lastUsed >= this.settings.idleTimeoutMs
        ) {
          entry.draining = true;
          entry.session.destroy();
        }
  }
  destroyAll(): void {
    this.stopping = true;
    clearInterval(this.sweep);
    for (const entries of this.pool.values())
      for (const entry of entries) entry.session.destroy();
  }
}
