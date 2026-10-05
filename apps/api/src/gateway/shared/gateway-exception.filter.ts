import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GatewayError, GatewayErrorCode } from './gateway-error';
import { v4 as uuidv4 } from 'uuid';

const statusToCode: Record<number, GatewayErrorCode> = {
  [HttpStatus.UNAUTHORIZED]: 'TOKEN_INVALID',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMIT_EXCEEDED',
  [HttpStatus.GATEWAY_TIMEOUT]: 'DOWNSTREAM_TIMEOUT',
  [HttpStatus.BAD_GATEWAY]: 'DOWNSTREAM_ERROR',
  [HttpStatus.NOT_FOUND]: 'SERVICE_NOT_FOUND',
};

import { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';
import { ErrorEvent } from '@api-gateway/shared-types';

@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GatewayExceptionFilter.name);

  constructor(private readonly telemetryService: GatewayTelemetryService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestIdHeader = request.headers['x-request-id'];
    const requestId =
      response.locals?.requestId ??
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ??
      uuidv4();
    response.setHeader('X-Request-ID', requestId);

    const errorEvent: ErrorEvent = {
      id: crypto.randomUUID(),
      requestId,
      errorCode: 'DOWNSTREAM_ERROR', // default
      message: 'Unknown error',
      timestamp: new Date().toISOString(),
      path: response.locals?.routePattern ?? 'unmatched',
    };

    if (exception instanceof GatewayError) {
      errorEvent.errorCode = exception.code;
      errorEvent.message = exception.message;
      errorEvent.statusCode = exception.getStatus();

      response.locals.errorCode = errorEvent.errorCode;
      this.telemetryService.sendError(errorEvent);

      response.status(exception.getStatus()).json({
        error: exception.code,
        message: exception.message,
        requestId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const message =
        typeof responseBody === 'object' && responseBody !== null
          ? ((responseBody as { message?: string }).message ??
            exception.message)
          : exception.message;
      const code = statusToCode[status] ?? 'DOWNSTREAM_ERROR';

      errorEvent.errorCode = code;
      errorEvent.message = message;
      errorEvent.statusCode = status;
      response.locals.errorCode = errorEvent.errorCode;
      this.telemetryService.sendError(errorEvent);

      response.status(status).json({
        error: code,
        message,
        requestId,
      });
      return;
    }

    this.logger.error(
      JSON.stringify({
        msg: 'Unhandled proxy exception',
        error:
          exception instanceof Error ? exception.message : String(exception),
        stack:
          exception instanceof Error
            ? exception.stack?.split('\n')[1]?.trim()
            : undefined,
        path: response.locals?.routePattern ?? 'unmatched',
        requestId,
      }),
    );
    response.locals.errorCode = errorEvent.errorCode;
    this.telemetryService.sendError(errorEvent);
    response.status(HttpStatus.BAD_GATEWAY).json({
      error: 'DOWNSTREAM_ERROR',
      message: 'Downstream service error',
      requestId,
    });
  }
}
