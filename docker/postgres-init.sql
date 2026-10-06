-- Canonical initial public schema. Existing installations are upgraded by
-- admin-api's MigrationService; never synchronize application entities in production.
CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL,
  email VARCHAR NOT NULL UNIQUE,
  "planId" VARCHAR NOT NULL,
  "gatewayConfigVersion" INTEGER NOT NULL DEFAULT 0,
  "passwordHash" VARCHAR,
  "lastSeen" TIMESTAMP,
  "resetPasswordToken" VARCHAR,
  "resetPasswordExpires" TIMESTAMP,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "verifyToken" VARCHAR,
  "verifyExpires" TIMESTAMP,
  "caCertPem" TEXT,
  "logPrivacy" JSONB NOT NULL DEFAULT '{"clientIp":"omit","userAgent":"omit"}'::jsonb,
  "logPrivacyRevision" UUID NOT NULL DEFAULT gen_random_uuid(),
  "logPrivacyScrubCursor" UUID,
  "logPrivacyScrubDone" BOOLEAN NOT NULL DEFAULT false,
  "logPrivacyScrubError" BOOLEAN NOT NULL DEFAULT false,
  "logPrivacyScrubCheckedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id),
  "keyHash" VARCHAR NOT NULL,
  label VARCHAR NOT NULL,
  "revokedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_keys_active_hash ON public.api_keys ("keyHash") WHERE "revokedAt" IS NULL;

CREATE TABLE IF NOT EXISTS public.pending_config_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES public.tenants(id),
  config JSONB NOT NULL,
  "lastPublishAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS public.log_export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  status VARCHAR NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','expired')),
  filter JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  object_key TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  cleanup_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS log_export_jobs_tenant ON public.log_export_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS log_export_jobs_queue ON public.log_export_jobs (created_at) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_jobs_expiry ON public.log_export_jobs (expires_at, cleanup_at);
