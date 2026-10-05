export const DEFAULT_METRIC_REPORTING = {
  intervalMs: 1000,
  maxBufferedBytes: 65536,
};
export type MetricReportingSettings = typeof DEFAULT_METRIC_REPORTING;
export const DEFAULT_TRACING = {
  enabled: true,
  sampleRate: 0.1,
  maxActiveSpans: 1024,
  maxQueuedSpans: 512,
  maxQueueBytes: 1048576,
  maxBatchSpans: 32,
  maxBatchBytes: 65536,
  flushIntervalMs: 1000,
  maxBufferedBytes: 131072,
};
export type TracingSettings = typeof DEFAULT_TRACING;
import {
  MAX_TENANT_CA_BUNDLE_BYTES,
  MAX_TENANT_CA_CERTIFICATES,
} from '@api-gateway/shared-types';
export const DEFAULT_LOAD_BALANCER = {
  maxServices: 1024,
  maxTargetsPerService: 256,
  maxActiveReservations: 4096,
};
export type LoadBalancerSettings = typeof DEFAULT_LOAD_BALANCER;

export const DEFAULT_PROXY_HANDLERS = { maxCacheEntries: 256 };

export const DEFAULT_HTTP2 = {
  maxTargets: 64,
  maxSessions: 64,
  maxSessionsPerTarget: 10,
  maxStreamsPerSession: 100,
  maxActiveRequests: 64,
  maxResponseBytes: 4194304,
  maxHeaderBytes: 16384,
  connectTimeoutMs: 5000,
  idleTimeoutMs: 30000,
};
export type Http2Settings = typeof DEFAULT_HTTP2;

export const DEFAULT_UPSTREAM_HEALTH = {
  defaultIntervalMs: 10000,
  failureThreshold: 3,
  recoveryThreshold: 2,
  probeTimeoutMs: 3000,
  concurrency: 8,
  schedulerIntervalMs: 250,
  telemetryIntervalMs: 5000,
  grpcMaxResponseBytes: 4096,
};
export type UpstreamHealthSettings = typeof DEFAULT_UPSTREAM_HEALTH;

export const DEFAULT_GRPC = {
  enabled: false,
  allowInsecure: false,
  host: '127.0.0.1',
  port: 50051,
  maxMessageBytes: 4 * 1024 * 1024,
  maxHeaderBytes: 16384,
  maxConcurrentStreams: 100,
  maxSessionsPerTarget: 4,
  maxActiveCalls: 256,
  deadlineMs: 30000,
  idleTimeoutMs: 30000,
  shutdownGraceMs: 5000,
};
export type GrpcSettings = typeof DEFAULT_GRPC & {
  handshakeTimeoutMs?: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  clientCaFile?: string;
  crlFile?: string;
};

export const DEFAULT_WEBSOCKET = {
  allowQueryToken: false,
  handshakeTimeoutMs: 5000,
  maxConnections: 256,
  maxHeaderBytes: 16384,
  maxBufferedHeadBytes: 65536,
  idleTimeoutMs: 300000,
  shutdownGraceMs: 5000,
};
export type WebSocketSettings = typeof DEFAULT_WEBSOCKET;

export const DEFAULT_BODY_CAPTURE = {
  maxBodyBytes: 16777216,
  timeoutMs: 5000,
  maxPendingRequests: 64,
};
export type BodyCaptureSettings = typeof DEFAULT_BODY_CAPTURE;

export const DEFAULT_GRAPHQL = {
  maxDepth: 10,
  maxComplexity: 1000,
  maxQueryBytes: 65536,
  maxTokens: 10000,
  maxLexicalDepth: 128,
  maxBodyBytes: 1048576,
  bodyTimeoutMs: 5000,
  maxPendingRequests: 32,
};
export type GraphqlSettings = typeof DEFAULT_GRAPHQL;

