import { Injectable } from '@nestjs/common';
import type { OutgoingHttpHeaders } from 'http';
import type { GatewayPlugin, PluginContext } from '@api-gateway/shared-types';

interface ResponseTransformConfig {
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  statusOverride?: number;
}

@Injectable()
export class ResponseTransformPlugin implements GatewayPlugin {
  readonly name = 'response-transform';

  async onResponse(
    ctx: PluginContext & { statusCode: number; headers: OutgoingHttpHeaders },
  ): Promise<void> {
    const entry = ctx.route.plugins?.find(
      (p) => p.name === 'response-transform',
    );
    if (!entry) return;

    const config = entry.config as unknown as ResponseTransformConfig;

    for (const header of config.removeHeaders ?? []) {
      ctx.res.removeHeader(header);
    }

    for (const [header, value] of Object.entries(config.addHeaders ?? {})) {
      ctx.res.setHeader(header, value);
    }

    if (config.statusOverride !== undefined) {
      ctx.res.statusCode = config.statusOverride;
    }
  }
}
