import type { GraphqlPolicy } from './ws-messages.ts';
export interface TenantEntity {
  id: string;
  name: string;
  email: string;
  planId: string;
  gatewayConfigVersion: number;
  lastSeen?: string;
  createdAt: string;
  caCertPem?: string;
}

export interface ApiKeyEntity {
  id: string;
  tenantId: string;
  keyHash: string;
  label: string;
  revokedAt?: string;
  createdAt: string;
}

export interface RouteEntity {
  id: string;
  tenantId: string;
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
  graphql?: GraphqlPolicy | null;
  plugins?: Array<{ name: string; config: Record<string, unknown> }>;
  acl?: {
    allow?: string[];
    deny?: string[];
  };
  createdAt: string;
  deletedAt?: string;
}

export interface ServiceEntity {
  id: string;
  tenantId: string;
  name: string;
  targets: Array<{ url: string; weight: number }>;
  healthCheckPath: string;
  healthCheckIntervalMs?: number;
  healthCheckProtocol?: 'http' | 'grpc';
  healthCheckService?: string;
  unhealthyFallback?: boolean;
  loadBalancing?: 'weighted-round-robin' | 'least-connections';
  h2?: boolean;
  supportsWebSocket?: boolean;
  timeoutMs: number;
  createdAt: string;
  deletedAt?: string;
}

export interface ConsumerEntity {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  rateLimitTier: string;
  groups?: string[];
  createdAt: string;
  revokedAt?: string;
}

export interface PendingConfigUpdateEntity {
  id: string;
  tenantId: string;
  config: any;
  updatedAt: string;
}

/** Analytics over persisted request logs, not guaranteed gateway traffic metering. */
export const CONSUMER_ANALYTICS_ROW_LIMIT = 100000;
export type ConsumerAnalyticsPeriod = '1h' | '24h' | '7d';
export interface ConsumerUsageCounts {
  requests: number;
  serverErrors: number;
  errorRate: number;
  rps: number;
  latencySamples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}
export interface ConsumerUsageBucket extends ConsumerUsageCounts {
  timestamp: string;
}
export interface ConsumerUsagePath extends ConsumerUsageCounts {
  method: string;
  /** Query strings removed; paths longer than 512 characters grouped by prefix. */
  path: string;
}
export interface ConsumerUsageStats extends ConsumerUsageCounts {
  privacy?: import('./log-privacy.ts').LogPrivacyCoverage;
  retention?: import('./log-retention.ts').LogRetentionCoverage;
  consumer: { id: string; name: string; revokedAt: string | null };
  period: ConsumerAnalyticsPeriod;
  from: string;
  to: string;
  generatedAt: string;
  source: 'persisted_request_logs';
  bucketSeconds: number;
  rowLimit: number;
  series: ConsumerUsageBucket[];
  topPaths: ConsumerUsagePath[];
}