export const DEFAULT_HMAC = {
  maxBodyBytes: 1048576,
  bodyTimeoutMs: 5000,
  maxPendingRequests: 32,
  maxHeaderBytes: 4096,
  maxSignatures: 8,
  clockSkewSeconds: 300,
};
export type HmacSettings = typeof DEFAULT_HMAC;

export const DEFAULT_TLS = { handshakeTimeoutMs: 10000, maxConnections: 1024 };
export const DEFAULT_MTLS = {
  maxCertificateBytes: 16384,
  maxCaBundleBytes: MAX_TENANT_CA_BUNDLE_BYTES,
  maxChainDepth: MAX_TENANT_CA_CERTIFICATES,
  maxIdentityBytes: 4096,
};
export type MtlsSettings = typeof DEFAULT_MTLS & {
  trustedProxyCidrs: string[];
};
export interface ListenerTlsSettings {
  handshakeTimeoutMs?: number;
  maxConnections?: number;
  certFile?: string;
  keyFile?: string;
  clientCaFile?: string;
  crlFile?: string;
}

export const DEFAULT_IDENTITY_PROVIDER = {
  allowInsecureHttp: false,
  timeoutMs: 5000,
  maxResponseBytes: 262144,
  maxHeaderBytes: 16384,
  maxTokenBytes: 16384,
  maxPendingRequests: 128,
  maxConcurrentFetches: 16,
  maxCacheEntries: 128,
  maxJwksKeys: 64,
  jwksCacheTtlMs: 300000,
  jwksRefreshCooldownMs: 30000,
  introspectionCacheTtlMs: 30000,
  outboundCacheTtlMs: 3600000,
};
export type IdentityProviderSettings = typeof DEFAULT_IDENTITY_PROVIDER;

export interface ProxyServiceConfig {
  name: string;
  targetUrl: string;
  pathPrefix: string;
}

export interface GatewayConfig {
  port: number;
  trustedProxies?: string[];
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
  };
  proxy: {
    timeout: number;
    services: ProxyServiceConfig[];
    maxHandlerCacheEntries: number;
  };
  upstreamHealth: UpstreamHealthSettings;
  grpc: GrpcSettings;
  websocket: WebSocketSettings;
  identityProvider: IdentityProviderSettings;
  mtls: MtlsSettings;
  hmac: HmacSettings;
  graphql: GraphqlSettings;
  bodyCapture: BodyCaptureSettings;
  http2: Http2Settings;
  loadBalancer: LoadBalancerSettings;
  metricReporting: MetricReportingSettings;
  tracing: TracingSettings;
  tls: ListenerTlsSettings;
  rateLimit: {
    windowMs: number;
    unauthMax: number;
    authMax: number;
  };
}

const parseProxyServices = (): ProxyServiceConfig[] => {
  const raw = process.env.PROXY_SERVICES ?? '[]';
  const parsed = JSON.parse(raw) as ProxyServiceConfig[];
  if (!Array.isArray(parsed)) {
    throw new Error('PROXY_SERVICES must be a JSON array');
  }
  return parsed;
};

