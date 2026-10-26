import {
  CONSUMER_PATH_ROLLUP_CELL_LIMIT,
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  LOG_REDACTED_FIELDS,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';

/** Independent dimensions/marker: count-only installations can backfill paths. */
export function consumerPathRollupSchemaSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  const bounds = CONSUMER_ROLLUP_HISTOGRAM_BOUNDS;
  const supported = LOG_REDACTED_FIELDS.map(
    (field) => `'${JSON.stringify(field)}'::jsonb`,
  ).join(',');
  const histogram = bounds
    .map(
      (upper, i) =>
        `COUNT(*) FILTER (WHERE "responseTimeMs">=${i ? bounds[i - 1] + 1 : 0} AND "responseTimeMs"<=${upper})::bigint`,
    )
    .join(',');
  const requestMinute = `date_bin(INTERVAL '1 minute',timestamp,TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  const receiptMinute = `date_bin(INTERVAL '1 minute',"receivedAt",TIMESTAMPTZ '2000-01-01 00:00:00+00')`;
  return `
DO $upgrade$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='${schema}.request_logs'::regclass AND attname='pathRollupVersion' AND NOT attisdropped) THEN
    BEGIN
      UPDATE public.tenants SET "consumerRollupPending"=true,"consumerRollupError"=false WHERE id='${tenantId.toLowerCase()}'::uuid;
    EXCEPTION WHEN undefined_column THEN
      -- Provisioning can precede startup public-schema migration. Its new
      -- discovery columns default to pending; ingestion still defers missing policy.
      NULL;
    END;
  END IF;
END $upgrade$;
ALTER TABLE ${schema}.request_logs ADD COLUMN IF NOT EXISTS "pathRollupVersion" SMALLINT CHECK ("pathRollupVersion" IS NULL OR "pathRollupVersion"=1);
CREATE INDEX IF NOT EXISTS request_logs_rollup_pending ON ${schema}.request_logs ("receivedAt",id) WHERE "usageRollupVersion" IS NULL OR "pathRollupVersion" IS NULL;
CREATE INDEX IF NOT EXISTS request_logs_path_pending_consumer ON ${schema}.request_logs ("consumerId",timestamp,id) WHERE "pathRollupVersion" IS NULL AND "consumerId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS request_logs_path_consumer_receipt ON ${schema}.request_logs ("consumerId","receivedAt",timestamp,id) WHERE "pathRollupVersion"=1 AND "consumerId" IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${schema}.consumer_path_rollup_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  version SMALLINT NOT NULL DEFAULT 1 CHECK(version=1),
  cells INTEGER NOT NULL DEFAULT 0 CHECK(cells BETWEEN 0 AND ${CONSUMER_PATH_ROLLUP_CELL_LIMIT}),
  processed_records BIGINT NOT NULL DEFAULT 0 CHECK(processed_records>=0),
  attributed_records BIGINT NOT NULL DEFAULT 0 CHECK(attributed_records>=0),
  backfill_complete BOOLEAN NOT NULL DEFAULT false,
  capacity_blocked BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO ${schema}.consumer_path_rollup_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${schema}.consumer_path_rollups (
  consumer_id UUID NOT NULL,
  request_minute TIMESTAMPTZ NOT NULL,
  receipt_minute TIMESTAMPTZ NOT NULL,
  method TEXT COLLATE "C" NOT NULL CHECK(char_length(method)<=16),
  path TEXT COLLATE "C" NOT NULL CHECK(char_length(path)<=512),
  first_receipt TIMESTAMPTZ NOT NULL,
  last_receipt TIMESTAMPTZ NOT NULL,
  requests BIGINT NOT NULL CHECK(requests>0),
  server_errors BIGINT NOT NULL CHECK(server_errors BETWEEN 0 AND requests),
  latency_samples BIGINT NOT NULL CHECK(latency_samples BETWEEN 0 AND requests),
  histogram BIGINT[] NOT NULL CHECK(cardinality(histogram)=${bounds.length}),
  PRIMARY KEY(consumer_id,request_minute,receipt_minute,method,path)
);
CREATE INDEX IF NOT EXISTS consumer_path_rollups_receipt ON ${schema}.consumer_path_rollups(last_receipt,consumer_id,request_minute,receipt_minute,method,path);
CREATE INDEX IF NOT EXISTS consumer_path_rollups_private ON ${schema}.consumer_path_rollups(consumer_id,request_minute,receipt_minute,method,path) WHERE path<>'[redacted]';

