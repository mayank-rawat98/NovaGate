import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type { GatewayPlugin, PluginContext } from '@api-gateway/shared-types';

interface RequestTransformConfig {
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  renameHeaders?: Record<string, string>;
  addQueryParams?: Record<string, string>;
  removeQueryParams?: string[];
}

@Injectable()
export class RequestTransformPlugin implements GatewayPlugin {
  readonly name = 'request-transform';

  async onRequest(ctx: PluginContext): Promise<void> {
    const entry = ctx.route.plugins?.find(
      (p) => p.name === 'request-transform',
    );
    if (!entry) return;

    const config = entry.config as unknown as RequestTransformConfig;
    const req = ctx.req as IncomingMessage & { url?: string };

    if (config.removeHeaders) {
      for (const header of config.removeHeaders) {
        delete req.headers[header.toLowerCase()];
      }
    }

    if (config.renameHeaders) {
      for (const [from, to] of Object.entries(config.renameHeaders)) {
        const key = from.toLowerCase();
        if (req.headers[key] !== undefined) {
          req.headers[to.toLowerCase()] = req.headers[key];
          delete req.headers[key];
        }
      }
    }

    if (config.addHeaders) {
      for (const [header, value] of Object.entries(config.addHeaders)) {
        req.headers[header.toLowerCase()] = value;
      }
    }

    if (config.addQueryParams || config.removeQueryParams) {
      const url = req.url ?? '/';
      const sepIdx = url.indexOf('?');
      const basePath = sepIdx >= 0 ? url.slice(0, sepIdx) : url;
      const params = new URLSearchParams(
        sepIdx >= 0 ? url.slice(sepIdx + 1) : '',
      );

      for (const key of config.removeQueryParams ?? []) {
        params.delete(key);
      }
      for (const [key, value] of Object.entries(config.addQueryParams ?? {})) {
        params.set(key, value);
      }

      const qs = params.toString();
      req.url = qs ? `${basePath}?${qs}` : basePath;
    }
  }
}
