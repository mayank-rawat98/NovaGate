/** Internal receipt schedules and durable outbox; public activation remains separate. */
export const EXPORT_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.log_export_delivery_schedules (
  destination_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  revision UUID NOT NULL,
  enabled BOOLEAN NOT NULL,
  cadence VARCHAR NOT NULL CHECK (cadence IN ('near_real_time','hourly')),
  filter JSONB NOT NULL,
  payload_privacy JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  cursor_at TIMESTAMPTZ NOT NULL,
  cursor_id UUID,
  next_due_at TIMESTAMPTZ NOT NULL,
  last_checked_at TIMESTAMPTZ,
  last_delivery_checked_at TIMESTAMPTZ,
  admitted_records BIGINT NOT NULL DEFAULT 0,
  filtered_records BIGINT NOT NULL DEFAULT 0,
  invalid_records BIGINT NOT NULL DEFAULT 0,
  retention_skipped_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  error VARCHAR(40),
  FOREIGN KEY (tenant_id,destination_id) REFERENCES public.log_export_destinations(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS log_export_delivery_schedule_due ON public.log_export_delivery_schedules (last_checked_at NULLS FIRST,next_due_at,destination_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS log_export_delivery_schedule_dispatch ON public.log_export_delivery_schedules (last_delivery_checked_at NULLS FIRST,destination_id);
CREATE TABLE IF NOT EXISTS public.log_export_deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  destination_id UUID NOT NULL REFERENCES public.log_export_destinations(id),
  destination_revision UUID NOT NULL,
  privacy_revision UUID NOT NULL,
  retention_revision UUID NOT NULL,
  source_ids UUID[] NOT NULL CHECK (cardinality(source_ids) BETWEEN 1 AND 256),
  payload_privacy JSONB NOT NULL,
  receipt_from TIMESTAMPTZ NOT NULL,
  payload JSONB CHECK (octet_length(payload::text)<=2097152),
  record_count SMALLINT NOT NULL CHECK (record_count BETWEEN 1 AND 256),
  status VARCHAR NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','delivered','failed','expired')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error VARCHAR(40),
  CHECK ((status IN ('queued','processing') AND payload IS NOT NULL) OR
         (status IN ('delivered','failed','expired') AND payload IS NULL)),
  CHECK ((status='processing' AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR
         (status<>'processing' AND lease_id IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS log_export_delivery_history ON public.log_export_deliveries (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS log_export_delivery_due ON public.log_export_deliveries (tenant_id,destination_id,next_attempt_at,created_at,id) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_delivery_destination ON public.log_export_deliveries (destination_id) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_delivery_expiry ON public.log_export_deliveries (expires_at,id) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS log_export_delivery_cleanup ON public.log_export_deliveries (completed_at,id) WHERE status IN ('delivered','failed','expired');
ALTER TABLE public.log_export_deliveries ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.log_export_delivery_schedules(destination_id) ON DELETE SET NULL;
ALTER TABLE public.log_export_deliveries ADD COLUMN IF NOT EXISTS is_scheduled BOOLEAN NOT NULL DEFAULT false;
UPDATE public.log_export_deliveries SET is_scheduled=true WHERE schedule_id IS NOT NULL AND NOT is_scheduled;
DROP INDEX IF EXISTS public.log_export_scheduled_history;
CREATE INDEX IF NOT EXISTS log_export_scheduled_terminal_history ON public.log_export_deliveries (tenant_id,completed_at DESC,id DESC)
  WHERE is_scheduled AND status IN ('delivered','failed','expired');
CREATE TABLE IF NOT EXISTS public.log_export_delivery_history_totals (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  delivered_batches BIGINT NOT NULL DEFAULT 0 CHECK (delivered_batches>=0),
  failed_batches BIGINT NOT NULL DEFAULT 0 CHECK (failed_batches>=0),
  expired_batches BIGINT NOT NULL DEFAULT 0 CHECK (expired_batches>=0),
  delivered_records BIGINT NOT NULL DEFAULT 0 CHECK (delivered_records>=0),
  failed_records BIGINT NOT NULL DEFAULT 0 CHECK (failed_records>=0),
  expired_records BIGINT NOT NULL DEFAULT 0 CHECK (expired_records>=0),
  last_pruned_at TIMESTAMPTZ NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.log_export_deliveries'::regclass AND conname='log_export_delivery_owner') THEN
    ALTER TABLE public.log_export_deliveries ADD CONSTRAINT log_export_delivery_owner FOREIGN KEY (tenant_id,destination_id) REFERENCES public.log_export_destinations(tenant_id,id);
  END IF;
END $$;
`;

/** Append after a removed CTE. Deletion and nonsecret coverage commit atomically.
 * Unscheduled caller identities keep their existing independent lifetime/cap. */
export const RECORD_PRUNED_SCHEDULED_HISTORY_SQL = `
INSERT INTO public.log_export_delivery_history_totals
  (tenant_id,delivered_batches,failed_batches,expired_batches,delivered_records,failed_records,expired_records,last_pruned_at)
SELECT tenant_id,COUNT(*) FILTER (WHERE status='delivered'),COUNT(*) FILTER (WHERE status='failed'),COUNT(*) FILTER (WHERE status='expired'),
  COALESCE(SUM(record_count) FILTER (WHERE status='delivered'),0),COALESCE(SUM(record_count) FILTER (WHERE status='failed'),0),
  COALESCE(SUM(record_count) FILTER (WHERE status='expired'),0),clock_timestamp()
FROM removed WHERE is_scheduled GROUP BY tenant_id
ON CONFLICT (tenant_id) DO UPDATE SET
  delivered_batches=log_export_delivery_history_totals.delivered_batches+EXCLUDED.delivered_batches,
  failed_batches=log_export_delivery_history_totals.failed_batches+EXCLUDED.failed_batches,
  expired_batches=log_export_delivery_history_totals.expired_batches+EXCLUDED.expired_batches,
  delivered_records=log_export_delivery_history_totals.delivered_records+EXCLUDED.delivered_records,
  failed_records=log_export_delivery_history_totals.failed_records+EXCLUDED.failed_records,
  expired_records=log_export_delivery_history_totals.expired_records+EXCLUDED.expired_records,
  last_pruned_at=EXCLUDED.last_pruned_at`;

/** Call within the same transaction as a revision change, before reporting success. */
export const REVOKE_TENANT_DELIVERIES_SQL = `UPDATE public.log_export_deliveries
SET status='expired',payload=NULL,lease_id=NULL,lease_until=NULL,
    completed_at=clock_timestamp(),error='policy_changed'
WHERE tenant_id=$1 AND status IN ('queued','processing')`;
export const REVOKE_DESTINATION_DELIVERIES_SQL = `UPDATE public.log_export_deliveries
SET status='expired',payload=NULL,lease_id=NULL,lease_until=NULL,
    completed_at=clock_timestamp(),error='destination_changed'
WHERE tenant_id=$1 AND destination_id=$2 AND status IN ('queued','processing')`;
