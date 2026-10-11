import {
  CONSUMER_ROLLUP_CELL_LIMIT,
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  LOG_REDACTED_FIELDS,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { consumerPathRollupSchemaSql } from './consumer-path-rollup-schema';

export const CONSUMER_ROLLUP_PUBLIC_SCHEMA = `ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS "consumerRollupCheckedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "consumerRollupPending" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "consumerRollupError" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS tenants_consumer_rollup_due ON public.tenants ("consumerRollupCheckedAt" NULLS FIRST,id);
-- One durable wake-up per tenant. Ingestion holds the receipt fence and must
-- never update the tenant row that discovery locks before taking that fence.
CREATE TABLE IF NOT EXISTS public.consumer_rollup_backlog (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE
);`;

/** Admin-owned DDL. Collector INSERTs atomically aggregate only newly stored IDs. */
export function consumerRollupSchemaSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  const bounds = CONSUMER_ROLLUP_HISTOGRAM_BOUNDS;
  const supportedFields = LOG_REDACTED_FIELDS.map(
    (field) => `'${JSON.stringify(field)}'::jsonb`,
  ).join(',');
  const histogram = bounds
    .map(
      (upper, i) =>
        `COUNT(*) FILTER (WHERE "responseTimeMs">=${i ? bounds[i - 1] + 1 : 0} AND "responseTimeMs"<=${upper})::bigint`,
    )
    .join(',');
  const requestMinute = `CASE WHEN isfinite(timestamp) THEN date_bin(INTERVAL '1 minute',timestamp,TIMESTAMPTZ '2000-01-01 00:00:00+00') END`;
  const receiptMinute = `date_bin(INTERVAL '1 minute',"receivedAt",TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  return `
ALTER TABLE ${schema}.request_logs ADD COLUMN IF NOT EXISTS "usageRollupVersion" SMALLINT CHECK ("usageRollupVersion" IS NULL OR "usageRollupVersion"=1);
CREATE INDEX IF NOT EXISTS request_logs_usage_pending ON ${schema}.request_logs ("receivedAt",id) WHERE "usageRollupVersion" IS NULL;
CREATE INDEX IF NOT EXISTS request_logs_usage_pending_consumer ON ${schema}.request_logs ("consumerId",timestamp,id) WHERE "usageRollupVersion" IS NULL AND "consumerId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS request_logs_usage_consumer_receipt ON ${schema}.request_logs ("consumerId","receivedAt",timestamp,id) WHERE "usageRollupVersion"=1 AND "consumerId" IS NOT NULL;
${consumerPathRollupSchemaSql(tenantId)}
CREATE TABLE IF NOT EXISTS ${schema}.consumer_usage_rollup_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  version SMALLINT NOT NULL DEFAULT 1 CHECK(version=1),
  cells INTEGER NOT NULL DEFAULT 0 CHECK(cells BETWEEN 0 AND ${CONSUMER_ROLLUP_CELL_LIMIT}),
  processed_records BIGINT NOT NULL DEFAULT 0 CHECK(processed_records>=0),
  attributed_records BIGINT NOT NULL DEFAULT 0 CHECK(attributed_records>=0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  backfill_complete BOOLEAN NOT NULL DEFAULT false,
  capacity_blocked BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO ${schema}.consumer_usage_rollup_state (singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${schema}.consumer_usage_rollups (
  consumer_id UUID NOT NULL,
  request_minute TIMESTAMPTZ NOT NULL,
  receipt_minute TIMESTAMPTZ NOT NULL,
  first_receipt TIMESTAMPTZ NOT NULL,
  last_receipt TIMESTAMPTZ NOT NULL,
  requests BIGINT NOT NULL CHECK(requests>0),
  server_errors BIGINT NOT NULL CHECK(server_errors BETWEEN 0 AND requests),
  latency_samples BIGINT NOT NULL CHECK(latency_samples BETWEEN 0 AND requests),
  late_records BIGINT NOT NULL CHECK(late_records BETWEEN 0 AND requests),
  histogram BIGINT[] NOT NULL CHECK(cardinality(histogram)=${bounds.length}),
  PRIMARY KEY(consumer_id,request_minute,receipt_minute)
);
CREATE INDEX IF NOT EXISTS consumer_usage_rollups_receipt ON ${schema}.consumer_usage_rollups (last_receipt,consumer_id,request_minute,receipt_minute);

CREATE OR REPLACE FUNCTION ${schema}.materialize_consumer_usage(ids UUID[]) RETURNS INTEGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE capacity INTEGER; processed INTEGER; hidden BOOLEAN; cutoff TIMESTAMPTZ; policy JSONB; fields JSONB;
BEGIN
  IF cardinality(ids)>1000 THEN RAISE EXCEPTION 'Consumer rollup batch exceeds limit'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('log-receipt:${tenantId.toLowerCase()}',0));
  BEGIN
  SELECT "logPrivacy",
    GREATEST("logRetentionFloor",clock_timestamp()-make_interval(secs=>"logRetentionDays"::integer*86400))
    INTO policy,cutoff FROM public.tenants WHERE id='${tenantId.toLowerCase()}'::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consumer rollup workspace missing'; END IF;
  EXCEPTION WHEN undefined_column THEN
    -- A tenant provisioned before startup policy migrations stays pending.
    -- Admin migration/backfill will retry; do not guess legacy privacy/retention.
    RETURN 0;
  END;
  PERFORM ${schema}.materialize_consumer_paths(ids);
  -- Match shared logPrivacyPolicy: malformed explicit selections hide all
  -- metadata, while legacy policies without a selection retain attribution.
  hidden=false;
  IF jsonb_typeof(policy)='object' AND policy ? 'redactedFields' THEN
    hidden=true;
    IF policy->>'clientIp' IN ('omit','retain') AND policy->>'userAgent' IN ('omit','retain')
      AND policy-'clientIp'-'userAgent'-'redactedFields'='{}'::jsonb
      AND jsonb_typeof(policy->'redactedFields')='array' THEN
      fields=policy->'redactedFields';
      IF jsonb_array_length(fields)<=${LOG_REDACTED_FIELDS.length} THEN
        hidden=fields ? 'consumerId'
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(fields) f WHERE f NOT IN (${supportedFields}))
          OR (SELECT COUNT(DISTINCT f) FROM jsonb_array_elements(fields) f)<>jsonb_array_length(fields);
      END IF;
    END IF;
  END IF;
  SELECT ${CONSUMER_ROLLUP_CELL_LIMIT}-cells INTO capacity FROM ${schema}.consumer_usage_rollup_state WHERE singleton FOR UPDATE;
  WITH selected AS MATERIALIZED (
    SELECT id,"consumerId",${requestMinute} AS request_minute,${receiptMinute} AS receipt_minute,
      NOT hidden AND "consumerId" IS NOT NULL AND timestamp IS NOT NULL AND isfinite(timestamp) AND "receivedAt">=cutoff AS attributable
    FROM ${schema}.request_logs l WHERE id=ANY(ids) AND "usageRollupVersion" IS NULL
  ), new_keys AS MATERIALIZED (
    SELECT DISTINCT s."consumerId" AS consumer_id,s.request_minute,s.receipt_minute
    FROM selected s WHERE s.attributable AND NOT EXISTS (
      SELECT 1 FROM ${schema}.consumer_usage_rollups r WHERE (r.consumer_id,r.request_minute,r.receipt_minute)=(s."consumerId",s.request_minute,s.receipt_minute)
    ) ORDER BY 1,2,3 LIMIT capacity
  ), admitted AS MATERIALIZED (
    SELECT s.id FROM selected s WHERE NOT s.attributable OR EXISTS (
      SELECT 1 FROM ${schema}.consumer_usage_rollups r WHERE (r.consumer_id,r.request_minute,r.receipt_minute)=(s."consumerId",s.request_minute,s.receipt_minute)
    ) OR EXISTS (
      SELECT 1 FROM new_keys k WHERE (k.consumer_id,k.request_minute,k.receipt_minute)=(s."consumerId",s.request_minute,s.receipt_minute)
    )
  ), claimed AS (
    UPDATE ${schema}.request_logs l SET "usageRollupVersion"=1 FROM admitted a WHERE l.id=a.id
      RETURNING l."consumerId",l.timestamp,l."receivedAt",l."statusCode",l."responseTimeMs"
  ), aggregated AS MATERIALIZED (
    SELECT "consumerId" AS consumer_id,${requestMinute} AS request_minute,${receiptMinute} AS receipt_minute,
      MIN("receivedAt") AS first_receipt,MAX("receivedAt") AS last_receipt,COUNT(*)::bigint AS requests,
      COUNT(*) FILTER (WHERE "statusCode">=500)::bigint AS server_errors,
      COUNT(*) FILTER (WHERE "responseTimeMs">=0)::bigint AS latency_samples,
      COUNT(*) FILTER (WHERE "receivedAt">=${requestMinute}+INTERVAL '75 seconds')::bigint AS late_records,
      ARRAY[${histogram}] AS histogram
    FROM claimed WHERE NOT hidden AND "consumerId" IS NOT NULL AND timestamp IS NOT NULL AND isfinite(timestamp) AND "receivedAt">=cutoff GROUP BY 1,2,3
  ), stored AS (
    INSERT INTO ${schema}.consumer_usage_rollups AS r SELECT * FROM aggregated
    ON CONFLICT (consumer_id,request_minute,receipt_minute) DO UPDATE SET
      first_receipt=LEAST(r.first_receipt,EXCLUDED.first_receipt),last_receipt=GREATEST(r.last_receipt,EXCLUDED.last_receipt),
      requests=r.requests+EXCLUDED.requests,server_errors=r.server_errors+EXCLUDED.server_errors,
      latency_samples=r.latency_samples+EXCLUDED.latency_samples,late_records=r.late_records+EXCLUDED.late_records,
      histogram=ARRAY(SELECT r.histogram[i]+EXCLUDED.histogram[i] FROM generate_subscripts(r.histogram,1) i ORDER BY i)
    RETURNING 1
  )
  UPDATE ${schema}.consumer_usage_rollup_state SET cells=cells+(SELECT COUNT(*) FROM new_keys),
    processed_records=processed_records+(SELECT COUNT(*) FROM claimed),
    attributed_records=attributed_records+COALESCE((SELECT SUM(requests) FROM aggregated),0),
    capacity_blocked=(SELECT COUNT(*) FROM admitted)<(SELECT COUNT(*) FROM selected),
    backfill_complete=CASE WHEN (SELECT COUNT(*) FROM admitted)<(SELECT COUNT(*) FROM selected) THEN false ELSE backfill_complete END
  WHERE singleton RETURNING (SELECT COUNT(*)::integer FROM claimed) INTO processed;
  RETURN processed;
END $function$;

CREATE OR REPLACE FUNCTION ${schema}.consumer_usage_receipt_lock() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('log-receipt:${tenantId.toLowerCase()}',0));
  RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION ${schema}.consumer_usage_inserted() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE page_ids UUID[]; pending BOOLEAN;
