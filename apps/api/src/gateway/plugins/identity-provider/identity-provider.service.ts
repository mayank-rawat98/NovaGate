import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import * as https from 'node:https';
import { createHash } from 'node:crypto';
import {
  DEFAULT_IDENTITY_PROVIDER,
  type GatewayConfig,
  type IdentityProviderSettings,
} from '../../../config/configuration';

interface Pending {
  abort: AbortController;
  promise: Promise<unknown>;
  waiters: number;
  settled: boolean;
  timer: NodeJS.Timeout;
}
@Injectable()
export class IdentityProviderService implements OnModuleDestroy {
  readonly settings: IdentityProviderSettings;
  private readonly cache = new Map<
    string,
    { value: unknown; expires: number }
  >();
  private readonly pending = new Map<string, Pending>();
  private readonly fetches = new Set<AbortController>();
  private waiters = 0;
  private stopping = false;
  constructor(config: ConfigService<GatewayConfig, true>) {
    this.settings = {
      ...DEFAULT_IDENTITY_PROVIDER,
      ...config.get('identityProvider', { infer: true }),
    };
  }
  get activeFetches() {
    return this.fetches.size;
  }
  get cacheSize() {
    return this.cache.size;
  }
  get occupiedAdmissions() {
    return (
      this.waiters +
      [...this.pending.values()].filter(
        (entry) => !entry.waiters && !entry.settled,
      ).length
    );
  }
  scope(kind: string, tenant: string, config: unknown, token?: string): string {
    // A credential change creates a different scope; raw secrets never appear in keys.
    return `${kind}:v2:${createHash('sha256')
      .update(JSON.stringify([tenant, config, token]))
      .digest('hex')}`;
  }
  getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    if (Date.now() >= entry.expires) return;
    this.cache.set(key, entry);
    return entry.value as T;
  }
  putCached<T>(key: string, value: T, ttl: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.stopping || ttl <= 0) return;
    this.cache.delete(key);
    for (const [existing, entry] of this.cache)
      if (entry.expires <= Date.now()) this.cache.delete(existing);
    while (this.cache.size >= this.settings.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expires: Date.now() + ttl });
  }
  clearCache() {
    this.cache.clear();
  }
  endpoint(raw: string): URL {
    const url = new URL(raw);
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && this.settings.allowInsecureHttp)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Invalid or insecure identity provider endpoint');
    return url;
  }
  validToken(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      !(
        /\s/.test(value) ||
        [...value].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
      ) &&
      Buffer.byteLength(value) <= this.settings.maxTokenBytes
    );
  }
  /** Shared requests survive one caller cancelling; the last departing caller aborts the work. */
  coalesce<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    if (this.stopping || caller?.aborted)
      return Promise.reject(new Error('Identity verification cancelled'));
    if (this.occupiedAdmissions >= this.settings.maxPendingRequests)
      return Promise.reject(
        new Error('Identity verification capacity exhausted'),
      );
    let entry = this.pending.get(key);
    if (entry?.abort.signal.aborted)
      return Promise.reject(new Error('Identity verification still settling'));
    if (!entry) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.settings.timeoutMs);
      entry = {
        abort,
        timer,
        waiters: 0,
        settled: false,
        promise: Promise.resolve().then(() => work(abort.signal)),
      };
      this.pending.set(key, entry);
      const created = entry;
      const cleanup = () => {
        created.settled = true;
        clearTimeout(timer);
        if (this.pending.get(key) === created) this.pending.delete(key);
      };
      void created.promise.then(cleanup, cleanup);
    }
    const shared = entry;
    shared.waiters++;
    this.waiters++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (finished) return;
        finished = true;
        caller?.removeEventListener('abort', cancelled);
        shared.abort.signal.removeEventListener('abort', cancelled);
        shared.waiters--;
        this.waiters--;
        if (!shared.waiters && !shared.settled) shared.abort.abort();
        if (error) reject(error);
        else resolve(value as T);
      };
      const cancelled = () =>
        finish(new Error('Identity verification cancelled or expired'));
      caller?.addEventListener('abort', cancelled, { once: true });
      shared.abort.signal.addEventListener('abort', cancelled, { once: true });
      void shared.promise.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }
  requestJson(
    raw: string,
    options: {
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    let url: URL;
    try {
      url = this.endpoint(raw);
      options.signal?.throwIfAborted();
    } catch {
      return Promise.reject(new Error('Invalid or cancelled provider request'));
    }
    if (
      this.stopping ||
      this.fetches.size >= this.settings.maxConcurrentFetches
    )
      return Promise.reject(new Error('Identity provider capacity exhausted'));
    if (
      options.body &&
      Buffer.byteLength(options.body) > this.settings.maxResponseBytes
    )
      return Promise.reject(new Error('Identity provider request too large'));
    const abort = new AbortController();
    this.fetches.add(abort);
    const signal = options.signal
      ? AbortSignal.any([options.signal, abort.signal])
      : abort.signal;
    return new Promise((resolve, reject) => {
      let response: http.IncomingMessage | undefined;
      let settled = false;
      const timer = setTimeout(() => abort.abort(), this.settings.timeoutMs);
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          abort.abort();
        } else resolve(value);
      };
      const destroyResponse = () => response?.destroy();
      let request: http.ClientRequest;
      try {
        request = (url.protocol === 'https:' ? https : http).request(
          url,
          {
            method: options.body === undefined ? 'GET' : 'POST',
            agent: false,
            signal,
            maxHeaderSize: this.settings.maxHeaderBytes,
            headers: {
              accept: 'application/json',
              ...(options.body === undefined
                ? {}
                : {
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': String(Buffer.byteLength(options.body)),
                  }),
              ...options.headers,
            },
          },
          (res) => {
            response = res;
            res.on('error', () =>
              finish(new Error('Identity provider response failed')),
            );
            res.once('aborted', () =>
              finish(new Error('Identity provider response aborted')),
            );
            const length = res.headers['content-length'];
            // Redirects are never followed: credentials cannot move to another endpoint.
            if (
              res.statusCode !== 200 ||
              (length &&
                (!/^\d+$/.test(length) ||
                  Number(length) > this.settings.maxResponseBytes))
            ) {
              finish(new Error('Invalid identity provider response'));
              res.destroy();
              return;
            }
            let bytes = 0;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > this.settings.maxResponseBytes) {
                finish(new Error('Identity provider response too large'));
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.once('end', () => {
              if (settled) return;
              try {
                const value: unknown = JSON.parse(
                  Buffer.concat(chunks).toString('utf8'),
                );
                if (!value || typeof value !== 'object' || Array.isArray(value))
                  throw new Error();
                finish(undefined, value);
              } catch {
                finish(new Error('Invalid identity provider JSON'));
              }
            });
          },
        );
        request.on('error', () =>
          finish(new Error('Identity provider request failed')),
        );
        request.once('close', () => {
          signal.removeEventListener('abort', destroyResponse);
          clearTimeout(timer);
          this.fetches.delete(abort);
          if (!settled)
            finish(new Error('Identity provider connection closed'));
        });
        signal.addEventListener('abort', destroyResponse, { once: true });
        request.end(options.body);
      } catch {
        clearTimeout(timer);
        this.fetches.delete(abort);
        finish(new Error('Invalid identity provider request'));
      }
    });
  }
  onModuleDestroy() {
    this.stopping = true;
    this.cache.clear();
    for (const entry of this.pending.values()) entry.abort.abort();
    for (const abort of this.fetches) abort.abort();
  }
}
