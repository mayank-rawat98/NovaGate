import { ServiceUnavailableException } from '@nestjs/common';
import {
  CONSUMER_PATH_ROLLUP_CELL_LIMIT,
  CONSUMER_PATH_ROLLUP_QUERY_CELL_LIMIT,
  CONSUMER_PATH_ROLLUP_QUERY_RAW_LIMIT,
  CONSUMER_PATH_ROLLUP_TOP_LIMIT,
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  type ConsumerUsagePath,
  type ConsumerPathRollupCoverage,
} from '@api-gateway/shared-types';
import type { EntityManager } from 'typeorm';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  consumerRollupCounts,
  type StoredConsumerRollupCounts,
} from './consumer-rollup-counts';

/** Same repeatable snapshot as the count reader; no cell-local top-N truncation. */
export async function readConsumerPathRollup(
  manager: Pick<EntityManager, 'query'>,
  input: {
    tenantId: string;
    consumerId: string;
    from: string;
    to: string;
    receiptCutoff: string;
    pathHidden: boolean;
  },
  expected: StoredConsumerRollupCounts,
): Promise<{
  topPaths: ConsumerUsagePath[];
  coverage: ConsumerPathRollupCoverage;
}> {
  const schema = tenantSchema(input.tenantId);
  const seconds = (Date.parse(input.to) - Date.parse(input.from)) / 1000;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 604800 ||
    !Number.isFinite(Date.parse(input.receiptCutoff))
  )
    throw new Error('Unsupported consumer path window');
  const [ready] = await manager.query(
    'SELECT to_regclass($1) IS NOT NULL AS ready',
    [`${schema}.consumer_path_rollup_state`],
  );
  if (!ready?.ready)
    throw new ServiceUnavailableException(
      'Path usage is still being prepared. Choose a shorter period or retry shortly.',
    );
  const bins = CONSUMER_ROLLUP_HISTOGRAM_BOUNDS;
  const rawHistogram = bins
    .map(
      (upper, i) =>
        `COUNT(*) FILTER(WHERE duration>=${i ? bins[i - 1] + 1 : 0} AND duration<=${upper})::bigint`,
    )
    .join(',');
  const origin = `TIMESTAMPTZ '2000-01-01 00:00:00+00'`;
  const minute = (value: string) =>
    `date_bin(INTERVAL '1 minute',${value},${origin})`;
  const ceil = (value: string) =>
    `${minute(value)}+CASE WHEN ${value}=${minute(value)} THEN INTERVAL '0 seconds' ELSE INTERVAL '1 minute' END`;
  const [row] = await manager.query(
    `WITH bounds AS MATERIALIZED (
      SELECT $2::timestamptz AS lo,$3::timestamptz AS hi,$4::timestamptz AS receipt_lo,
        ${ceil('$2::timestamptz')} AS full_lo,${minute('$3::timestamptz')} AS full_hi,
        ${ceil('$4::timestamptz')} AS receipt_full_lo
    ), cells AS MATERIALIZED (
      SELECT r.method,(CASE WHEN $5::boolean THEN '[redacted]' ELSE r.path END) COLLATE "C" AS path,
        r.requests,r.server_errors,r.latency_samples,r.histogram
      FROM ${schema}.consumer_path_rollups r CROSS JOIN bounds b
      WHERE r.consumer_id=$1::uuid AND r.request_minute>=b.full_lo AND r.request_minute<b.full_hi
        AND r.receipt_minute>=b.receipt_full_lo LIMIT $6
    ), raw_page AS MATERIALIZED (
      SELECT LEFT(COALESCE(method,'UNKNOWN'),16) COLLATE "C" AS method,
        (CASE WHEN $5::boolean THEN '[redacted]' ELSE LEFT(split_part(COALESCE(path,'/'), '?',1),512) END) COLLATE "C" AS path,
        "statusCode",CASE WHEN "responseTimeMs">=0 THEN "responseTimeMs" END AS duration,pending
      FROM (
        (SELECT l.method,l.path,l."statusCode",l."responseTimeMs",true AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."pathRollupVersion" IS NULL AND l.timestamp>=b.lo AND l.timestamp<b.hi AND l."receivedAt">=b.receipt_lo LIMIT $7)
        UNION ALL
        (SELECT l.method,l.path,l."statusCode",l."responseTimeMs",false AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."pathRollupVersion"=1 AND l.timestamp>=b.lo AND l.timestamp<b.hi AND l."receivedAt">=b.receipt_lo
          AND l.timestamp<b.full_lo LIMIT $7)
        UNION ALL
        (SELECT l.method,l.path,l."statusCode",l."responseTimeMs",false AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."pathRollupVersion"=1 AND l.timestamp>=b.full_hi AND l.timestamp>=b.full_lo AND l.timestamp<b.hi AND l."receivedAt">=b.receipt_lo LIMIT $7)
        UNION ALL
        (SELECT l.method,l.path,l."statusCode",l."responseTimeMs",false AS pending FROM ${schema}.request_logs l CROSS JOIN bounds b
          WHERE l."consumerId"=$1::uuid AND l."pathRollupVersion"=1 AND l.timestamp>=b.full_lo AND l.timestamp<b.full_hi
          AND l."receivedAt">=b.receipt_lo AND l."receivedAt"<b.receipt_full_lo LIMIT $7)
      ) records LIMIT $7
    ), cardinality AS (
      SELECT (SELECT COUNT(*)::integer FROM cells) AS cells,(SELECT COUNT(*)::integer FROM raw_page) AS raw,
        (SELECT COUNT(*)::integer FROM raw_page WHERE pending) AS pending
    ), supported AS (
      SELECT cells<$6 AND raw<$7 AS ok FROM cardinality
    ), raw_groups AS (
      SELECT method,path,COUNT(*)::bigint AS requests,COUNT(*) FILTER(WHERE "statusCode">=500)::bigint AS errors,
        COUNT(duration)::bigint AS samples,ARRAY[${rawHistogram}] AS histogram
      FROM raw_page WHERE (SELECT ok FROM supported) GROUP BY 1,2
    ), parts AS MATERIALIZED (
      SELECT method,path,requests,server_errors AS errors,latency_samples AS samples,histogram
      FROM cells WHERE (SELECT ok FROM supported)
      UNION ALL SELECT * FROM raw_groups
    ), group_counts AS MATERIALIZED (
      SELECT method,path,SUM(requests) AS requests,SUM(errors) AS errors,SUM(samples) AS samples FROM parts GROUP BY 1,2
    ), top_keys AS MATERIALIZED (
      SELECT * FROM group_counts ORDER BY requests DESC,method,path LIMIT $8
    ), top_bins AS (
      SELECT p.method,p.path,i,SUM(p.histogram[i])::text AS count FROM parts p JOIN top_keys k USING(method,path)
        CROSS JOIN generate_series(1,${bins.length}) i GROUP BY 1,2,3
    ), top_histograms AS (
      SELECT method,path,array_agg(count ORDER BY i) AS histogram FROM top_bins GROUP BY 1,2
    ), paths AS (
      SELECT k.method,k.path,k.requests::text AS requests,k.errors::text AS errors,k.samples::text AS samples,h.histogram
      FROM top_keys k JOIN top_histograms h USING(method,path)
    ), raw_total_histogram AS (
      SELECT ARRAY[${rawHistogram}] AS histogram FROM raw_page WHERE (SELECT ok FROM supported)
    ), cell_bins AS (
      SELECT i,COALESCE(SUM(c.histogram[i]),0) AS count FROM generate_series(1,${bins.length}) i
        LEFT JOIN cells c ON (SELECT ok FROM supported) GROUP BY i
    ), totals AS (
      SELECT COALESCE(SUM(requests),0)::text AS requests,COALESCE(SUM(errors),0)::text AS errors,COALESCE(SUM(samples),0)::text AS samples,
        ARRAY(SELECT (count+r.histogram[i])::text FROM cell_bins CROSS JOIN raw_total_histogram r ORDER BY i) AS histogram
      FROM group_counts
    ) SELECT to_jsonb(totals) AS totals,
      (SELECT COALESCE(jsonb_agg(paths ORDER BY requests::numeric DESC,method,path),'[]'::jsonb) FROM paths) AS paths,
      (SELECT COUNT(*)::integer FROM group_counts) AS groups,cardinality.*,s.version,s.backfill_complete,s.capacity_blocked,s.cells AS stored_cells
      FROM totals CROSS JOIN cardinality CROSS JOIN ${schema}.consumer_path_rollup_state s WHERE s.singleton`,
    [
      input.consumerId,
      input.from,
      input.to,
      input.receiptCutoff,
      input.pathHidden,
      CONSUMER_PATH_ROLLUP_QUERY_CELL_LIMIT + 1,
      CONSUMER_PATH_ROLLUP_QUERY_RAW_LIMIT + 1,
      CONSUMER_PATH_ROLLUP_TOP_LIMIT,
    ],
  );
  if (!row || row.version !== 1)
    throw new Error('Unsupported consumer path version');
  if (
    row.cells > CONSUMER_PATH_ROLLUP_QUERY_CELL_LIMIT ||
    row.raw > CONSUMER_PATH_ROLLUP_QUERY_RAW_LIMIT
  )
    throw new ServiceUnavailableException(
      'This usage window exceeds the path or boundary limit. Choose a shorter period.',
    );
  consumerRollupCounts({ ...row.totals, late: '0' }, seconds);
  if (
    ['requests', 'errors', 'samples'].some(
      (k) =>
        BigInt(row.totals[k]) !==
        BigInt(expected[k as 'requests' | 'errors' | 'samples']),
    ) ||
    row.totals.histogram.some(
      (n: string, i: number) => BigInt(n) !== BigInt(expected.histogram[i]),
    )
  )
    throw new ServiceUnavailableException(
      'Path usage does not match retained counts. Choose a shorter period or retry shortly.',
    );
  if (
    !Array.isArray(row.paths) ||
    row.paths.length > CONSUMER_PATH_ROLLUP_TOP_LIMIT ||
    !Number.isInteger(row.groups) ||
    row.groups < row.paths.length
  )
    throw new Error('Invalid consumer path groups');
  const topPaths = row.paths.map(
    (path: StoredConsumerRollupCounts & { method: string; path: string }) => {
      if (
        typeof path.method !== 'string' ||
        Array.from(path.method).length > 16 ||
        typeof path.path !== 'string' ||
        Array.from(path.path).length > 512 ||
        (input.pathHidden && path.path !== '[redacted]')
      )
        throw new Error('Invalid consumer path projection');
      return {
        ...consumerRollupCounts({ ...path, late: '0' }, seconds),
        method: path.method,
        path: path.path,
      };
    },
  );
  return {
    topPaths,
    coverage: {
      version: 1,
      materialization:
        row.pending &&
        (row.capacity_blocked ||
          row.stored_cells >= CONSUMER_PATH_ROLLUP_CELL_LIMIT)
          ? 'capacity_limited'
          : row.backfill_complete && !row.pending
            ? 'complete'
            : 'backfilling',
      rollupCells: row.cells,
      rawRecords: row.raw,
      pendingRecords: row.pending,
      groups: row.groups,
      limits: {
        cells: CONSUMER_PATH_ROLLUP_QUERY_CELL_LIMIT,
        rawRecords: CONSUMER_PATH_ROLLUP_QUERY_RAW_LIMIT,
        returnedGroups: CONSUMER_PATH_ROLLUP_TOP_LIMIT,
      },
    },
  };
}
