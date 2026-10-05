export type WsMessageType =
  | 'auth'
  | 'auth_ok'
  | 'ping'
  | 'pong'
  | 'config.update'
  | 'config.ack'
  | 'config.request'
  | 'logs'
  | 'health'
  | 'errors'
  | 'metrics'
  | 'traces'
  | 'ack';

export interface BaseWsMessage {
  type: WsMessageType;
  id?: string;
  payload?: any;
}

export interface AuthMessage extends BaseWsMessage {
  type: 'auth';
  payload: {
    apiKey: string;
  };
}

export interface AuthOkMessage extends BaseWsMessage {
  type: 'auth_ok';
  payload: {
    tenantId: string;
    config: TenantConfig;
    configVersion: number;
  };
}

export interface PingMessage extends BaseWsMessage {
  type: 'ping';
}

export interface PongMessage extends BaseWsMessage {
  type: 'pong';
}

export interface ConfigUpdateMessage extends BaseWsMessage {
  type: 'config.update';
  payload: TenantConfig;
  version: number;
}

export interface ConfigAckMessage extends BaseWsMessage {
  type: 'config.ack';
  version: number;
}

export interface ConfigRequestMessage extends BaseWsMessage {
  type: 'config.request';
}

export interface LogsMessage extends BaseWsMessage {
  type: 'logs';
  payload: RequestLog[];
}

export const MAX_TRACE_BATCH_SPANS = 128;
export const MAX_TRACE_BATCH_BYTES = 65536;
export const MAX_TRACE_SPAN_BYTES = 8192;
export const MAX_TRACE_ATTRIBUTES = 16;
export const MAX_TRACE_ATTRIBUTE_BYTES = 256;
export const TRACE_ATTRIBUTE_KEYS = [
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'gateway.route.id',
  'gateway.service.id',
  'gateway.retry.count',
  'gateway.protocol',
  'gateway.request.id',
  'gateway.incomplete',
  'rpc.system.name',
  'rpc.service',
  'rpc.method',
  'rpc.grpc.status_code',
] as const;
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'server' | 'client' | 'internal';
  timestamp: string;
  durationMs: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
}
export interface TracesMessage extends BaseWsMessage {
  type: 'traces';
  payload: TraceSpan[];
}

export interface HealthMessage extends BaseWsMessage {
  type: 'health';
  payload: HealthSnapshot[];
}

export interface ErrorsMessage extends BaseWsMessage {
  type: 'errors';
  id: string; // Errors require IDs for ACKs
  payload: ErrorEvent[];
}

export interface MetricsSnapshot {
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
  timestamp: string;
}
export const MAX_METRIC_RATE = 1000000000;
export const MAX_METRIC_LATENCY_MS = 3600000;
export const MAX_METRIC_WINDOW_MS = 60000;
export const METRIC_LATENCY_BUCKETS = [
  0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
  300000, 3600000,
] as const;

/** Counts for one completed reporting interval; absent on legacy reports. */
export interface MetricWindow {
  windowMs: number;
  requestCount: number;
  errorCount: number;
  timeoutCount: number;
  latencyCounts: number[];
}
export interface MetricReportSnapshot extends MetricsSnapshot {
  window: MetricWindow;
}
export function metricPercentile(
  counts: readonly number[],
  requestCount: number,
  percentile: 0.5 | 0.95 | 0.99,
): number {
  if (!requestCount) return 0;
  const rank = Math.ceil(requestCount * percentile);
  let cumulative = 0;
  for (let i = 0; i < METRIC_LATENCY_BUCKETS.length; i++) {
    cumulative += counts[i];
    if (cumulative >= rank) return METRIC_LATENCY_BUCKETS[i];
  }
  return MAX_METRIC_LATENCY_MS;
}
export function validateMetricWindow(input: unknown): MetricWindow {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid metric window');
  const value = input as Record<string, unknown>;
  const fields = [
    'windowMs',
    'requestCount',
    'errorCount',
    'timeoutCount',
    'latencyCounts',
  ];
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error('Invalid metric window');
  const { windowMs, requestCount, errorCount, timeoutCount, latencyCounts } =
    value;
  if (
    typeof windowMs !== 'number' ||
    !Number.isFinite(windowMs) ||
    windowMs < 1 ||
    windowMs > MAX_METRIC_WINDOW_MS
  )
    throw new Error('Invalid metric window duration');
  if (
    [requestCount, errorCount, timeoutCount].some(
      (count) =>
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > MAX_METRIC_RATE,
    )
  )
    throw new Error('Invalid metric window count');
  const requests = requestCount as number;
  const errors = errorCount as number;
  const timeouts = timeoutCount as number;
  if (
    errors > requests ||
    timeouts > errors ||
    !Array.isArray(latencyCounts) ||
    latencyCounts.length !== METRIC_LATENCY_BUCKETS.length ||
    Array.from(latencyCounts).some(
      (count) =>
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > MAX_METRIC_RATE,
    ) ||
    latencyCounts.reduce((sum, count) => sum + count, 0) !== requests
  )
    throw new Error('Invalid metric window histogram');
  return {
    windowMs,
    requestCount: requests,
    errorCount: errors,
    timeoutCount: timeouts,
    latencyCounts: [...latencyCounts],
  };
}

export interface MetricsMessage extends BaseWsMessage {
  type: 'metrics';
  payload: {
    rps: number;
    p50: number;
    p95: number;
    p99: number;
    errorRate: number;
    window?: MetricWindow;
  };
}

