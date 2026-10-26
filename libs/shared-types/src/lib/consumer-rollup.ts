/** Versioned, mergeable upper-bound latency estimates over persisted logs. */
export const CONSUMER_ROLLUP_VERSION = 1;
export const CONSUMER_ROLLUP_CELL_LIMIT = 250000;
export const CONSUMER_ROLLUP_PAGE_SIZE = 500;
export const CONSUMER_ROLLUP_QUERY_CELL_LIMIT = 20000;
export const CONSUMER_ROLLUP_QUERY_RAW_LIMIT = 100000;
/** Path dimensions have an independent cap; pressure cannot discard source logs. */
export const CONSUMER_PATH_ROLLUP_CELL_LIMIT = 250000;
export const CONSUMER_PATH_ROLLUP_QUERY_CELL_LIMIT = 20000;
export const CONSUMER_PATH_ROLLUP_QUERY_RAW_LIMIT = 100000;
export const CONSUMER_PATH_ROLLUP_TOP_LIMIT = 10;
export interface ConsumerPathRollupCoverage {
  version: 1;
  materialization: 'complete' | 'backfilling' | 'capacity_limited';
  rollupCells: number;
  rawRecords: number;
  pendingRecords: number;
  /** All normalized groups considered before selecting the global busiest ten. */
  groups: number;
  limits: { cells: number; rawRecords: number; returnedGroups: number };
}
/** Coverage describes available retained observations, not guaranteed traffic. */
export interface ConsumerRollupCoverage {
  version: 1;
  counts: 'complete_for_retained_records';
  materialization: 'complete' | 'backfilling' | 'capacity_limited';
  latencyMethod: 'histogram_bucket_upper_bound';
  seriesAlignment: 'utc';
  paths: 'unavailable' | 'complete_for_retained_records';
  pathAggregation?: ConsumerPathRollupCoverage;
  rollupCells: number;
  rawRecords: number;
  pendingRecords: number;
  lateRecords: number;
  limits: { cells: number; rawRecords: number; buckets: number };
}
// request_logs stores integer milliseconds. The last bucket covers every valid
// nonnegative PostgreSQL INTEGER; missing/negative durations are not samples.
export const CONSUMER_ROLLUP_HISTOGRAM_BOUNDS: readonly number[] =
  Object.freeze([
    0,
    ...Array.from({ length: 31 }, (_, i) => 2 ** i),
    2147483647,
  ]);

export function validateConsumerHistogram(value: readonly bigint[]): void {
  if (
    value.length !== CONSUMER_ROLLUP_HISTOGRAM_BOUNDS.length ||
    value.some((count) => typeof count !== 'bigint' || count < 0n)
  )
    throw new Error('Invalid consumer latency histogram');
}

export function mergeConsumerHistograms(
  left: readonly bigint[],
  right: readonly bigint[],
): bigint[] {
  validateConsumerHistogram(left);
  validateConsumerHistogram(right);
  return left.map((count, i) => count + right[i]);
}

/** Counts never pass through floating point, including nearest-rank rounding. */
export function consumerHistogramPercentile(
  histogram: readonly bigint[],
  percentile: 50 | 95 | 99,
): number | null {
  validateConsumerHistogram(histogram);
  if (percentile !== 50 && percentile !== 95 && percentile !== 99)
    throw new Error('Invalid consumer percentile');
  const total = histogram.reduce((sum, count) => sum + count, 0n);
  if (!total) return null;
  const rank = (total * BigInt(percentile) + 99n) / 100n;
  let cumulative = 0n;
  for (let i = 0; i < histogram.length; i++) {
    cumulative += histogram[i];
    if (cumulative >= rank) return CONSUMER_ROLLUP_HISTOGRAM_BOUNDS[i];
  }
  throw new Error('Invalid consumer latency histogram');
}
