import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
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

@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestIdHeader = request.headers['x-request-id'];
    const requestId =
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ??
      uuidv4();
    response.setHeader('X-Request-ID', requestId);

    if (exception instanceof GatewayError) {
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
          ? (responseBody as { message?: string }).message ?? exception.message
          : exception.message;
      const code = statusToCode[status] ?? 'DOWNSTREAM_ERROR';
      response.status(status).json({
        error: code,
        message,
        requestId,
      });
      return;
    }

    response.status(HttpStatus.BAD_GATEWAY).json({
      error: 'DOWNSTREAM_ERROR',
      message: 'Downstream service error',
      requestId,
    });
  }
}