export function validateMetricPayload(
  payload: unknown,
): MetricsMessage['payload'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid metric snapshot');
  const value = payload as Record<string, unknown>;
  const keys = ['rps', 'p50', 'p95', 'p99', 'errorRate'];
  if (
    Object.keys(value).some((key) => ![...keys, 'window'].includes(key)) ||
    keys.some(
      (key) =>
        typeof value[key] !== 'number' ||
        !Number.isFinite(value[key]) ||
        (value[key] as number) < 0,
    )
  )
    throw new Error('Invalid metric snapshot');
  const window = Object.hasOwn(value, 'window')
    ? validateMetricWindow(value.window)
    : undefined;
  if (window) {
    const expectedRate = Math.min(
      MAX_METRIC_RATE,
      (window.requestCount * 1000) / window.windowMs,
    );
    const expectedErrors = window.requestCount
      ? window.errorCount / window.requestCount
      : 0;
    if (
      Math.abs((value.rps as number) - expectedRate) >
        Number.EPSILON * Math.max(1, expectedRate) * 8 ||
      Math.abs((value.errorRate as number) - expectedErrors) >
        Number.EPSILON * 8 ||
      (value.p50 as number) !==
        metricPercentile(window.latencyCounts, window.requestCount, 0.5) ||
      (value.p95 as number) !==
        metricPercentile(window.latencyCounts, window.requestCount, 0.95) ||
      (value.p99 as number) !==
        metricPercentile(window.latencyCounts, window.requestCount, 0.99)
    )
      throw new Error('Invalid metric window summary');
  }
  if (
    (value.rps as number) > MAX_METRIC_RATE ||
    (value.errorRate as number) > 1 ||
    ['p50', 'p95', 'p99'].some(
      (key) => (value[key] as number) > MAX_METRIC_LATENCY_MS,
    ) ||
    (value.p50 as number) > (value.p95 as number) ||
    (value.p95 as number) > (value.p99 as number)
  )
    throw new Error('Invalid metric snapshot');
  return {
    rps: value.rps as number,
    p50: value.p50 as number,
    p95: value.p95 as number,
    p99: value.p99 as number,
    errorRate: value.errorRate as number,
    ...(window ? { window } : {}),
  };
}

export interface AckMessage extends BaseWsMessage {
  type: 'ack';
  id: string;
}

export interface TenantConfig {
  routes: RouteConfig[];
  services: ServiceConfig[];
  consumers: ConsumerConfig[];
  rateLimit: {
    windowMs: number;
    unauthMax: number;
    authMax: number;
  };
  caCertPem?: string;
}

export const MAX_GRAPHQL_POLICY_DEPTH = 100;
export const MAX_GRAPHQL_POLICY_COMPLEXITY = 100000;
export interface GraphqlPolicy {
  maxDepth?: number;
  maxComplexity?: number;
  introspectionAllowed?: boolean;
}

export interface RouteConfig {
  id: string;
  method: string;
  pathPattern: string;
  serviceId: string;
  authRequired: boolean;
  rateLimitOverride?: number;
  enabled: boolean;
  retry?: {
    attempts: number;
    on: number[];
    methods: string[];
  };
  plugins?: Array<{ name: string; config: Record<string, unknown> }>;
  acl?: {
    allow?: string[];
    deny?: string[];
  };
  graphql?: GraphqlPolicy | null;
}

export const MAX_SERVICE_TARGETS = 256;
export const MAX_SERVICE_TARGET_URL_BYTES = 2048;
export const MAX_SERVICE_TARGET_WEIGHT = 100;

export interface ServiceTarget {
  url: string;
  weight: number;
}

export interface ServiceConfig {
  id: string;
  name: string;
  targets: ServiceTarget[];
  healthCheckPath: string;
  healthCheckIntervalMs?: number;
  healthCheckProtocol?: 'http' | 'grpc';
  healthCheckService?: string;
  unhealthyFallback?: boolean;
  timeoutMs: number;
  supportsWebSocket?: boolean;
  loadBalancing?: 'weighted-round-robin' | 'least-connections';
  h2?: boolean;
}

export interface ConsumerConfig {
  id: string;
  name: string;
  keyHash: string;
  rateLimitTier: 'unauthenticated' | 'authenticated' | string;
  groups?: string[];
}

export interface RequestLog {
  traceId?: string;
  spanId?: string;
  id: string;
  consumerId?: string;
  method: string;
  path: string;
  statusCode: number;
  responseTimeMs: number;
  requestId: string;
  downstreamService?: string;
  downstreamLatencyMs?: number;
  clientIp: string;
  userAgent?: string;
  errorCode?: string;
  timestamp: string;
}

export interface HealthSnapshot {
  serviceId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  checkedAt: string;
  errorMessage?: string;
}

export interface ErrorEvent {
  id: string;
  requestId: string;
  errorCode: string;
  message: string;
  serviceId?: string;
  path?: string;
  statusCode?: number;
  timestamp: string;
}

export interface TraceSummary {
  traceId: string;
  timestamp: string;
  durationMs: number;
  spanCount: number;
  status: TraceSpan['status'];
  route: string;
  requestId?: string;
}
export interface TraceListResponse {
  traces: TraceSummary[];
  nextCursor: string | null;
}
export interface TraceDetailResponse {
  traceId: string;
  spans: TraceSpan[];
  truncated: boolean;
}
