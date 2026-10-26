import { ServiceUnavailableException } from '@nestjs/common';
import {
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  consumerHistogramPercentile,
  type ConsumerUsageCounts,
} from '@api-gateway/shared-types';

export interface StoredConsumerRollupCounts {
  requests: string;
  errors: string;
  samples: string;
  late: string;
  histogram: string[];
}

/** SQL decimal integers remain exact until safe public JSON conversion. */
export function consumerRollupCounts(
  row: StoredConsumerRollupCounts,
  seconds: number,
): ConsumerUsageCounts {
  const values = [row.requests, row.errors, row.samples, row.late];
  if (values.some((value) => typeof value !== 'string' || !/^\d+$/.test(value)))
    throw new Error('Invalid consumer rollup counts');
  const [requests, errors, samples, late] = values.map(BigInt);
  if (
    requests > BigInt(Number.MAX_SAFE_INTEGER) ||
    errors > requests ||
    samples > requests ||
    late > requests ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  )
    throw new ServiceUnavailableException(
      'This usage window cannot be represented safely. Choose a shorter period.',
    );
  if (
    !Array.isArray(row.histogram) ||
    row.histogram.length !== CONSUMER_ROLLUP_HISTOGRAM_BOUNDS.length ||
    row.histogram.some(
      (value) => typeof value !== 'string' || !/^\d+$/.test(value),
    )
  )
    throw new Error('Invalid consumer rollup histogram');
  const histogram = row.histogram.map(BigInt);
  if (histogram.reduce((sum, value) => sum + value, 0n) !== samples)
    throw new Error('Consumer rollup sample mismatch');
  return {
    requests: Number(requests),
    serverErrors: Number(errors),
    latencySamples: Number(samples),
    errorRate: requests ? Number(errors) / Number(requests) : 0,
    rps: Number(requests) / seconds,
    p50Ms: consumerHistogramPercentile(histogram, 50),
    p95Ms: consumerHistogramPercentile(histogram, 95),
    p99Ms: consumerHistogramPercentile(histogram, 99),
  };
}
