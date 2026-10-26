/** Operator billing configuration, validated at startup. */
export interface BillingSettings {
  /** Enforce plan limits: workspace suspension and creation caps. */
  quotasEnabled: boolean;
  stripe: {
    secretKey: string;
    webhookSecret: string;
    apiBase: string;
    /** Plan ID → Stripe price ID. */
    prices: Record<string, string>;
  } | null;
  /** Dashboard origin for checkout return links. */
  dashboardUrl: string;
}

const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{1,200}$/;

export function billingSettings(env: Record<string, unknown>): BillingSettings {
  const flag = env.BILLING_QUOTAS_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false')
    throw new Error('BILLING_QUOTAS_ENABLED must be true or false');
  const dashboardUrl = String(env.DASHBOARD_URL ?? 'http://localhost:3003');
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  let stripe: BillingSettings['stripe'] = null;
  if (secretKey || webhookSecret || env.STRIPE_PRICES) {
    let prices: unknown;
    try {
      prices = JSON.parse(String(env.STRIPE_PRICES ?? '{}'));
    } catch {
      prices = null;
    }
    const apiBase = String(env.STRIPE_API_BASE ?? 'https://api.stripe.com');
    let base: URL;
    try {
      base = new URL(apiBase);
    } catch {
      throw new Error('STRIPE_API_BASE must be a URL');
    }
    if (
      typeof secretKey !== 'string' ||
      !/^(sk|rk)_[A-Za-z0-9_]{8,}$/.test(secretKey) ||
      typeof webhookSecret !== 'string' ||
      !/^whsec_[A-Za-z0-9+/=]{8,}$/.test(webhookSecret) ||
      !prices ||
      typeof prices !== 'object' ||
      Array.isArray(prices) ||
      !Object.entries(prices).every(
        ([plan, price]) =>
          PLAN_ID.test(plan) &&
          typeof price === 'string' &&
          PRICE_ID.test(price),
      ) ||
      new Set(Object.values(prices)).size !== Object.keys(prices).length ||
      base.username ||
      base.password ||
      (base.protocol !== 'https:' &&
        !['127.0.0.1', 'localhost'].includes(base.hostname))
    )
      throw new Error(
        'Stripe billing needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICES ({"planId":"price_..."}); STRIPE_API_BASE must be HTTPS',
      );
    stripe = {
      secretKey,
      webhookSecret,
      apiBase: base.origin,
      prices: prices as Record<string, string>,
    };
  }
  return { quotasEnabled: flag === 'true', stripe, dashboardUrl };
}
