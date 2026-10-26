import {
  ANOMALY_CURRENT_MINUTES,
  ANOMALY_MIN_BASELINE_WINDOWS,
  ANOMALY_WINDOW_MINUTES,
  type AnomalyDirection,
  type AnomalyMetric,
} from '@api-gateway/shared-types';

/** Windows with fewer requests say little about error rates or latency. */
export const MIN_WINDOW_REQUESTS = 10;
/** Consecutive calm evaluations before an active anomaly resolves. */
export const CALM_TICKS_TO_RESOLVE = 3;

export interface Moments {
  /** Windows that contributed. */
  n: number;
  sum: number;
  sumSq: number;
}

/** Per-route baseline sums from stored 15-minute windows. */
export interface RouteBaseline {
  method: string;
  path: string;
  /**
   * Materialized windows since the route first appeared (zero-traffic windows
   * have no row but still count for traffic).
   */
  span: number;
  rps: Moments;
  errorRate: Moments;
  p95: Moments;
}

export interface CurrentWindow {
  method: string;
  path: string;
  requests: number;
  serverErrors: number;
  p95Ms: number | null;
}

export interface Finding {
  method: string;
  path: string;
  metric: AnomalyMetric;
  direction: AnomalyDirection;
  baseline: { mean: number; stddev: number; windows: number };
  current: number;
  zScore: number;
  requests: number;
}

export function stats(moments: Moments, count = moments.n) {
  if (count < 1) return { mean: 0, stddev: 0 };
  const mean = moments.sum / count;
  const variance =
    count > 1
      ? Math.max(0, (moments.sumSq - count * mean * mean) / (count - 1))
      : 0;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Scores one route's 5-minute current window against its baseline. Floors on
 * the standard deviation and on the absolute change keep near-constant
 * baselines and tiny shifts from alerting.
 */
export function scoreRoute(
  current: CurrentWindow | undefined,
  baseline: RouteBaseline,
  settings: { zThreshold: number; minRequests: number },
): Finding[] {
  const findings: Finding[] = [];
  const requests = current?.requests ?? 0;
  const base = {
    method: baseline.method,
    path: baseline.path,
    requests,
  };
  const threshold = settings.zThreshold;

  // Traffic: zero-filled over every window since the route first appeared.
  if (baseline.span >= ANOMALY_MIN_BASELINE_WINDOWS) {
    const { mean, stddev } = stats(baseline.rps, baseline.span);
    const rps = requests / (ANOMALY_CURRENT_MINUTES * 60);
    const z = (rps - mean) / Math.max(stddev, mean * 0.05, 0.01);
    const expected = mean * ANOMALY_CURRENT_MINUTES * 60;
    if (z >= threshold && rps >= mean * 1.5 && requests >= settings.minRequests)
      findings.push({
        ...base,
        metric: 'rps',
        direction: 'up',
        baseline: { mean, stddev, windows: baseline.span },
        current: rps,
        zScore: z,
      });
    else if (
      z <= -threshold &&
      rps <= mean * 0.5 &&
      expected >= settings.minRequests
    )
      findings.push({
        ...base,
        metric: 'rps',
        direction: 'down',
        baseline: { mean, stddev, windows: baseline.span },
        current: rps,
        zScore: z,
      });
  }
  if (!current || requests < settings.minRequests) return findings;

  if (baseline.errorRate.n >= ANOMALY_MIN_BASELINE_WINDOWS) {
    const { mean, stddev } = stats(baseline.errorRate);
    const rate = current.serverErrors / requests;
    const z = (rate - mean) / Math.max(stddev, mean * 0.1, 0.005);
    if (z >= threshold && rate - mean >= 0.02)
      findings.push({
        ...base,
        metric: 'error_rate',
        direction: 'up',
        baseline: { mean, stddev, windows: baseline.errorRate.n },
        current: rate,
        zScore: z,
      });
  }
  if (
    baseline.p95.n >= ANOMALY_MIN_BASELINE_WINDOWS &&
    current.p95Ms !== null
  ) {
    const { mean, stddev } = stats(baseline.p95);
    const z = (current.p95Ms - mean) / Math.max(stddev, mean * 0.05, 2);
    if (z >= threshold && current.p95Ms - mean >= Math.max(20, mean * 0.25))
      findings.push({
        ...base,
        metric: 'p95_latency_ms',
        direction: 'up',
        baseline: { mean, stddev, windows: baseline.p95.n },
        current: current.p95Ms,
        zScore: z,
      });
  }
  return findings;
}

/** Start of the 15-minute window containing `time`, on UTC boundaries. */
export function windowStart(time: Date): Date {
  const size = ANOMALY_WINDOW_MINUTES * 60000;
  return new Date(Math.floor(time.getTime() / size) * size);
}
