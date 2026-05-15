import { Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

interface CorsConfig {
  origins: string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
}

@Injectable()
export class CorsPlugin implements GatewayPlugin {
  readonly name = 'cors';

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const config = this.resolveConfig(ctx);
    if (!config) return;

    const req = ctx.req as IncomingMessage;
    const res = ctx.res as ServerResponse;
    const method = req.method?.toUpperCase() ?? 'GET';

    const originHeader = req.headers['origin'];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;

    const allowOrigin = this.resolveOrigin(
      config.origins,
      origin,
      config.credentials,
    );
    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      if (allowOrigin !== '*') {
        this.appendVary(res, 'Origin');
      }
    }

    if (config.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (method === 'OPTIONS') {
      const routeMethod = ctx.route.method.toUpperCase();
      const methods =
        config.methods ??
        (routeMethod === 'ANY'
          ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
          : [routeMethod]);

      const baseHeaders = ['Content-Type', 'Authorization', 'X-Request-ID'];
      const allowedHeaders = [...baseHeaders, ...(config.headers ?? [])];

      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', String(config.maxAge ?? 86400));

      return { status: 204, body: '' };
    }
  }

  private resolveConfig(ctx: PluginContext): CorsConfig | undefined {
    const entry = ctx.route.plugins?.find((p) => p.name === 'cors');
    return entry ? (entry.config as unknown as CorsConfig) : undefined;
  }

  private resolveOrigin(
    allowed: string[],
    origin: string | undefined,
    credentials?: boolean,
  ): string | undefined {
    if (!origin) return allowed.includes('*') && !credentials ? '*' : undefined;
    if (allowed.includes('*')) return credentials ? origin : '*';
    if (allowed.includes(origin)) return origin;
    return undefined;
  }

  private appendVary(res: ServerResponse, value: string): void {
    const existing = res.getHeader('Vary');
    if (!existing) {
      res.setHeader('Vary', value);
      return;
    }
    const current = Array.isArray(existing)
      ? existing.join(',')
      : String(existing);
    const values = current
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (!values.includes(value)) {
      values.push(value);
      res.setHeader('Vary', values.join(', '));
    }
  }
}
