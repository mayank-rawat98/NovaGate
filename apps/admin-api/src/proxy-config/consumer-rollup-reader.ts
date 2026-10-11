import { ServiceUnavailableException } from '@nestjs/common';
import {
  CONSUMER_ROLLUP_CELL_LIMIT,
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  CONSUMER_ROLLUP_QUERY_CELL_LIMIT,
  CONSUMER_ROLLUP_QUERY_RAW_LIMIT,
  type ConsumerRollupCoverage,
  type ConsumerUsageBucket,
  type ConsumerUsageCounts,
  type ConsumerUsagePath,
} from '@api-gateway/shared-types';
import type { EntityManager } from 'typeorm';
import { tenantSchema } from '../tenants/tenant-schema';

import {
  consumerRollupCounts as counts,
  type StoredConsumerRollupCounts as StoredCounts,
} from './consumer-rollup-counts';
import { readConsumerPathRollup } from './consumer-path-rollup-reader';

/** Shares the caller's repeatable snapshot and statement/lock/work-memory budgets. */
export async function readConsumerRollup(
  manager: Pick<EntityManager, 'query'>,
  input: {
    tenantId: string;
    consumerId: string;
    from: string;
    to: string;
    receiptCutoff: string;
    bucketSeconds: number;
    pathHidden?: boolean;
  },
): Promise<{
  totals: ConsumerUsageCounts;
  series: ConsumerUsageBucket[];
  topPaths: ConsumerUsagePath[];
  rollup: ConsumerRollupCoverage;
}> {
  const schema = tenantSchema(input.tenantId);
  const fromMs = Date.parse(input.from),
    toMs = Date.parse(input.to);
  const seconds = (toMs - fromMs) / 1000;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 604800 ||
    ![60, 900, 3600].includes(input.bucketSeconds) ||
    !Number.isFinite(Date.parse(input.receiptCutoff)) ||
    Math.ceil(
      (toMs -
        Math.floor(fromMs / (input.bucketSeconds * 1000)) *
          input.bucketSeconds *
          1000) /
        (input.bucketSeconds * 1000),
    ) > 169
  )
    throw new Error('Unsupported consumer rollup window');
  const [ready] = await manager.query(
    'SELECT to_regclass($1) IS NOT NULL AS ready',
    [`${schema}.consumer_usage_rollup_state`],
  );
  if (!ready?.ready)
    throw new ServiceUnavailableException(
      'This window exceeds the consumer usage limit. Choose a shorter period.',
    );
  const bins = CONSUMER_ROLLUP_HISTOGRAM_BOUNDS;
  const rawHistogram = bins
    .map(
      (upper, i) =>
        `COUNT(*) FILTER (WHERE duration>=${i ? bins[i - 1] + 1 : 0} AND duration<=${upper})::bigint`,
    )
    .join(',');
  const origin = `TIMESTAMPTZ '2000-01-01 00:00:00+00'`;
  const minute = (value: string) =>
    `date_bin(INTERVAL '1 minute',${value},${origin})`;
  const ceil = (value: string) =>
    `${minute(value)}+CASE WHEN ${value}=${minute(value)} THEN INTERVAL '0 seconds' ELSE INTERVAL '1 minute' END`;
  const bucket = (value: string) =>
    `date_bin(make_interval(secs=>$5::integer),${value},${origin})`;
  const [row] = await manager.query(
    `WITH bounds AS MATERIALIZED (
      SELECT $2::timestamptz AS lo,$3::timestamptz AS hi,$4::timestamptz AS receipt_lo,
        ${ceil('$2::timestamptz')} AS full_lo,${minute('$3::timestamptz')} AS full_hi,
        ${ceil('$4::timestamptz')} AS receipt_full_lo
    ), cells AS MATERIALIZED (
      SELECT r.* FROM ${schema}.consumer_usage_rollups r CROSS JOIN bounds b
      WHERE r.consumer_id=$1::uuid AND r.request_minute>=b.full_lo AND r.request_minute<b.full_hi
        AND r.receipt_minute>=b.receipt_full_lo LIMIT $6
    ), raw_page AS MATERIALIZED (
      SELECT timestamp,"statusCode",CASE WHEN "responseTimeMs">=0 THEN "responseTimeMs" END AS duration,"receivedAt",pending
      FROM (
        (SELECT l.timestamp,l."statusCode",l."responseTimeMs",l."receivedAt",true AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."usageRollupVersion" IS NULL AND l.timestamp>=b.lo AND l.timestamp<b.hi AND l."receivedAt">=b.receipt_lo LIMIT $7)
        UNION ALL
        (SELECT l.timestamp,l."statusCode",l."responseTimeMs",l."receivedAt",false AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."usageRollupVersion"=1 AND l.timestamp>=b.lo AND l.timestamp<b.hi AND l."receivedAt">=b.receipt_lo
          AND l.timestamp<b.full_lo LIMIT $7)
        UNION ALL
        (SELECT l.timestamp,l."statusCode",l."responseTimeMs",l."receivedAt",false AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."usageRollupVersion"=1 AND l.timestamp>=b.full_hi AND l.timestamp>=b.full_lo AND l.timestamp<b.hi AND l."receivedAt">=b.receipt_lo LIMIT $7)
        UNION ALL
        (SELECT l.timestamp,l."statusCode",l."responseTimeMs",l."receivedAt",false AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."usageRollupVersion"=1 AND l.timestamp>=b.full_lo AND l.timestamp<b.full_hi
          AND l."receivedAt">=b.receipt_lo AND l."receivedAt"<b.receipt_full_lo LIMIT $7)
      ) records LIMIT $7
    ), cardinality AS (
      SELECT (SELECT COUNT(*)::integer FROM cells) AS cells,(SELECT COUNT(*)::integer FROM raw_page) AS raw,
        (SELECT COUNT(*)::integer FROM raw_page WHERE pending) AS pending
    ), raw_groups AS (
      SELECT ${bucket('timestamp')} AS timestamp,COUNT(*)::bigint AS requests,
        COUNT(*) FILTER (WHERE "statusCode">=500)::bigint AS errors,COUNT(duration)::bigint AS samples,
        COUNT(*) FILTER (WHERE "receivedAt">=${minute('timestamp')}+INTERVAL '75 seconds')::bigint AS late,
        ARRAY[${rawHistogram}] AS histogram
      FROM raw_page WHERE (SELECT raw FROM cardinality)<$7 AND (SELECT cells FROM cardinality)<$6 GROUP BY 1
    ), parts AS MATERIALIZED (
      SELECT request_minute AS timestamp,requests,server_errors AS errors,latency_samples AS samples,late_records AS late,histogram
      FROM cells WHERE (SELECT cells FROM cardinality)<$6 AND (SELECT raw FROM cardinality)<$7
      UNION ALL SELECT * FROM raw_groups
    ), bucket_counts AS (
      SELECT ${bucket('timestamp')} AS timestamp,SUM(requests)::text AS requests,SUM(errors)::text AS errors,
        SUM(samples)::text AS samples,SUM(late)::text AS late FROM parts GROUP BY 1
    ), histogram_bins AS (
      SELECT ${bucket('p.timestamp')} AS timestamp,i,SUM(p.histogram[i])::text AS count
      FROM parts p CROSS JOIN generate_series(1,${bins.length}) i GROUP BY 1,2
    ), bucket_histograms AS (
      SELECT timestamp,array_agg(count ORDER BY i) AS histogram FROM histogram_bins GROUP BY 1
    ), total_histogram AS (
      SELECT ARRAY(SELECT COALESCE(SUM(count::numeric),0)::text FROM generate_series(1,${bins.length}) i
        LEFT JOIN histogram_bins h USING(i) GROUP BY i ORDER BY i) AS histogram
    ), totals AS (
      SELECT COALESCE(SUM(requests::numeric),0)::text AS requests,COALESCE(SUM(errors::numeric),0)::text AS errors,
        COALESCE(SUM(samples::numeric),0)::text AS samples,COALESCE(SUM(late::numeric),0)::text AS late,
        (SELECT histogram FROM total_histogram) AS histogram FROM bucket_counts
    ), series AS (
      SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
        EXTRACT(EPOCH FROM LEAST(t+make_interval(secs=>$5::integer),b.hi)-GREATEST(t,b.lo))::double precision AS seconds,
        COALESCE(c.requests,'0') AS requests,COALESCE(c.errors,'0') AS errors,COALESCE(c.samples,'0') AS samples,COALESCE(c.late,'0') AS late,
        COALESCE(h.histogram,array_fill('0'::text,ARRAY[${bins.length}])) AS histogram
      FROM bounds b CROSS JOIN LATERAL generate_series(${bucket('b.lo')},${bucket("b.hi-INTERVAL '1 microsecond'")},make_interval(secs=>$5::integer)) t
      LEFT JOIN bucket_counts c ON c.timestamp=t LEFT JOIN bucket_histograms h ON h.timestamp=t
    ) SELECT to_jsonb(totals) AS totals,(SELECT jsonb_agg(series ORDER BY timestamp) FROM series) AS series,
      cardinality.*,s.version,s.backfill_complete,s.capacity_blocked,s.cells AS stored_cells
      FROM totals CROSS JOIN cardinality CROSS JOIN ${schema}.consumer_usage_rollup_state s WHERE s.singleton`,
    [
      input.consumerId,
      input.from,
      input.to,
      input.receiptCutoff,
      input.bucketSeconds,
      CONSUMER_ROLLUP_QUERY_CELL_LIMIT + 1,
      CONSUMER_ROLLUP_QUERY_RAW_LIMIT + 1,
    ],
  );
  if (!row || row.version !== 1)
    throw new Error('Unsupported consumer rollup version');
  if (
    row.cells > CONSUMER_ROLLUP_QUERY_CELL_LIMIT ||
    row.raw > CONSUMER_ROLLUP_QUERY_RAW_LIMIT
  )
    throw new ServiceUnavailableException(
      'This usage window exceeds the rollup or boundary limit. Choose a shorter period.',
    );
  if (!Array.isArray(row.series) || row.series.length > 169)
    throw new Error('Invalid consumer rollup series');
  const totals = counts(row.totals, seconds);
  const series = row.series.map(
    (entry: StoredCounts & { timestamp: string; seconds: number }) => ({
      ...counts(entry, entry.seconds),
      timestamp: entry.timestamp,
      observedSeconds: entry.seconds,
    }),
  );
  if (
    series.reduce(
      (sum: number, entry: ConsumerUsageBucket) => sum + entry.requests,
      0,
    ) !== totals.requests
  )
    throw new Error('Consumer rollup series mismatch');
  const paths = await readConsumerPathRollup(
    manager,
    { ...input, pathHidden: input.pathHidden ?? false },
    row.totals,
  );
  return {
    totals,
    series,
    topPaths: paths.topPaths,
    rollup: {
      version: 1,
      counts: 'complete_for_retained_records',
      materialization:
        row.pending &&
        (row.capacity_blocked || row.stored_cells >= CONSUMER_ROLLUP_CELL_LIMIT)
          ? 'capacity_limited'
          : row.backfill_complete && !row.pending
            ? 'complete'
            : 'backfilling',
      latencyMethod: 'histogram_bucket_upper_bound',
      seriesAlignment: 'utc',
      paths: 'complete_for_retained_records',
      pathAggregation: paths.coverage,
      rollupCells: row.cells,
      rawRecords: row.raw,
      pendingRecords: row.pending,
      lateRecords: Number(BigInt(row.totals.late)),
      limits: {
        cells: CONSUMER_ROLLUP_QUERY_CELL_LIMIT,
        rawRecords: CONSUMER_ROLLUP_QUERY_RAW_LIMIT,
        buckets: 169,
      },
    },
  };
}
