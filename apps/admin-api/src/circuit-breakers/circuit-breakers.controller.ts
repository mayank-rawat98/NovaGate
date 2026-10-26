import { Controller, Get, Header, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { CircuitBreakersService } from './circuit-breakers.service';

@Controller('tenants/:tenantId/circuit-breakers')
export class CircuitBreakersController {
  constructor(private readonly circuits: CircuitBreakersService) {}

  @AutomationScope('services:read')
  @Get()
  @Header('Cache-Control', 'no-store')
  snapshot(@Param('tenantId') tenantId: string) {
    return this.circuits.snapshot(tenantId);
  }

  @AutomationScope('services:read')
  @Get('stream')
  stream(
    @Param('tenantId') tenantId: string,
    @Req() request: Request & { sessionExpiresAt?: number },
    @Res() response: Response,
  ) {
    return this.circuits.open(tenantId, response, request.sessionExpiresAt);
  }
}
