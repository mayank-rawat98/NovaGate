import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';

@Controller('tenants/:tenantId/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertRulesService) {}
  @Get()
  configuration(@Param('tenantId') tenantId: string) {
    return this.alerts.configuration(tenantId);
  }
  @Get('history')
  history(@Param('tenantId') tenantId: string) {
    return this.alerts.history(tenantId);
  }
  @Post('rules')
  createRule(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.alerts.createRule(tenantId, body);
  }
  @Put('rules/:id')
  updateRule(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.alerts.updateRule(tenantId, id, body);
  }
  @Delete('rules/:id')
  removeRule(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.alerts.removeRule(tenantId, id, this.deleteRevision(body));
  }
  @Post('channels')
  createChannel(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.alerts.createChannel(tenantId, body);
  }
  @Put('channels/:id')
  updateChannel(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.alerts.updateChannel(tenantId, id, body);
  }
  @Delete('channels/:id')
  removeChannel(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.alerts.removeChannel(tenantId, id, this.deleteRevision(body));
  }
  private deleteRevision(body: unknown): unknown {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, 'revision')
    )
      throw new BadRequestException(
        'Provide the current revision to delete this alert entry.',
      );
    return (body as Record<string, unknown>).revision;
  }
}
