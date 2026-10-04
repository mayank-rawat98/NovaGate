import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

interface RequestSizeLimitConfig {
  maxBodyBytes: number;
}

@Injectable()
export class RequestSizeLimitPlugin implements GatewayPlugin {
  readonly name = 'request-size-limit';

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const limit = this.resolveLimit(ctx);
    if (limit === undefined) return;
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Invalid body size limit');

    const req = ctx.req as IncomingMessage & { rawBody?: Buffer };
    const contentLength = parseInt(req.headers['content-length'] ?? '', 10);

    const reject = (): PluginShortCircuit => {
      return {
        status: 413,
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({
          error: 'REQUEST_TOO_LARGE',
          message: 'Request body exceeds the configured size limit',
          requestId: ctx.requestId,
        }),
      };
    };
    if (!isNaN(contentLength) && contentLength > limit) return reject();
    if (req.rawBody) return req.rawBody.length > limit ? reject() : undefined;
    if (req.readableEnded) return;

    // Buffer only up to the configured limit, so nothing from an oversized
    // chunked upload reaches the upstream. The proxy replays rawBody verbatim.
    const withinLimit = await new Promise<boolean>((resolve, rejectRead) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          req.pause();
          cleanup();
          resolve(false);
        } else chunks.push(chunk);
      };
      const onEnd = () => {
        cleanup();
        req.rawBody = Buffer.concat(chunks);
        resolve(true);
      };
      const onError = (error: Error) => {
        cleanup();
        rejectRead(error);
      };
      const onAborted = () => onError(new Error('Request aborted'));
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
    if (!withinLimit) return reject();
  }

  private resolveLimit(ctx: PluginContext): number | undefined {
    const entry = ctx.route.plugins?.find(
      (p) => p.name === 'request-size-limit',
    );
    if (!entry) return undefined;
    const cfg = entry.config as unknown as RequestSizeLimitConfig;
    if (typeof cfg.maxBodyBytes !== 'number')
      throw new Error('Invalid body size limit');
    return cfg.maxBodyBytes;
  }
}
