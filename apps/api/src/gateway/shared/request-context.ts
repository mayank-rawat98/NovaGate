import type { Request, Response } from 'express';

export interface AuthenticatedUser {
  id: string;
  /** Captured registered consumer attribution at authentication time. */
  consumerId?: string;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

export interface ResponseWithLocals extends Response {
  locals: {
    trace?: GatewayTraceHandle;
    errorCode?: string;
    requestId?: string;
    requestStart?: number;
    routePattern?: string;
    downstreamService?: string;
    downstreamLatencyMs?: number;
  };
}

export interface GatewayTraceHandle {
  traceId: string;
  spanId: string;
  headers(): Record<string, string>;
  set(attributes: Record<string, string | number | boolean | undefined>): void;
  end(statusCode?: number): void;
  child(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): GatewayTraceHandle;
}
