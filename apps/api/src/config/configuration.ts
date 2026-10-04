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
  tlsCertFile?: string;
  tlsKeyFile?: string;
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
  };
  upstreamHealth: UpstreamHealthSettings;
  grpc: GrpcSettings;
  websocket: WebSocketSettings;
  identityProvider: IdentityProviderSettings;
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
    timeout: parseInt(process.env.PROXY_TIMEOUT_MS ?? '10000', 10) || 10000,
    services: parseProxyServices(),
  },
  grpc: {
    enabled: process.env.GRPC_ENABLED === 'true',
    allowInsecure: process.env.GRPC_ALLOW_INSECURE === 'true',
    host: process.env.GRPC_HOST ?? DEFAULT_GRPC.host,
    port: Number(process.env.GRPC_PORT ?? DEFAULT_GRPC.port),
    tlsCertFile: process.env.GRPC_TLS_CERT_FILE || undefined,
    tlsKeyFile: process.env.GRPC_TLS_KEY_FILE || undefined,
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
