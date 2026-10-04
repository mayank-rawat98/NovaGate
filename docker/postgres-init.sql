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
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
