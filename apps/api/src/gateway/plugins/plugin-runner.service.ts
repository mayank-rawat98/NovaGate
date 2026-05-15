import { Injectable, Logger } from '@nestjs/common';
import type { OutgoingHttpHeaders } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

@Injectable()
export class PluginRunnerService {
  private readonly logger = new Logger(PluginRunnerService.name);

  async runOnRequest(
    plugins: GatewayPlugin[],
    ctx: PluginContext,
  ): Promise<PluginShortCircuit | void> {
    for (const plugin of plugins) {
      if (!plugin.onRequest) continue;
      try {
        const result = await plugin.onRequest(ctx);
        if (result) return result;
      } catch (err) {
        this.logger.error(
          JSON.stringify({
            msg: `Plugin ${plugin.name} onRequest threw`,
            error: (err as Error).message,
          }),
        );
        return {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'PLUGIN_ERROR',
            message: 'Internal plugin error',
            requestId: ctx.requestId,
          }),
        };
      }
    }
  }

  async runOnResponse(
    plugins: GatewayPlugin[],
    ctx: PluginContext & { statusCode: number; headers: OutgoingHttpHeaders },
  ): Promise<void> {
    for (const plugin of plugins) {
      if (!plugin.onResponse) continue;
      try {
        await plugin.onResponse(ctx);
      } catch (err) {
        // Log but never rethrow — response stream is already in progress
        this.logger.error(
          JSON.stringify({
            msg: `Plugin ${plugin.name} onResponse threw`,
            error: (err as Error).message,
          }),
        );
      }
    }
  }

  async runOnError(
    plugins: GatewayPlugin[],
    ctx: PluginContext & { error: Error },
  ): Promise<PluginShortCircuit | void> {
    for (const plugin of plugins) {
      if (!plugin.onError) continue;
      try {
        const result = await plugin.onError(ctx);
        if (result) return result;
      } catch (err) {
        this.logger.error(
          JSON.stringify({
            msg: `Plugin ${plugin.name} onError threw`,
            error: (err as Error).message,
          }),
        );
      }
    }
  }
}
