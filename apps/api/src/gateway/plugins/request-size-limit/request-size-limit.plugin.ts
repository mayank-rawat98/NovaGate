import { Injectable } from '@nestjs/common';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import {
  BodyCaptureError,
  RequestBodyService,
} from '../../shared/request-body.service';

@Injectable()
export class RequestSizeLimitPlugin implements GatewayPlugin {
  readonly name = 'request-size-limit';
  constructor(private readonly bodies: RequestBodyService) {}
  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    if (!ctx.route.plugins?.some((p) => p.name === this.name)) return;
    try {
      await this.bodies.read(ctx);
    } catch (error) {
      const failure =
        error instanceof BodyCaptureError
          ? error
          : new BodyCaptureError(400, 'BODY_CAPTURE_READ_ERROR');
      return {
        status: failure.status,
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({
          error: failure.code,
          message:
            failure.status === 413
              ? 'Request body exceeds the configured size limit'
              : 'Request body could not be read within gateway limits',
          requestId: ctx.requestId,
        }),
      };
    } finally {
      this.bodies.releaseDetached(ctx);
    }
  }
}
