import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigPushService } from '../config-push/config-push.service';
import { BillingService } from './billing.service';

/** Stripe's default signature tolerance. */
const SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_TIMEOUT_MS = 10000;
const MAX_ID_LENGTH = 255;

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Verifies a `Stripe-Signature` header (t=…,v1=…) over the raw body. */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header || header.length > 2048) return false;
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && /^\d{1,12}$/.test(value ?? ''))
      timestamp = Number(value);
    else if (key === 'v1' && /^[a-f0-9]{64}$/.test(value ?? ''))
      signatures.push(Buffer.from(value, 'hex'));
  }
  if (
    timestamp === undefined ||
    !signatures.length ||
    Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

const text = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/**
 * Self-service upgrades through Stripe Checkout. Stripe is optional: without
 * STRIPE_* settings, plans change only through operators. Webhooks are the
 * only source of plan changes; the checkout redirect itself changes nothing.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly db: DataSource,
    private readonly billing: BillingService,
    private readonly push: ConfigPushService,
  ) {}

  async checkout(tenantId: string, input: unknown): Promise<{ url: string }> {
    const stripe = this.billing.settings.stripe;
    if (!stripe)
      throw new ServiceUnavailableException(
        'Self-service upgrades are not configured on this installation',
      );
    const body = input as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).length !== 1 ||
      typeof body.planId !== 'string'
    )
      throw new BadRequestException('planId is required');
    const planId = body.planId;
    const price = Object.prototype.hasOwnProperty.call(stripe.prices, planId)
      ? stripe.prices[planId]
      : undefined;
    if (!price)
      throw new BadRequestException('This plan cannot be purchased online');
    const id = this.billing.id(tenantId);
    const [tenant] = await this.db.query(
      `SELECT email,"planId","stripeCustomerId" FROM public.tenants WHERE id=$1`,
      [id],
    );
    if (!tenant) throw new NotFoundException('Workspace not found');
    if (tenant.planId === planId)
      throw new BadRequestException('The workspace is already on this plan');
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      client_reference_id: id,
      'metadata[tenantId]': id,
      'metadata[planId]': planId,
      'subscription_data[metadata][tenantId]': id,
      'subscription_data[metadata][planId]': planId,
      success_url: `${this.billing.settings.dashboardUrl}/billing?checkout=success`,
      cancel_url: `${this.billing.settings.dashboardUrl}/billing?checkout=cancelled`,
    });
    if (tenant.stripeCustomerId) form.set('customer', tenant.stripeCustomerId);
    else form.set('customer_email', tenant.email);
    let session: { url?: unknown };
    try {
      const response = await fetch(`${stripe.apiBase}/v1/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stripe.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // One checkout per workspace and plan per minute.
          'idempotency-key': `checkout-${id}-${planId}-${Math.floor(Date.now() / 60000)}`,
        },
        body: form,
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Stripe answered ${response.status}`);
      session = (await response.json()) as { url?: unknown };
    } catch (error) {
      this.logger.warn(
        `Checkout session failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      );
      throw new ServiceUnavailableException(
        'Checkout is unavailable right now. Try again shortly.',
      );
    }
    let url: URL;
    try {
      url = new URL(String(session.url));
    } catch {
      throw new ServiceUnavailableException('Checkout returned no address');
    }
    if (url.protocol !== 'https:' && !stripe.apiBase.startsWith('http://'))
      throw new ServiceUnavailableException('Checkout returned no address');
    return { url: url.toString() };
  }

  /** Handles a verified webhook once per event ID. */
  async webhook(raw: Buffer | undefined, signature: string | undefined) {
    const stripe = this.billing.settings.stripe;
    if (!stripe)
      throw new NotFoundException('Stripe billing is not configured');
    if (!raw || !verifyStripeSignature(raw, signature, stripe.webhookSecret))
      throw new BadRequestException('Invalid Stripe signature');
    let event: StripeEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as StripeEvent;
    } catch {
      throw new BadRequestException('Invalid Stripe event');
    }
    if (
      !text(event?.id) ||
      !text(event.type) ||
      !event.data?.object ||
      typeof event.data.object !== 'object'
    )
      throw new BadRequestException('Invalid Stripe event');
    const payload = await this.db.transaction(async (manager) => {
      const [fresh] = await manager.query(
        `INSERT INTO public.stripe_events (id,type) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
        [event.id, event.type.slice(0, 100)],
      );
      if (!fresh) return { duplicate: true as const };
      const object = event.data.object;
      const metadata = (object.metadata ?? {}) as Record<string, unknown>;
      const tenantFor = async () => {
        const fromMetadata = text(metadata.tenantId);
        if (fromMetadata && UUID.test(fromMetadata))
          return fromMetadata.toLowerCase();
        const subscription = text(object.id);
        if (!subscription) return undefined;
        const [row] = await manager.query(
          `SELECT id FROM public.tenants WHERE "stripeSubscriptionId"=$1`,
          [subscription],
        );
        return row?.id as string | undefined;
      };
      switch (event.type) {
        case 'checkout.session.completed': {
          const tenantId = await tenantFor();
          const planId = text(metadata.planId);
          // Only purchasable plans: a failed lookup must not make Stripe retry.
          if (
            !tenantId ||
            !planId ||
            !Object.prototype.hasOwnProperty.call(stripe.prices, planId) ||
            object.status !== 'complete'
          )
            break;
          return {
            update: await this.billing.applyPlan(manager, tenantId, planId, {
              customerId: text(object.customer) ?? null,
              subscriptionId: text(object.subscription) ?? null,
            }),
          };
        }
        case 'customer.subscription.updated': {
          const tenantId = await tenantFor();
          if (!tenantId) break;
          const status = object.status;
          if (status === 'active' || status === 'trialing') {
            const items = (object.items as { data?: unknown[] } | undefined)
              ?.data;
            const price = text(
              (items?.[0] as { price?: { id?: unknown } } | undefined)?.price
                ?.id,
            );
            const planId = Object.entries(stripe.prices).find(
              ([, id]) => id === price,
            )?.[0];
            if (!planId) break;
            return {
              update: await this.billing.applyPlan(manager, tenantId, planId, {
                subscriptionId: text(object.id) ?? null,
              }),
            };
          }
          if (
            ['canceled', 'unpaid', 'incomplete_expired'].includes(
              String(status),
            )
          )
            return {
              update: await this.billing.applyPlan(manager, tenantId, 'free', {
                subscriptionId: null,
              }),
            };
          break;
        }
        case 'customer.subscription.deleted': {
          const tenantId = await tenantFor();
          if (!tenantId) break;
          return {
            update: await this.billing.applyPlan(manager, tenantId, 'free', {
              subscriptionId: null,
            }),
          };
        }
      }
      return {};
    });
    if ('update' in payload && payload.update)
      await this.push.publish(payload.update);
    return {
      received: true,
      ...('duplicate' in payload ? { duplicate: true } : {}),
    };
  }
}