BEGIN
  -- Legacy imports may precede the receipt/UTC migration. Leave their markers
  -- pending rather than interpreting naive times in the collector's timezone.
  IF (SELECT COUNT(*) FROM pg_attribute WHERE attrelid=TG_RELID AND NOT attisdropped
    AND ((attname IN ('receivedAt','timestamp') AND atttypid='timestamptz'::regtype) OR attname='usageRollupVersion'))<>3 THEN
    RETURN NULL;
  END IF;
  -- The collector admits at most 1,000 logs. Operator bulk imports also remain
  -- bounded here: materialize one page and leave the remainder for backfill.
  page_ids=ARRAY(SELECT id FROM inserted_logs LIMIT 1000);
  PERFORM ${schema}.materialize_consumer_usage(page_ids);
  pending=EXISTS (SELECT 1 FROM inserted_logs OFFSET 1000 LIMIT 1);
  IF pending THEN
    UPDATE ${schema}.consumer_usage_rollup_state SET backfill_complete=false WHERE singleton;
    UPDATE ${schema}.consumer_path_rollup_state SET backfill_complete=false WHERE singleton;
  ELSE
    pending=EXISTS(SELECT 1 FROM ${schema}.request_logs WHERE id=ANY(page_ids)
      AND ("usageRollupVersion" IS NULL OR "pathRollupVersion" IS NULL));
  END IF;
  IF pending AND to_regclass('public.consumer_rollup_backlog') IS NOT NULL THEN
    INSERT INTO public.consumer_rollup_backlog(tenant_id) VALUES('${tenantId.toLowerCase()}'::uuid) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $function$;
DROP TRIGGER IF EXISTS consumer_usage_receipt_lock ON ${schema}.request_logs;
CREATE TRIGGER consumer_usage_receipt_lock BEFORE INSERT ON ${schema}.request_logs FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.consumer_usage_receipt_lock();
DROP TRIGGER IF EXISTS consumer_usage_inserted ON ${schema}.request_logs;
CREATE TRIGGER consumer_usage_inserted AFTER INSERT ON ${schema}.request_logs REFERENCING NEW TABLE AS inserted_logs FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.consumer_usage_inserted();
DO $recover$ BEGIN
  IF to_regclass('public.consumer_rollup_backlog') IS NOT NULL AND EXISTS(
    SELECT 1 FROM ${schema}.request_logs WHERE "usageRollupVersion" IS NULL OR "pathRollupVersion" IS NULL LIMIT 1
  ) THEN
    INSERT INTO public.consumer_rollup_backlog(tenant_id) VALUES('${tenantId.toLowerCase()}'::uuid) ON CONFLICT DO NOTHING;
  END IF;
END $recover$;
`;
}
