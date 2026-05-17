import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

interface HmacAuthConfig {
  header: string;
  algorithm: 'sha256' | 'sha512';
  secrets: string[];
  maxClockSkewSeconds?: number;
  timestampHeader?: string;
}

const DEFAULT_CLOCK_SKEW = 300;

@Injectable()
export class HmacAuthPlugin implements GatewayPlugin {
  readonly name = 'hmac-auth';

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === 'hmac-auth');
    if (!entry) return;

    const config = entry.config as unknown as HmacAuthConfig;
    const req = ctx.req as IncomingMessage & { rawBody?: Buffer };

    const sigHeader = req.headers[config.header.toLowerCase()];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!sig) {
      return this.unauthorized(
        ctx.requestId,
        'HMAC_SIGNATURE_MISSING',
        `Missing ${config.header} header`,
      );
    }

    // Clock skew check if a timestamp header is configured
    if (config.timestampHeader) {
      const tsHeader = req.headers[config.timestampHeader.toLowerCase()];
      const tsStr = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
      if (tsStr) {
        const ts = parseInt(tsStr, 10);
        const skew = config.maxClockSkewSeconds ?? DEFAULT_CLOCK_SKEW;
        if (!isNaN(ts) && Math.abs(Math.floor(Date.now() / 1000) - ts) > skew) {
          return this.unauthorized(
            ctx.requestId,
            'HMAC_CLOCK_SKEW',
            'Request timestamp is too old or too far in the future',
          );
        }
      }
    }

    // Collect raw body — either from req.rawBody (set by body capture middleware) or stream
    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch {
      return this.unauthorized(
        ctx.requestId,
        'HMAC_BODY_READ_ERROR',
        'Failed to read request body',
      );
    }

    const algorithm = config.algorithm === 'sha512' ? 'sha512' : 'sha256';
    const prefix = algorithm === 'sha512' ? 'sha512=' : 'sha256=';
    const sigValue = sig.startsWith(prefix) ? sig.slice(prefix.length) : sig;

    const valid = config.secrets.some((secret) => {
      try {
        const expected = crypto
          .createHmac(algorithm, secret)
          .update(body)
          .digest('hex');
        const expectedBuf = Buffer.from(expected, 'hex');
        const actualBuf = Buffer.from(sigValue, 'hex');
        if (expectedBuf.length !== actualBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, actualBuf);
      } catch {
        return false;
      }
    });

    if (!valid) {
      return this.unauthorized(
        ctx.requestId,
        'HMAC_SIGNATURE_INVALID',
        'HMAC signature verification failed',
      );
    }
  }

  private readBody(
    req: IncomingMessage & { rawBody?: Buffer },
  ): Promise<Buffer> {
    if (req.rawBody) return Promise.resolve(req.rawBody);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        // Cache on req so ProxyMiddleware can forward it without re-reading
        (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
        resolve(buf);
      });
      req.on('error', reject);
    });
  }

  private unauthorized(
    requestId: string,
    code: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: code, message, requestId }),
    };
  }
}
