import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as http2 from 'http2';
import type { ClientHttp2Session, IncomingHttpHeaders } from 'http2';
import type { OutgoingHttpHeaders } from 'http';

const MAX_SESSIONS_PER_TARGET = 10;
const IDLE_TIMEOUT_MS = 30_000;

interface PoolEntry {
  session: ClientHttp2Session;
  activeStreams: number;
  lastUsed: number;
}

interface H2Response {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  trailers: IncomingHttpHeaders;
}

@Injectable()
export class Http2SessionPool implements OnModuleDestroy {
  private readonly logger = new Logger(Http2SessionPool.name);
  private readonly pool = new Map<string, PoolEntry[]>();

  onModuleDestroy(): void {
    this.destroyAll();
  }

  /**
   * Forward an HTTP/1.1-style request to a downstream service over HTTP/2.
   * Falls back to HTTP/1.1 proxy when the HTTP/2 session cannot be established.
   */
  async request(
    targetUrl: string,
    method: string,
    path: string,
    requestHeaders: OutgoingHttpHeaders,
    body: Buffer | null,
  ): Promise<H2Response> {
    const entry = this.acquireEntry(targetUrl);

    return new Promise<H2Response>((resolve, reject) => {
      const h2Headers: http2.OutgoingHttpHeaders = {
        ':method': method,
        ':path': path,
        ':scheme': 'http',
        ...requestHeaders,
      };

      if (body && body.length > 0) {
        h2Headers['content-length'] = String(body.length);
      }

      const req = entry.session.request(h2Headers, {
        endStream: !body || body.length === 0,
      });

      entry.activeStreams++;
      const done = () => {
        entry.activeStreams = Math.max(0, entry.activeStreams - 1);
        entry.lastUsed = Date.now();
      };

      const chunks: Buffer[] = [];
      let responseHeaders: IncomingHttpHeaders = {};
      let trailers: IncomingHttpHeaders = {};

      req.on('response', (headers) => {
        responseHeaders = headers;
      });

      req.on('trailers', (hdrs) => {
        trailers = hdrs;
      });

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        done();
        const status = Number(responseHeaders[':status'] ?? 200);
        resolve({
          statusCode: status,
          headers: responseHeaders,
          body: Buffer.concat(chunks),
          trailers,
        });
      });

      req.on('error', (err) => {
        done();
        reject(err);
      });

      if (body && body.length > 0) {
        req.end(body);
      }
    });
  }

  private acquireEntry(targetUrl: string): PoolEntry {
    const now = Date.now();
    const existing = this.pool.get(targetUrl) ?? [];

    // Evict destroyed or idle sessions
    const live = existing.filter(
      (e) => !e.session.destroyed && now - e.lastUsed < IDLE_TIMEOUT_MS,
    );

    // Find a session with available stream capacity
    const available = live.find(
      (e) =>
        e.activeStreams <
        (e.session.remoteSettings?.maxConcurrentStreams ?? 100),
    );
    if (available) {
      this.pool.set(targetUrl, live);
      return available;
    }

    if (live.length < MAX_SESSIONS_PER_TARGET) {
      const entry = this.createEntry(targetUrl, now);
      live.push(entry);
      this.pool.set(targetUrl, live);
      return entry;
    }

    // Pool full — reuse least-busy session
    const sorted = [...live].sort((a, b) => a.activeStreams - b.activeStreams);
    this.pool.set(targetUrl, sorted);
    return sorted[0];
  }

  private createEntry(targetUrl: string, now: number): PoolEntry {
    const url = new URL(targetUrl);
    const session = http2.connect(url.origin);

    session.on('error', (err) => {
      this.logger.error(
        JSON.stringify({
          msg: 'HTTP/2 session error',
          targetUrl,
          error: err.message,
        }),
      );
      this.evict(targetUrl, session);
    });

    session.on('close', () => {
      this.evict(targetUrl, session);
    });

    return { session, activeStreams: 0, lastUsed: now };
  }

  private evict(targetUrl: string, session: ClientHttp2Session): void {
    const entries = this.pool.get(targetUrl) ?? [];
    this.pool.set(
      targetUrl,
      entries.filter((e) => e.session !== session),
    );
    if (!session.destroyed) session.destroy();
  }

  destroyAll(): void {
    for (const [, entries] of this.pool) {
      for (const e of entries) {
        if (!e.session.destroyed) e.session.destroy();
      }
    }
    this.pool.clear();
  }
}
