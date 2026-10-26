/**
 * Multi-region control planes (issue #121). Control planes in every region
 * record the gateways connected to them here, so the dashboard sees all
 * regions through the shared (replicated) database.
 */
export const REGION_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.gateway_instances (
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  "instanceId" UUID NOT NULL,
  name VARCHAR(64) NOT NULL,
  region VARCHAR(32),
  "connectedAt" TIMESTAMPTZ NOT NULL,
  "lastSeenAt" TIMESTAMPTZ NOT NULL,
  "disconnectedAt" TIMESTAMPTZ,
  "configVersion" BIGINT,
  PRIMARY KEY ("tenantId", "instanceId")
);
CREATE INDEX IF NOT EXISTS gateway_instances_seen ON public.gateway_instances ("lastSeenAt");
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS "preferredRegion" VARCHAR(32)
  CHECK ("preferredRegion" IS NULL OR "preferredRegion" ~ '^[a-z][a-z0-9-]{0,31}$');
`;