export default (): GatewayConfig => ({
  metricReporting: {
    intervalMs: Number(
      process.env.METRICS_REPORT_INTERVAL_MS ??
        DEFAULT_METRIC_REPORTING.intervalMs,
    ),
    maxBufferedBytes: Number(
      process.env.METRICS_REPORT_MAX_BUFFERED_BYTES ??
        DEFAULT_METRIC_REPORTING.maxBufferedBytes,
    ),
  },
  tracing: {
    enabled:
      process.env.TRACING_ENABLED === undefined
        ? DEFAULT_TRACING.enabled
        : process.env.TRACING_ENABLED.toLowerCase() !== 'false',
    sampleRate: Number(
      process.env.TRACING_SAMPLE_RATE ?? DEFAULT_TRACING.sampleRate,
    ),
    maxActiveSpans: Number(
      process.env.TRACING_MAX_ACTIVE_SPANS ?? DEFAULT_TRACING.maxActiveSpans,
    ),
    maxQueuedSpans: Number(
      process.env.TRACING_MAX_QUEUED_SPANS ?? DEFAULT_TRACING.maxQueuedSpans,
    ),
    maxQueueBytes: Number(
      process.env.TRACING_MAX_QUEUE_BYTES ?? DEFAULT_TRACING.maxQueueBytes,
    ),
    maxBatchSpans: Number(
      process.env.TRACING_MAX_BATCH_SPANS ?? DEFAULT_TRACING.maxBatchSpans,
    ),
    maxBatchBytes: Number(
      process.env.TRACING_MAX_BATCH_BYTES ?? DEFAULT_TRACING.maxBatchBytes,
    ),
    flushIntervalMs: Number(
      process.env.TRACING_FLUSH_INTERVAL_MS ?? DEFAULT_TRACING.flushIntervalMs,
    ),
    maxBufferedBytes: Number(
      process.env.TRACING_MAX_BUFFERED_BYTES ??
        DEFAULT_TRACING.maxBufferedBytes,
    ),
  },

  loadBalancer: {
    maxServices: Number(
      process.env.LOAD_BALANCER_MAX_SERVICES ??
        DEFAULT_LOAD_BALANCER.maxServices,
    ),
    maxTargetsPerService: Number(
      process.env.LOAD_BALANCER_MAX_TARGETS_PER_SERVICE ??
        DEFAULT_LOAD_BALANCER.maxTargetsPerService,
    ),
    maxActiveReservations: Number(
      process.env.LOAD_BALANCER_MAX_ACTIVE_RESERVATIONS ??
        DEFAULT_LOAD_BALANCER.maxActiveReservations,
    ),
  },
  http2: {
    maxTargets: Number(
      process.env.HTTP2_MAX_TARGETS ?? DEFAULT_HTTP2.maxTargets,
    ),
    maxSessions: Number(
      process.env.HTTP2_MAX_SESSIONS ?? DEFAULT_HTTP2.maxSessions,
    ),
    maxSessionsPerTarget: Number(
      process.env.HTTP2_MAX_SESSIONS_PER_TARGET ??
        DEFAULT_HTTP2.maxSessionsPerTarget,
    ),
    maxStreamsPerSession: Number(
      process.env.HTTP2_MAX_STREAMS_PER_SESSION ??
        DEFAULT_HTTP2.maxStreamsPerSession,
    ),
    maxActiveRequests: Number(
      process.env.HTTP2_MAX_ACTIVE_REQUESTS ?? DEFAULT_HTTP2.maxActiveRequests,
    ),
    maxResponseBytes: Number(
      process.env.HTTP2_MAX_RESPONSE_BYTES ?? DEFAULT_HTTP2.maxResponseBytes,
    ),
    maxHeaderBytes: Number(
      process.env.HTTP2_MAX_HEADER_BYTES ?? DEFAULT_HTTP2.maxHeaderBytes,
    ),
    connectTimeoutMs: Number(
      process.env.HTTP2_CONNECT_TIMEOUT_MS ?? DEFAULT_HTTP2.connectTimeoutMs,
    ),
    idleTimeoutMs: Number(
      process.env.HTTP2_IDLE_TIMEOUT_MS ?? DEFAULT_HTTP2.idleTimeoutMs,
    ),
  },
  tls: {
    handshakeTimeoutMs: Number(
      process.env.TLS_HANDSHAKE_TIMEOUT_MS ?? DEFAULT_TLS.handshakeTimeoutMs,
    ),
    maxConnections: Number(
      process.env.HTTP_TLS_MAX_CONNECTIONS ?? DEFAULT_TLS.maxConnections,
    ),
    certFile: process.env.HTTP_TLS_CERT_FILE,
    keyFile: process.env.HTTP_TLS_KEY_FILE,
    clientCaFile: process.env.HTTP_TLS_CLIENT_CA_FILE,
    crlFile: process.env.HTTP_TLS_CRL_FILE,
  },
  bodyCapture: {
    maxBodyBytes: Number(
      process.env.BODY_CAPTURE_MAX_BODY_BYTES ??
        DEFAULT_BODY_CAPTURE.maxBodyBytes,
    ),
    timeoutMs: Number(
      process.env.BODY_CAPTURE_TIMEOUT_MS ?? DEFAULT_BODY_CAPTURE.timeoutMs,
    ),
    maxPendingRequests: Number(
      process.env.BODY_CAPTURE_MAX_PENDING_REQUESTS ??
        DEFAULT_BODY_CAPTURE.maxPendingRequests,
    ),
  },
  graphql: {
    ...DEFAULT_GRAPHQL,
    maxQueryBytes: Number(
      process.env.GRAPHQL_MAX_QUERY_BYTES ?? DEFAULT_GRAPHQL.maxQueryBytes,
    ),
    maxTokens: Number(
      process.env.GRAPHQL_MAX_TOKENS ?? DEFAULT_GRAPHQL.maxTokens,
    ),
    maxLexicalDepth: Number(
      process.env.GRAPHQL_MAX_LEXICAL_DEPTH ?? DEFAULT_GRAPHQL.maxLexicalDepth,
    ),
    maxBodyBytes: Number(
      process.env.GRAPHQL_MAX_BODY_BYTES ?? DEFAULT_GRAPHQL.maxBodyBytes,
    ),
    bodyTimeoutMs: Number(
      process.env.GRAPHQL_BODY_TIMEOUT_MS ?? DEFAULT_GRAPHQL.bodyTimeoutMs,
    ),
    maxPendingRequests: Number(
      process.env.GRAPHQL_MAX_PENDING_REQUESTS ??
        DEFAULT_GRAPHQL.maxPendingRequests,
    ),
  },
  hmac: {
    ...DEFAULT_HMAC,
    maxBodyBytes: Number(
      process.env.HMAC_MAX_BODY_BYTES ?? DEFAULT_HMAC.maxBodyBytes,
    ),
    bodyTimeoutMs: Number(
      process.env.HMAC_BODY_TIMEOUT_MS ?? DEFAULT_HMAC.bodyTimeoutMs,
    ),
    maxPendingRequests: Number(
      process.env.HMAC_MAX_PENDING_REQUESTS ?? DEFAULT_HMAC.maxPendingRequests,
    ),
    maxHeaderBytes: Number(
      process.env.HMAC_MAX_HEADER_BYTES ?? DEFAULT_HMAC.maxHeaderBytes,
    ),
  },
  mtls: {
    maxCertificateBytes: Number(
      process.env.MTLS_MAX_CERTIFICATE_BYTES ??
        DEFAULT_MTLS.maxCertificateBytes,
    ),
    maxCaBundleBytes: Number(
      process.env.MTLS_MAX_CA_BUNDLE_BYTES ?? DEFAULT_MTLS.maxCaBundleBytes,
    ),
    maxChainDepth: Number(
      process.env.MTLS_MAX_CHAIN_DEPTH ?? DEFAULT_MTLS.maxChainDepth,
    ),
    maxIdentityBytes: Number(
      process.env.MTLS_MAX_IDENTITY_BYTES ?? DEFAULT_MTLS.maxIdentityBytes,
    ),
    trustedProxyCidrs: (process.env.MTLS_TRUSTED_PROXY_CIDRS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  },
  port: parseInt(process.env.PORT ?? '3000', 10) || 3000,
  trustedProxies: (process.env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  redis: {
    url: process.env.REDIS_URL ?? '',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
  },
  proxy: {
    maxHandlerCacheEntries: Number(
      process.env.PROXY_MAX_HANDLER_CACHE_ENTRIES ??
        DEFAULT_PROXY_HANDLERS.maxCacheEntries,
    ),
    timeout: parseInt(process.env.PROXY_TIMEOUT_MS ?? '10000', 10) || 10000,
    services: parseProxyServices(),
  },
  grpc: {
    enabled: process.env.GRPC_ENABLED === 'true',
    allowInsecure: process.env.GRPC_ALLOW_INSECURE === 'true',
    host: process.env.GRPC_HOST ?? DEFAULT_GRPC.host,
    port: Number(process.env.GRPC_PORT ?? DEFAULT_GRPC.port),
    handshakeTimeoutMs: Number(
      process.env.TLS_HANDSHAKE_TIMEOUT_MS ?? DEFAULT_TLS.handshakeTimeoutMs,
    ),
    tlsCertFile: process.env.GRPC_TLS_CERT_FILE || undefined,
    tlsKeyFile: process.env.GRPC_TLS_KEY_FILE || undefined,
    clientCaFile: process.env.GRPC_TLS_CLIENT_CA_FILE || undefined,
    crlFile: process.env.GRPC_TLS_CRL_FILE || undefined,
    maxMessageBytes: Number(
      process.env.GRPC_MAX_MESSAGE_BYTES ?? DEFAULT_GRPC.maxMessageBytes,
    ),
    maxHeaderBytes: Number(
      process.env.GRPC_MAX_HEADER_BYTES ?? DEFAULT_GRPC.maxHeaderBytes,
    ),
    maxConcurrentStreams: Number(
      process.env.GRPC_MAX_CONCURRENT_STREAMS ??
        DEFAULT_GRPC.maxConcurrentStreams,
    ),
    maxSessionsPerTarget: Number(
      process.env.GRPC_MAX_SESSIONS_PER_TARGET ??
        DEFAULT_GRPC.maxSessionsPerTarget,
    ),
    maxActiveCalls: Number(
      process.env.GRPC_MAX_ACTIVE_CALLS ?? DEFAULT_GRPC.maxActiveCalls,
    ),
    deadlineMs: Number(process.env.GRPC_DEADLINE_MS ?? DEFAULT_GRPC.deadlineMs),
    idleTimeoutMs: Number(
      process.env.GRPC_IDLE_TIMEOUT_MS ?? DEFAULT_GRPC.idleTimeoutMs,
    ),
    shutdownGraceMs: Number(
      process.env.GRPC_SHUTDOWN_GRACE_MS ?? DEFAULT_GRPC.shutdownGraceMs,
    ),
  },
  websocket: {
    allowQueryToken: process.env.WS_ALLOW_QUERY_TOKEN === 'true',
    handshakeTimeoutMs: Number(
      process.env.WS_HANDSHAKE_TIMEOUT_MS ??
        DEFAULT_WEBSOCKET.handshakeTimeoutMs,
    ),
    maxConnections: Number(
      process.env.WS_MAX_CONNECTIONS ?? DEFAULT_WEBSOCKET.maxConnections,
    ),
    maxHeaderBytes: Number(
      process.env.WS_MAX_HEADER_BYTES ?? DEFAULT_WEBSOCKET.maxHeaderBytes,
    ),
    maxBufferedHeadBytes: Number(
      process.env.WS_MAX_BUFFERED_HEAD_BYTES ??
        DEFAULT_WEBSOCKET.maxBufferedHeadBytes,
    ),
    idleTimeoutMs: Number(
      process.env.WS_IDLE_TIMEOUT_MS ?? DEFAULT_WEBSOCKET.idleTimeoutMs,
    ),
    shutdownGraceMs: Number(
      process.env.WS_SHUTDOWN_GRACE_MS ?? DEFAULT_WEBSOCKET.shutdownGraceMs,
    ),
  },
  identityProvider: {
    allowInsecureHttp:
      process.env.IDENTITY_PROVIDER_ALLOW_INSECURE_HTTP === 'true',
    timeoutMs: Number(
      process.env.IDENTITY_PROVIDER_TIMEOUT_MS ??
        DEFAULT_IDENTITY_PROVIDER.timeoutMs,
    ),
    maxResponseBytes: Number(
      process.env.IDENTITY_PROVIDER_MAX_RESPONSE_BYTES ??
        DEFAULT_IDENTITY_PROVIDER.maxResponseBytes,
    ),
    maxHeaderBytes: Number(
      process.env.IDENTITY_PROVIDER_MAX_HEADER_BYTES ??
        DEFAULT_IDENTITY_PROVIDER.maxHeaderBytes,
    ),
    maxTokenBytes: Number(
      process.env.IDENTITY_PROVIDER_MAX_TOKEN_BYTES ??
        DEFAULT_IDENTITY_PROVIDER.maxTokenBytes,
    ),
    maxPendingRequests: Number(
      process.env.IDENTITY_PROVIDER_MAX_PENDING_REQUESTS ??
        DEFAULT_IDENTITY_PROVIDER.maxPendingRequests,
    ),
    maxConcurrentFetches: Number(
      process.env.IDENTITY_PROVIDER_MAX_CONCURRENT_FETCHES ??
        DEFAULT_IDENTITY_PROVIDER.maxConcurrentFetches,
    ),
    maxCacheEntries: Number(
      process.env.IDENTITY_PROVIDER_MAX_CACHE_ENTRIES ??
        DEFAULT_IDENTITY_PROVIDER.maxCacheEntries,
    ),
    maxJwksKeys: Number(
      process.env.IDENTITY_PROVIDER_MAX_JWKS_KEYS ??
        DEFAULT_IDENTITY_PROVIDER.maxJwksKeys,
    ),
    jwksCacheTtlMs: Number(
      process.env.IDENTITY_PROVIDER_JWKS_CACHE_TTL_MS ??
        DEFAULT_IDENTITY_PROVIDER.jwksCacheTtlMs,
    ),
    jwksRefreshCooldownMs: Number(
      process.env.IDENTITY_PROVIDER_JWKS_REFRESH_COOLDOWN_MS ??
        DEFAULT_IDENTITY_PROVIDER.jwksRefreshCooldownMs,
    ),
    introspectionCacheTtlMs: Number(
      process.env.IDENTITY_PROVIDER_INTROSPECTION_CACHE_TTL_MS ??
        DEFAULT_IDENTITY_PROVIDER.introspectionCacheTtlMs,
    ),
    outboundCacheTtlMs: Number(
      process.env.IDENTITY_PROVIDER_OUTBOUND_CACHE_TTL_MS ??
        DEFAULT_IDENTITY_PROVIDER.outboundCacheTtlMs,
    ),
  },
  upstreamHealth: {
    defaultIntervalMs: Number(
      process.env.HEALTH_DEFAULT_INTERVAL_MS ??
        DEFAULT_UPSTREAM_HEALTH.defaultIntervalMs,
    ),
    failureThreshold: Number(
      process.env.HEALTH_FAILURE_THRESHOLD ??
        DEFAULT_UPSTREAM_HEALTH.failureThreshold,
    ),
    recoveryThreshold: Number(
      process.env.HEALTH_RECOVERY_THRESHOLD ??
        DEFAULT_UPSTREAM_HEALTH.recoveryThreshold,
    ),
    probeTimeoutMs: Number(
      process.env.HEALTH_PROBE_TIMEOUT_MS ??
        DEFAULT_UPSTREAM_HEALTH.probeTimeoutMs,
    ),
    concurrency: Number(
      process.env.HEALTH_PROBE_CONCURRENCY ??
        DEFAULT_UPSTREAM_HEALTH.concurrency,
    ),
    schedulerIntervalMs: DEFAULT_UPSTREAM_HEALTH.schedulerIntervalMs,
    telemetryIntervalMs: DEFAULT_UPSTREAM_HEALTH.telemetryIntervalMs,
    grpcMaxResponseBytes: DEFAULT_UPSTREAM_HEALTH.grpcMaxResponseBytes,
  },
  rateLimit: {
    windowMs:
      parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10) || 60000,
    unauthMax: parseInt(process.env.RATE_LIMIT_UNAUTH_MAX ?? '100', 10) || 100,
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? '500', 10) || 500,
  },
});
