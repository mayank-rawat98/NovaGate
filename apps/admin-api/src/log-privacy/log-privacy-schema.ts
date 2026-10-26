// Shared upgrade SQL; defaults also appear in the canonical fresh public schema.
export const LOG_PRIVACY_SCHEMA = `
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS "logPrivacy" JSONB NOT NULL DEFAULT '{"clientIp":"omit","userAgent":"omit"}'::jsonb,
  ADD COLUMN IF NOT EXISTS "logPrivacyRevision" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "logPrivacyScrubCursor" UUID,
  ADD COLUMN IF NOT EXISTS "logPrivacyScrubDone" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "logPrivacyScrubError" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "logPrivacyScrubCheckedAt" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS tenants_log_privacy_scrub ON public.tenants ("logPrivacyScrubCheckedAt" NULLS FIRST,id) WHERE NOT "logPrivacyScrubDone";
ALTER TABLE public.pending_config_updates ADD COLUMN IF NOT EXISTS "lastPublishAt" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS pending_config_retry ON public.pending_config_updates ("lastPublishAt" NULLS FIRST);
ALTER TABLE public.log_export_jobs
  ADD COLUMN IF NOT EXISTS privacy_policy JSONB NOT NULL DEFAULT '{"clientIp":"omit","userAgent":"omit"}'::jsonb,
  ADD COLUMN IF NOT EXISTS privacy_revision UUID;
-- Old archives have no proven privacy snapshot: revoke once, then use normal private cleanup.
UPDATE public.log_export_jobs SET status='expired',expires_at=clock_timestamp(),lease_id=NULL,lease_until=NULL,cleanup_at=NULL,error='Privacy policy changed. Create a new archive.'
WHERE privacy_revision IS NULL AND status <> 'expired';
`;
