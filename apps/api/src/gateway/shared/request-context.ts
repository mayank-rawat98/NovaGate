import type { Request, Response } from 'express';

export interface AuthenticatedUser {
  id: string;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

export interface ResponseWithLocals extends Response {
  locals: {
    requestId?: string;
    requestStart?: number;
    downstreamService?: string;
    downstreamLatencyMs?: number;
  };
}
