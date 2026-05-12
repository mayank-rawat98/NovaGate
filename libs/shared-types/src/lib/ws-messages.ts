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
  maxBodyBytes?: number;
  cors?: {
    origins: string[];
    methods?: string[];
    headers?: string[];
    credentials?: boolean;
    maxAge?: number;
  };
  ipRestriction?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface ServiceTarget {
  url: string;
  weight: number;
}

export interface ServiceConfig {
  id: string;
  name: string;
  targets: ServiceTarget[];
  healthCheckPath: string;
  timeoutMs: number;
}

export interface ConsumerConfig {
  id: string;
  name: string;
  keyHash: string;
  rateLimitTier: 'unauthenticated' | 'authenticated' | string;
}

export interface RequestLog {
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
  status: 'healthy' | 'unhealthy' | 'unknown';
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
