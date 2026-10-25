import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';

@Controller('tenants/:tenantId/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly stripe: StripeService,
  ) {}

  @Get()
  @AutomationScope('workspace:read')
  @Header('Cache-Control', 'no-store')
  overview(@Param('tenantId') tenantId: string) {
    return this.billing.overview(tenantId);
  }

  @Get('consumer-quotas')
  @AutomationScope('consumers:read')
  @Header('Cache-Control', 'no-store')
  consumerQuotas(@Param('tenantId') tenantId: string) {
    return this.billing.consumerQuotas(tenantId);
  }

  /** Session-only: purchases are not delegated to automation tokens. */
  @Post('checkout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  checkout(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.stripe.checkout(tenantId, body);
  }
}

/** Stripe calls this directly; the signature is the authentication. */
@Controller('billing/stripe')
export class StripeWebhookController {
  constructor(private readonly stripe: StripeService) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>) {
    const signature = req.headers['stripe-signature'];
    return this.stripe.webhook(
      req.rawBody,
      typeof signature === 'string' ? signature : undefined,
    );
  }
}
