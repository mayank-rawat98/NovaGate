import { HttpException, HttpStatus } from '@nestjs/common';

export type GatewayErrorCode =
  | 'BALANCER_CAPACITY_EXCEEDED'
  | 'BALANCER_CONFIG_INVALID'
  | 'PLUGIN_CONFIG_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'RATE_LIMIT_EXCEEDED'
  | 'DOWNSTREAM_TIMEOUT'
  | 'DOWNSTREAM_ERROR'
  | 'NO_HEALTHY_TARGETS'
  | 'SERVICE_NOT_FOUND'
  | 'IP_RESTRICTED'
  | 'REQUEST_TOO_LARGE';

export class GatewayError extends HttpException {
  readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string, status: HttpStatus) {
    super({ code, message }, status);
    this.code = code;
  }
}
