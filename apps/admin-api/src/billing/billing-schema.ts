import { MAX_CONSUMER_MONTHLY_QUOTA } from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';

/**
 * Plans and usage meters. Operators edit plan rows; the seeded limits apply
 * only when BILLING_QUOTAS_ENABLED is set. Meters hold each counter source's
 * largest reported cumulative total per month.
 */
export const BILLING_PUBLIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.plans (
  id VARCHAR(64) PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name VARCHAR(100) NOT NULL,
  "requestsPerMonth" BIGINT CHECK ("requestsPerMonth" > 0),
  "consumersMax" INTEGER CHECK ("consumersMax" > 0),
  "routesMax" INTEGER CHECK ("routesMax" > 0),
  "logRetentionDays" SMALLINT NOT NULL CHECK ("logRetentionDays" BETWEEN 1 AND 90),
  "priceMonthlyCents" INTEGER CHECK ("priceMonthlyCents" >= 0),
  sort SMALLINT NOT NULL DEFAULT 0
);
INSERT INTO public.plans (id, name, "requestsPerMonth", "consumersMax", "routesMax", "logRetentionDays", "priceMonthlyCents", sort) VALUES
  ('free', 'Free', 100000, 5, 10, 30, 0, 0),
  ('pro', 'Pro', 10000000, 100, 500, 90, 4900, 1),
  ('enterprise', 'Enterprise', NULL, NULL, NULL, 90, NULL, 2)
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.usage_meters (
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  month CHAR(6) NOT NULL,
  source UUID NOT NULL,
  requests BIGINT NOT NULL CHECK (requests >= 0),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("tenantId", month, source)
);
CREATE TABLE IF NOT EXISTS public.consumer_usage_meters (
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  month CHAR(6) NOT NULL,
  source UUID NOT NULL,
  "consumerId" UUID NOT NULL,
  requests BIGINT NOT NULL CHECK (requests >= 0),
  PRIMARY KEY ("tenantId", month, source, "consumerId")
);
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS "quotaSuspendedUntil" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" VARCHAR(255);
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(100) NOT NULL,
  "processedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function billingTenantSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  return `ALTER TABLE ${schema}.consumers ADD COLUMN IF NOT EXISTS "monthlyQuota" INTEGER
    CHECK ("monthlyQuota" IS NULL OR "monthlyQuota" BETWEEN 1 AND ${MAX_CONSUMER_MONTHLY_QUOTA});`;
}
