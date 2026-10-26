import {
  METRIC_LATENCY_BUCKETS,
  metricPercentile,
  validateMetricWindow,
  type AlertEvaluation,
  type AlertRuleConfig,
  type MetricWindow,
} from '@api-gateway/shared-types';

export const MAX_ALERT_WINDOW_SAMPLES = 5000;
export const ALERT_MIN_COVERAGE = 0.8;
export const ALERT_FRESHNESS_MS = 15000;
export interface AlertMetricSample {
  timestamp: Date;
  aggregateWindow: unknown;
}

/**
 * Select whole intervals by their server receipt time. Clip their estimated
 * coverage at the lookback boundary, but never prorate counts or histogram bins.
 * Legacy rows contribute no coverage. Percentiles are fixed-bucket upper bounds.
 */
export function aggregateAlertWindow(
  rule: AlertRuleConfig,
  samples: readonly AlertMetricSample[],
  now: Date,
): AlertEvaluation {
  const end = now.getTime();
  const duration = rule.windowMinutes * 60000;
  const start = end - duration;
  const empty: AlertEvaluation = {
    state: 'no_data',
    value: null,
    requestCount: 0,
    coverage: 0,
    evaluatedAt: now.toISOString(),
  };
  if (samples.length > MAX_ALERT_WINDOW_SAMPLES) return empty;
  const selected: Array<{ end: number; window: MetricWindow }> = [];
  for (const sample of samples) {
    const timestamp = sample.timestamp.getTime();
    if (!Number.isFinite(timestamp) || timestamp > end) return empty;
    if (timestamp <= start || sample.aggregateWindow === null) continue;
    try {
      selected.push({
        end: timestamp,
        window: validateMetricWindow(sample.aggregateWindow),
      });
    } catch {
      return empty;
    }
  }
  selected.sort((a, b) => a.end - b.end);
  const counts = METRIC_LATENCY_BUCKETS.map(() => 0);
  let requests = 0,
    errors = 0,
    timeouts = 0,
    elapsed = 0,
    covered = 0;
  let previousEnd = start;
  for (const sample of selected) {
    const intervalStart = Math.max(start, sample.end - sample.window.windowMs);
    covered += Math.max(0, sample.end - Math.max(previousEnd, intervalStart));
    previousEnd = Math.max(previousEnd, sample.end);
    elapsed += sample.window.windowMs;
    requests += sample.window.requestCount;
    errors += sample.window.errorCount;
    timeouts += sample.window.timeoutCount;
    sample.window.latencyCounts.forEach((count, i) => {
      counts[i] += count;
    });
  }
  const coverage = Math.min(1, covered / duration);
  const result = { ...empty, requestCount: requests, coverage };
  if (
    !selected.length ||
    coverage < ALERT_MIN_COVERAGE ||
    end - selected[selected.length - 1].end > ALERT_FRESHNESS_MS ||
    requests < rule.minRequests ||
    // Heavy overlaps cannot prove a single reporting timeline. Do not report a
    // healthy result from duplicated reports or an ambiguous multi-gateway feed.
    elapsed > covered * 1.25 + 1000
  )
    return result;
  if (rule.metric !== 'rps' && requests === 0) return result;
  const value =
    rule.metric === 'rps'
      ? (requests * 1000) / elapsed
      : rule.metric === 'error_rate'
        ? errors / requests
        : rule.metric === 'downstream_timeout_rate'
          ? timeouts / requests
          : metricPercentile(counts, requests, 0.95);
  const firing =
    rule.operator === '>'
      ? value > rule.threshold
      : rule.operator === '>='
        ? value >= rule.threshold
        : rule.operator === '<'
          ? value < rule.threshold
          : value <= rule.threshold;
  return { ...result, value, state: firing ? 'firing' : 'ok' };
}
