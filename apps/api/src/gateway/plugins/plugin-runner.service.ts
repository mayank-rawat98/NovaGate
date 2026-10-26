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
    // Capture signed bytes under admission/deadline limits before any body-aware
    // hook can consume or reconstruct them. Policy hooks still run in saved order.
    for (const plugin of plugins) {
      if (ctx.signal?.aborted) return;
      if (!plugin.prepareRequest) continue;
      try {
        const result = await plugin.prepareRequest(ctx);
        if (result) return result;
      } catch {
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
    for (const plugin of plugins) {
      if (ctx.signal?.aborted)
        return {
          status: 503,
          body: JSON.stringify({
            error: 'ADMISSION_CANCELLED',
            message: 'Request cancelled',
            requestId: ctx.requestId,
          }),
        };
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
    for (const plugin of plugins) {
      if (!plugin.validateRequest) continue;
      try {
        const result = await plugin.validateRequest(ctx);
        if (result) return result;
      } catch {
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
      if (ctx.signal?.aborted) return;
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
