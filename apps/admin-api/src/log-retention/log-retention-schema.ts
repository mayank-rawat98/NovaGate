export const LOG_RETENTION_SCHEMA = `
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS "logRetentionDays" SMALLINT NOT NULL DEFAULT 30 CHECK ("logRetentionDays" BETWEEN 1 AND 90),
  ADD COLUMN IF NOT EXISTS "logRetentionRevision" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "logRetentionFloor" TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp()-INTERVAL '720 hours'),
  ADD COLUMN IF NOT EXISTS "logRetentionPending" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "logRetentionError" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "logRetentionCheckedAt" TIMESTAMPTZ;
ALTER TABLE public.tenants ALTER COLUMN "logRetentionFloor" SET DEFAULT (clock_timestamp()-INTERVAL '720 hours');
CREATE INDEX IF NOT EXISTS tenants_log_retention_due ON public.tenants ("logRetentionCheckedAt" NULLS FIRST,id);
ALTER TABLE public.log_export_jobs
  ADD COLUMN IF NOT EXISTS retention_revision UUID,
  ADD COLUMN IF NOT EXISTS retention_days SMALLINT,
  ADD COLUMN IF NOT EXISTS retention_from TIMESTAMPTZ;
-- Existing archives cannot prove an age policy: revoke once through private cleanup.
UPDATE public.log_export_jobs SET status='expired',expires_at=clock_timestamp(),lease_id=NULL,lease_until=NULL,cleanup_at=NULL,error='Log retention changed. Create a new archive.'
WHERE retention_revision IS NULL AND status <> 'expired';
ALTER TABLE public.log_export_schedules ADD COLUMN IF NOT EXISTS retention_skipped_windows BIGINT NOT NULL DEFAULT 0;
`;
