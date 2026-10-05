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

export interface MetricsMessage extends BaseWsMessage {
  type: 'metrics';
  payload: {
    rps: number;
    p50: number;
    p95: number;
    p99: number;
    errorRate: number;
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
