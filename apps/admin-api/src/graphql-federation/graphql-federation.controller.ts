import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { GraphqlFederationService } from './graphql-federation.service';

@Controller('tenants/:tenantId/graphql-federation')
export class GraphqlFederationController {
  constructor(private readonly federation: GraphqlFederationService) {}

  @Get('graphs')
  @AutomationScope('routes:read')
  @Header('Cache-Control', 'no-store')
  list(@Param('tenantId') tenantId: string) {
    return this.federation.list(tenantId);
  }

  @Get('graphs/:name')
  @AutomationScope('routes:read')
  @Header('Cache-Control', 'no-store')
  get(@Param('tenantId') tenantId: string, @Param('name') name: string) {
    return this.federation.get(tenantId, name);
  }

  /** Dry run for editors and CI: composes without saving. */
  @Post('compose')
  @HttpCode(200)
  @AutomationScope('routes:read')
  compose(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.federation.compose(tenantId, body);
  }

  @Put('graphs/:name')
  @AutomationScope('routes:write')
  save(
    @Param('tenantId') tenantId: string,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    return this.federation.save(tenantId, name, body);
  }

  @Delete('graphs/:name')
  @AutomationScope('routes:write')
  remove(@Param('tenantId') tenantId: string, @Param('name') name: string) {
    return this.federation.remove(tenantId, name);
  }
}
