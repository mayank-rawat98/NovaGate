import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { Controller, Get, Headers, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LogStreamService } from './log-stream.service';

@Controller('tenants/:tenantId/logs')
export class LogStreamController {
  constructor(private readonly streams: LogStreamService) {}
  @AutomationScope('logs:read')
  @Get('stream')
  open(
    @Param('tenantId') tenant: string,
    @Req() request: Request & { sessionExpiresAt?: number },
    @Res() response: Response,
    @Headers('last-event-id') cursor?: string,
  ) {
    return this.streams.open(
      tenant,
      response,
      request.sessionExpiresAt,
      cursor,
    );
  }
}
