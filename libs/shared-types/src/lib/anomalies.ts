/**
 * Statistical per-route anomaly detection (roadmap 6.1). Baselines are 15-minute
 * windows of received request logs per route (method and normalized path),
 * retained for 7 days. A rolling 5-minute current window is scored as a
 * z-score against them. No model is trained.
 */
export const ANOMALY_METRICS = ['error_rate', 'p95_latency_ms', 'rps'] as const;
export type AnomalyMetric = (typeof ANOMALY_METRICS)[number];
export type AnomalyDirection = 'up' | 'down';

export const ANOMALY_WINDOW_MINUTES = 15;
export const ANOMALY_CURRENT_MINUTES = 5;
export const ANOMALY_BASELINE_DAYS = 7;
/** Completed windows a route needs before it can be scored. */
export const ANOMALY_MIN_BASELINE_WINDOWS = 4;

export const ANOMALY_LIMITS = {
  zThreshold: [2, 10],
  minRequests: [5, 100000],
} as const;
export const MAX_ANOMALY_CHANNELS = 5;

export interface AnomalyBaseline {
  mean: number;
  stddev: number;
  /** Completed 15-minute windows the baseline was computed from. */
  windows: number;
}

export interface Anomaly {
  id: string;
  method: string;
  path: string;
  metric: AnomalyMetric;
  direction: AnomalyDirection;
  baseline: AnomalyBaseline;
  /** Latest value of the 5-minute current window. */
  current: number;
  zScore: number;
  requests: number;
  state: 'active' | 'resolved';
  startedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** Human-readable description, e.g. for the feed and notifications. */
  summary: string;
}

export interface AnomalySettings {
  /** Detection runs only while enabled; the feed keeps its history. */
  enabled: boolean;
  /** Absolute z-score at or above which a route is anomalous. */
  zThreshold: number;
  /** Fewest requests in the current window before a route is scored. */
  minRequests: number;
  /** Alert channels notified when an anomaly starts and resolves. */
  channelIds: string[];
  revision: number;
}
export interface SaveAnomalySettings {
  enabled: boolean;
  zThreshold: number;
  minRequests: number;
  channelIds: string[];
  expectedRevision: number;
}

export const DEFAULT_ANOMALY_SETTINGS: Omit<AnomalySettings, 'revision'> = {
  enabled: true,
  zThreshold: 3,
  minRequests: 20,
  channelIds: [],
};

/** Description attached to anomaly alert events and webhook payloads. */
export interface AlertAnomalyDetail {
  id: string;
  method: string;
  path: string;
  direction: AnomalyDirection;
  baseline: number;
  zScore: number;
  summary: string;
}

const LABELS: Record<AnomalyMetric, string> = {
  error_rate: '5xx rate',
  p95_latency_ms: 'p95 latency',
  rps: 'traffic',
};

/** Formats a metric value the way the feed and notifications show it. */
export function formatAnomalyValue(metric: AnomalyMetric, value: number) {
  if (metric === 'error_rate')
    return `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;
  if (metric === 'p95_latency_ms') return `${Math.round(value)} ms`;
  return `${value < 10 ? value.toFixed(2) : Math.round(value)} req/s`;
}

/**
 * "Unusual 800% rise in p95 latency on GET /api/orders: baseline 42 ms,
 * current 380 ms".
 */
export function describeAnomaly(anomaly: {
  method: string;
  path: string;
  metric: AnomalyMetric;
  direction: AnomalyDirection;
  baseline: { mean: number };
  current: number;
}): string {
  const { mean } = anomaly.baseline;
  const change =
    mean > 0
      ? `${Math.round((Math.abs(anomaly.current - mean) / mean) * 100)}% `
      : '';
  return `Unusual ${change}${anomaly.direction === 'up' ? 'rise' : 'drop'} in ${LABELS[anomaly.metric]} on ${anomaly.method} ${anomaly.path}: baseline ${formatAnomalyValue(anomaly.metric, mean)}, current ${formatAnomalyValue(anomaly.metric, anomaly.current)}`;
}
