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
    if (!limit) return;

    const req = ctx.req as IncomingMessage;
    const contentLength = parseInt(req.headers['content-length'] ?? '', 10);

    if (!isNaN(contentLength) && contentLength > limit) {
      return {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'REQUEST_TOO_LARGE',
          message: 'Request body exceeds the configured size limit',
          requestId: ctx.requestId,
        }),
      };
    }
  }

  private resolveLimit(ctx: PluginContext): number | undefined {
    const entry = ctx.route.plugins?.find(
      (p) => p.name === 'request-size-limit',
    );
    if (!entry) return undefined;
    const cfg = entry.config as unknown as RequestSizeLimitConfig;
    return typeof cfg.maxBodyBytes === 'number' ? cfg.maxBodyBytes : undefined;
  }
}
