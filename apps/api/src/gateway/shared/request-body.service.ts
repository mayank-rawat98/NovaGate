import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import type { PluginContext } from '@api-gateway/shared-types';
import {
  DEFAULT_BODY_CAPTURE,
  DEFAULT_GRAPHQL,
  DEFAULT_HMAC,
  BodyCaptureSettings,
  GraphqlSettings,
  HmacSettings,
  GatewayConfig,
} from '../../config/configuration';

type RawRequest = IncomingMessage & { rawBody?: Buffer };
export class BodyCaptureError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('Request body capture failed');
  }
}
interface Capture {
  promise: Promise<Buffer>;
  release: () => void;
  lifecycle: boolean;
}

/** Shared admission prevents an earlier size/GraphQL reader bypassing signed
 * byte limits. Each request owns one capture and holds capacity through response. */
@Injectable()
export class RequestBodyService {
  private readonly captures = new WeakMap<IncomingMessage, Capture>();
  private pending = 0;
  private hmacPending = 0;
  private graphqlPending = 0;
  private readonly body: BodyCaptureSettings;
  private readonly hmac: HmacSettings;
  private readonly graphql: GraphqlSettings;
  constructor(config: ConfigService<GatewayConfig, true>) {
    this.body = {
      ...DEFAULT_BODY_CAPTURE,
      ...config.get('bodyCapture', { infer: true }),
    };
    this.hmac = { ...DEFAULT_HMAC, ...config.get('hmac', { infer: true }) };
    this.graphql = {
      ...DEFAULT_GRAPHQL,
      ...config.get('graphql', { infer: true }),
    };
  }

  async read(ctx: PluginContext): Promise<Buffer> {
    const existing = this.captures.get(ctx.req);
    if (existing) return existing.promise;
    const hmac = !!ctx.route.plugins?.some((p) => p.name === 'hmac-auth');
    const graphql =
      ctx.route.graphql != null ||
      !!ctx.route.plugins?.some((p) => p.name === 'graphql-guard');
    const requested = ctx.route.plugins?.find(
      (p) => p.name === 'request-size-limit',
    )?.config.maxBodyBytes;
    if (
      requested !== undefined &&
      (typeof requested !== 'number' ||
        !Number.isSafeInteger(requested) ||
        requested < 0)
    )
      throw new BodyCaptureError(500, 'BODY_CAPTURE_CONFIG_INVALID');
    const bytes = Math.min(
      this.body.maxBodyBytes,
      typeof requested === 'number' ? requested : Infinity,
      hmac ? this.hmac.maxBodyBytes : Infinity,
      graphql ? this.graphql.maxBodyBytes : Infinity,
    );
    const timeout = Math.min(
      this.body.timeoutMs,
      hmac ? this.hmac.bodyTimeoutMs : Infinity,
      graphql ? this.graphql.bodyTimeoutMs : Infinity,
    );
    if (
      this.pending >= this.body.maxPendingRequests ||
      (hmac && this.hmacPending >= this.hmac.maxPendingRequests) ||
      (graphql && this.graphqlPending >= this.graphql.maxPendingRequests)
    )
      throw new BodyCaptureError(
        503,
        hmac ? 'HMAC_CAPACITY_EXCEEDED' : 'BODY_CAPTURE_CAPACITY_EXCEEDED',
      );
    this.pending++;
    if (hmac) this.hmacPending++;
    if (graphql) this.graphqlPending++;
    let released = false;
    const lifecycle = typeof ctx.res.once === 'function';
    const release = () => {
      if (released) return;
      released = true;
      this.pending--;
      if (hmac) this.hmacPending--;
      if (graphql) this.graphqlPending--;
      this.captures.delete(ctx.req);
      if (lifecycle) {
        ctx.res.off('finish', release);
        ctx.res.off('close', release);
      }
      ctx.signal?.removeEventListener('abort', release);
    };
    if (lifecycle) {
      ctx.res.once('finish', release);
      ctx.res.once('close', release);
    }
    ctx.signal?.addEventListener('abort', release, { once: true });
    const promise = this.capture(
      ctx.req as RawRequest,
      bytes,
      timeout,
      ctx.signal,
      hmac,
    )
      .then((body) => {
        if (released || ctx.signal?.aborted)
          throw new BodyCaptureError(400, 'BODY_CAPTURE_ABORTED');
        return body;
      })
      .catch((error: unknown) => {
        release();
        throw error;
      });
    this.captures.set(ctx.req, { promise, release, lifecycle });
    return promise;
  }

  /** Tests/direct invocation without an HTTP response must explicitly release. */
  releaseDetached(ctx: PluginContext): void {
    const capture = this.captures.get(ctx.req);
    if (capture && !capture.lifecycle) capture.release();
  }

  private capture(
    req: RawRequest,
    limit: number,
    timeout: number,
    signal: AbortSignal | undefined,
    hmac: boolean,
  ): Promise<Buffer> {
    const length = req.headers['content-length'];
    if (
      length !== undefined &&
      (!/^[0-9]+$/.test(length) || Number(length) > limit)
    )
      return Promise.reject(new BodyCaptureError(413, 'REQUEST_TOO_LARGE'));
    if (req.aborted || signal?.aborted)
      return Promise.reject(new BodyCaptureError(400, 'BODY_CAPTURE_ABORTED'));
    if (req.rawBody !== undefined)
      return Buffer.isBuffer(req.rawBody) && req.rawBody.length <= limit
        ? Promise.resolve(req.rawBody)
        : Promise.reject(new BodyCaptureError(413, 'REQUEST_TOO_LARGE'));
    if (req.readableEnded || req.destroyed)
      return Promise.reject(
        new BodyCaptureError(400, 'BODY_CAPTURE_UNAVAILABLE'),
      );
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = () => {
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAbort);
        req.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (status: number, code: string) => {
        req.pause();
        cleanup();
        reject(new BodyCaptureError(status, code));
      };
      const onError = () => fail(400, 'BODY_CAPTURE_READ_ERROR');
      const onAbort = () => fail(400, 'BODY_CAPTURE_ABORTED');
      const onClose = () => {
        if (!req.readableEnded) onAbort();
      };
      const onData = (chunk: Buffer) => {
        if (!Buffer.isBuffer(chunk)) return onError();
        bytes += chunk.length;
        if (bytes > limit) return fail(413, 'REQUEST_TOO_LARGE');
        chunks.push(chunk);
      };
      const onEnd = () => {
        cleanup();
        req.rawBody = Buffer.concat(chunks, bytes);
        resolve(req.rawBody);
      };
      const timer = setTimeout(
        () => fail(408, hmac ? 'HMAC_BODY_TIMEOUT' : 'BODY_CAPTURE_TIMEOUT'),
        timeout,
      );
      timer.unref();
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAbort);
      req.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