CREATE OR REPLACE FUNCTION ${schema}.materialize_consumer_paths(ids UUID[]) RETURNS INTEGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE capacity INTEGER; processed INTEGER; hidden BOOLEAN; path_hidden BOOLEAN; cutoff TIMESTAMPTZ; policy JSONB; fields JSONB;
BEGIN
  IF cardinality(ids)>1000 THEN RAISE EXCEPTION 'Consumer path batch exceeds limit'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('log-receipt:${tenantId.toLowerCase()}',0));
  BEGIN
    SELECT "logPrivacy",GREATEST("logRetentionFloor",clock_timestamp()-make_interval(secs=>"logRetentionDays"::integer*86400))
      INTO policy,cutoff FROM public.tenants WHERE id='${tenantId.toLowerCase()}'::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Consumer path workspace missing'; END IF;
  EXCEPTION WHEN undefined_column THEN RETURN 0;
  END;
  hidden=false; path_hidden=false;
  IF jsonb_typeof(policy)='object' AND policy ? 'redactedFields' THEN
    hidden=true; path_hidden=true;
    IF policy->>'clientIp' IN ('omit','retain') AND policy->>'userAgent' IN ('omit','retain')
      AND policy-'clientIp'-'userAgent'-'redactedFields'='{}'::jsonb
      AND jsonb_typeof(policy->'redactedFields')='array' THEN
      fields=policy->'redactedFields';
      IF jsonb_array_length(fields)<=${LOG_REDACTED_FIELDS.length}
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f WHERE f NOT IN (${supported}))
        AND (SELECT COUNT(DISTINCT f) FROM jsonb_array_elements(fields) f)=jsonb_array_length(fields) THEN
        hidden=fields ? 'consumerId'; path_hidden=fields ? 'path';
      END IF;
    END IF;
  END IF;
  SELECT ${CONSUMER_PATH_ROLLUP_CELL_LIMIT}-cells INTO capacity FROM ${schema}.consumer_path_rollup_state WHERE singleton FOR UPDATE;
  WITH selected AS MATERIALIZED (
    SELECT id,"consumerId",CASE WHEN isfinite(timestamp) THEN ${requestMinute} END AS request_minute,${receiptMinute} AS receipt_minute,
      LEFT(COALESCE(method,'UNKNOWN'),16) COLLATE "C" AS method,
      (CASE WHEN path_hidden THEN '[redacted]' ELSE LEFT(split_part(COALESCE(path,'/'), '?',1),512) END) COLLATE "C" AS path,
      NOT hidden AND "consumerId" IS NOT NULL AND timestamp IS NOT NULL AND isfinite(timestamp) AND "receivedAt">=cutoff AS attributable
    FROM ${schema}.request_logs WHERE id=ANY(ids) AND "pathRollupVersion" IS NULL
  ), new_keys AS MATERIALIZED (
    SELECT DISTINCT s."consumerId" AS consumer_id,s.request_minute,s.receipt_minute,s.method,s.path FROM selected s
    WHERE s.attributable AND NOT EXISTS(SELECT 1 FROM ${schema}.consumer_path_rollups r
      WHERE (r.consumer_id,r.request_minute,r.receipt_minute,r.method,r.path)=(s."consumerId",s.request_minute,s.receipt_minute,s.method,s.path))
    ORDER BY 1,2,3,4,5 LIMIT capacity
  ), admitted AS MATERIALIZED (
    SELECT s.id FROM selected s WHERE NOT s.attributable OR EXISTS(SELECT 1 FROM ${schema}.consumer_path_rollups r
      WHERE (r.consumer_id,r.request_minute,r.receipt_minute,r.method,r.path)=(s."consumerId",s.request_minute,s.receipt_minute,s.method,s.path))
      OR EXISTS(SELECT 1 FROM new_keys k WHERE (k.consumer_id,k.request_minute,k.receipt_minute,k.method,k.path)=(s."consumerId",s.request_minute,s.receipt_minute,s.method,s.path))
  ), claimed AS (
    UPDATE ${schema}.request_logs l SET "pathRollupVersion"=1 FROM admitted a WHERE l.id=a.id
      RETURNING l."consumerId",l.timestamp,l."receivedAt",l.method,l.path,l."statusCode",l."responseTimeMs"
  ), aggregated AS MATERIALIZED (
    SELECT "consumerId" AS consumer_id,${requestMinute} AS request_minute,${receiptMinute} AS receipt_minute,
      LEFT(COALESCE(method,'UNKNOWN'),16) COLLATE "C" AS method,
      (CASE WHEN path_hidden THEN '[redacted]' ELSE LEFT(split_part(COALESCE(path,'/'), '?',1),512) END) COLLATE "C" AS path,
      MIN("receivedAt") AS first_receipt,MAX("receivedAt") AS last_receipt,COUNT(*)::bigint AS requests,
      COUNT(*) FILTER(WHERE "statusCode">=500)::bigint AS server_errors,
      COUNT(*) FILTER(WHERE "responseTimeMs">=0)::bigint AS latency_samples,ARRAY[${histogram}] AS histogram
    FROM claimed WHERE NOT hidden AND "consumerId" IS NOT NULL AND timestamp IS NOT NULL AND isfinite(timestamp) AND "receivedAt">=cutoff GROUP BY 1,2,3,4,5
  ), stored AS (
    INSERT INTO ${schema}.consumer_path_rollups AS r SELECT * FROM aggregated
    ON CONFLICT(consumer_id,request_minute,receipt_minute,method,path) DO UPDATE SET
      first_receipt=LEAST(r.first_receipt,EXCLUDED.first_receipt),last_receipt=GREATEST(r.last_receipt,EXCLUDED.last_receipt),
      requests=r.requests+EXCLUDED.requests,server_errors=r.server_errors+EXCLUDED.server_errors,
      latency_samples=r.latency_samples+EXCLUDED.latency_samples,
      histogram=ARRAY(SELECT r.histogram[i]+EXCLUDED.histogram[i] FROM generate_subscripts(r.histogram,1) i ORDER BY i)
    RETURNING 1
  ) UPDATE ${schema}.consumer_path_rollup_state SET cells=cells+(SELECT COUNT(*) FROM new_keys),
    processed_records=processed_records+(SELECT COUNT(*) FROM claimed),attributed_records=attributed_records+COALESCE((SELECT SUM(requests) FROM aggregated),0),
    capacity_blocked=(SELECT COUNT(*) FROM admitted)<(SELECT COUNT(*) FROM selected),
    backfill_complete=CASE WHEN (SELECT COUNT(*) FROM admitted)<(SELECT COUNT(*) FROM selected) THEN false ELSE backfill_complete END
    WHERE singleton RETURNING (SELECT COUNT(*)::integer FROM claimed) INTO processed;
  RETURN processed;
END $function$;
`;
}
