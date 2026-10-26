// Used by startup upgrades as well as a fresh public schema.
export const LOG_EXPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.log_export_schedules (
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id),
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  enabled BOOLEAN NOT NULL,
  cadence VARCHAR NOT NULL CHECK (cadence IN ('near_real_time','hourly')),
  filter JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  cursor_at TIMESTAMPTZ NOT NULL,
  next_due_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_checked_at TIMESTAMPTZ,
  last_job_id UUID,
  error TEXT
);
CREATE INDEX IF NOT EXISTS log_export_schedules_due ON public.log_export_schedules (next_due_at, tenant_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS log_export_schedules_fair ON public.log_export_schedules (last_checked_at NULLS FIRST, next_due_at, tenant_id) WHERE enabled;
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
ALTER TABLE public.log_export_jobs
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','scheduled')),
  ADD COLUMN IF NOT EXISTS time_basis VARCHAR NOT NULL DEFAULT 'request' CHECK (time_basis IN ('request','receipt')),
  ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.log_export_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS window_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_to TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS log_export_scheduled_window ON public.log_export_jobs (schedule_id, window_from, window_to) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS log_export_jobs_tenant ON public.log_export_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS log_export_jobs_queue ON public.log_export_jobs (created_at) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_jobs_pending_tenant ON public.log_export_jobs (tenant_id) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_jobs_failed_schedule ON public.log_export_jobs (tenant_id, schedule_id) WHERE status='failed';
CREATE INDEX IF NOT EXISTS log_export_jobs_expiry ON public.log_export_jobs (expires_at, cleanup_at);
`;
