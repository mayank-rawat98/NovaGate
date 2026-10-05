import Joi from 'joi';
import {
  DEFAULT_UPSTREAM_HEALTH,
  DEFAULT_GRPC,
  DEFAULT_WEBSOCKET,
  DEFAULT_IDENTITY_PROVIDER,
  DEFAULT_MTLS,
  DEFAULT_TLS,
  DEFAULT_HMAC,
  DEFAULT_GRAPHQL,
  DEFAULT_BODY_CAPTURE,
  DEFAULT_HTTP2,
  DEFAULT_PROXY_HANDLERS,
  DEFAULT_LOAD_BALANCER,
} from './configuration';
import { BlockList, isIP } from 'net';

export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  LOAD_BALANCER_MAX_SERVICES: Joi.number()
    .integer()
    .min(1)
    .max(4096)
    .default(DEFAULT_LOAD_BALANCER.maxServices),
  LOAD_BALANCER_MAX_TARGETS_PER_SERVICE: Joi.number()
    .integer()
    .min(1)
    .max(1024)
    .default(DEFAULT_LOAD_BALANCER.maxTargetsPerService),
  LOAD_BALANCER_MAX_ACTIVE_RESERVATIONS: Joi.number()
    .integer()
    .min(1)
    .max(65536)
    .default(DEFAULT_LOAD_BALANCER.maxActiveReservations),
  PROXY_MAX_HANDLER_CACHE_ENTRIES: Joi.number()
    .integer()
    .min(1)
    .max(4096)
    .default(DEFAULT_PROXY_HANDLERS.maxCacheEntries),
  HTTP2_MAX_TARGETS: Joi.number()
    .integer()
    .min(1)
    .max(1024)
    .default(DEFAULT_HTTP2.maxTargets),
  HTTP2_MAX_SESSIONS: Joi.number()
    .integer()
    .min(1)
    .max(1024)
    .default(DEFAULT_HTTP2.maxSessions),
  HTTP2_MAX_SESSIONS_PER_TARGET: Joi.number()
    .integer()
    .min(1)
    .max(32)
    .default(DEFAULT_HTTP2.maxSessionsPerTarget),
  HTTP2_MAX_STREAMS_PER_SESSION: Joi.number()
    .integer()
    .min(1)
    .max(1024)
    .default(DEFAULT_HTTP2.maxStreamsPerSession),
  HTTP2_MAX_ACTIVE_REQUESTS: Joi.number()
    .integer()
    .min(1)
    .max(1024)
    .default(DEFAULT_HTTP2.maxActiveRequests),
  HTTP2_MAX_RESPONSE_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(67108864)
    .default(DEFAULT_HTTP2.maxResponseBytes),
  HTTP2_MAX_HEADER_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(65536)
    .default(DEFAULT_HTTP2.maxHeaderBytes),
  HTTP2_CONNECT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30000)
    .default(DEFAULT_HTTP2.connectTimeoutMs),
  HTTP2_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(300000)
    .default(DEFAULT_HTTP2.idleTimeoutMs),

  BODY_CAPTURE_MAX_BODY_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(67108864)
    .default(DEFAULT_BODY_CAPTURE.maxBodyBytes),
  BODY_CAPTURE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30000)
    .default(DEFAULT_BODY_CAPTURE.timeoutMs),
  BODY_CAPTURE_MAX_PENDING_REQUESTS: Joi.number()
    .integer()
    .min(1)
    .max(512)
    .default(DEFAULT_BODY_CAPTURE.maxPendingRequests),
  GRAPHQL_MAX_QUERY_BYTES: Joi.number()
    .integer()
    .min(128)
    .max(1048576)
    .default(DEFAULT_GRAPHQL.maxQueryBytes),
  GRAPHQL_MAX_TOKENS: Joi.number()
    .integer()
    .min(16)
    .max(20000)
    .default(DEFAULT_GRAPHQL.maxTokens),
  GRAPHQL_MAX_LEXICAL_DEPTH: Joi.number()
    .integer()
    .min(8)
    .max(256)
    .default(DEFAULT_GRAPHQL.maxLexicalDepth),
  GRAPHQL_MAX_BODY_BYTES: Joi.number()
    .integer()
    .min(128)
    .max(16777216)
    .default(DEFAULT_GRAPHQL.maxBodyBytes),
  GRAPHQL_BODY_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30000)
    .default(DEFAULT_GRAPHQL.bodyTimeoutMs),
  GRAPHQL_MAX_PENDING_REQUESTS: Joi.number()
    .integer()
    .min(1)
    .max(256)
    .default(DEFAULT_GRAPHQL.maxPendingRequests),
  HMAC_MAX_BODY_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(16777216)
    .default(DEFAULT_HMAC.maxBodyBytes),
  HMAC_BODY_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(30000)
    .default(DEFAULT_HMAC.bodyTimeoutMs),
  HMAC_MAX_PENDING_REQUESTS: Joi.number()
    .integer()
    .min(1)
    .max(256)
    .default(DEFAULT_HMAC.maxPendingRequests),
  HMAC_MAX_HEADER_BYTES: Joi.number()
    .integer()
    .min(128)
    .max(16384)
    .default(DEFAULT_HMAC.maxHeaderBytes),
  TRUSTED_PROXY_CIDRS: Joi.string()
    .allow('')
    .default('')
    .custom((value: string, helpers) => {
      try {
        for (const cidr of value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)) {
          const [address, prefix] = cidr.split('/');
          const version = isIP(address);
          if (!version || cidr.split('/').length > 2)
            return helpers.error('any.invalid');
          const type = version === 4 ? 'ipv4' : 'ipv6';
          const list = new BlockList();
          if (prefix === undefined) list.addAddress(address, type);
          else {
            if (!/^\d+$/.test(prefix)) return helpers.error('any.invalid');
            list.addSubnet(address, Number(prefix), type);
          }
        }
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }),
  MTLS_TRUSTED_PROXY_CIDRS: Joi.string()
    .allow('')
    .default('')
    .custom((value: string, helpers) => {
      try {
        for (const cidr of value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)) {
          const [address, prefix] = cidr.split('/');
          const version = isIP(address);
          if (!version || cidr.split('/').length > 2)
            return helpers.error('any.invalid');
          const type = version === 4 ? 'ipv4' : 'ipv6';
          const list = new BlockList();
          if (prefix === undefined) list.addAddress(address, type);
          else {
            if (Number(prefix) === 0) return helpers.error('any.invalid');
            if (!/^\d+$/.test(prefix)) return helpers.error('any.invalid');
            list.addSubnet(address, Number(prefix), type);
          }
        }
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }),
  HEALTH_DEFAULT_INTERVAL_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60000)
    .default(DEFAULT_UPSTREAM_HEALTH.defaultIntervalMs),
  HEALTH_FAILURE_THRESHOLD: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(DEFAULT_UPSTREAM_HEALTH.failureThreshold),
  HEALTH_RECOVERY_THRESHOLD: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(DEFAULT_UPSTREAM_HEALTH.recoveryThreshold),
  HEALTH_PROBE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(10000)
    .default(DEFAULT_UPSTREAM_HEALTH.probeTimeoutMs),
  HEALTH_PROBE_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(64)
    .default(DEFAULT_UPSTREAM_HEALTH.concurrency),
  GRPC_ENABLED: Joi.string().valid('true', 'false').default('false'),
  GRPC_ALLOW_INSECURE: Joi.string().valid('true', 'false').default('false'),
  GRPC_HOST: Joi.alternatives()
    .try(Joi.string().ip(), Joi.string().hostname())
    .default(DEFAULT_GRPC.host),
  GRPC_PORT: Joi.number()
    .integer()
    .min(1)
    .max(65535)
    .default(DEFAULT_GRPC.port),
  GRPC_TLS_CERT_FILE: Joi.string().empty(''),
  GRPC_TLS_KEY_FILE: Joi.string().empty(''),
  GRPC_MAX_MESSAGE_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(DEFAULT_GRPC.maxMessageBytes),
  GRPC_MAX_HEADER_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(65536)
    .default(DEFAULT_GRPC.maxHeaderBytes),
  GRPC_MAX_CONCURRENT_STREAMS: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(DEFAULT_GRPC.maxConcurrentStreams),
  GRPC_MAX_SESSIONS_PER_TARGET: Joi.number()
    .integer()
    .min(1)
    .max(32)
    .default(DEFAULT_GRPC.maxSessionsPerTarget),
  GRPC_MAX_ACTIVE_CALLS: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(DEFAULT_GRPC.maxActiveCalls),
  GRPC_DEADLINE_MS: Joi.number()
    .integer()
    .min(100)
    .max(3600000)
    .default(DEFAULT_GRPC.deadlineMs),
  GRPC_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(3600000)
    .default(DEFAULT_GRPC.idleTimeoutMs),
  GRPC_SHUTDOWN_GRACE_MS: Joi.number()
    .integer()
    .min(0)
    .max(60000)
    .default(DEFAULT_GRPC.shutdownGraceMs),
  WS_ALLOW_QUERY_TOKEN: Joi.string().valid('true', 'false').default('false'),
  WS_HANDSHAKE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(DEFAULT_WEBSOCKET.handshakeTimeoutMs),
  WS_MAX_CONNECTIONS: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(DEFAULT_WEBSOCKET.maxConnections),
  WS_MAX_HEADER_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(65536)
    .default(DEFAULT_WEBSOCKET.maxHeaderBytes),
  WS_MAX_BUFFERED_HEAD_BYTES: Joi.number()
    .integer()
    .min(0)
    .max(1048576)
    .default(DEFAULT_WEBSOCKET.maxBufferedHeadBytes),
  WS_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(3600000)
    .default(DEFAULT_WEBSOCKET.idleTimeoutMs),
  WS_SHUTDOWN_GRACE_MS: Joi.number()
    .integer()
    .min(0)
    .max(60000)
    .default(DEFAULT_WEBSOCKET.shutdownGraceMs),
  IDENTITY_PROVIDER_ALLOW_INSECURE_HTTP: Joi.string()
    .valid('true', 'false')
    .default('false'),
  IDENTITY_PROVIDER_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(DEFAULT_IDENTITY_PROVIDER.timeoutMs),
  IDENTITY_PROVIDER_MAX_RESPONSE_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(1048576)
    .default(DEFAULT_IDENTITY_PROVIDER.maxResponseBytes),
  IDENTITY_PROVIDER_MAX_HEADER_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(65536)
    .default(DEFAULT_IDENTITY_PROVIDER.maxHeaderBytes),
  IDENTITY_PROVIDER_MAX_TOKEN_BYTES: Joi.number()
    .integer()
    .min(128)
    .max(65536)
    .default(DEFAULT_IDENTITY_PROVIDER.maxTokenBytes),
  IDENTITY_PROVIDER_MAX_PENDING_REQUESTS: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(DEFAULT_IDENTITY_PROVIDER.maxPendingRequests),
  IDENTITY_PROVIDER_MAX_CONCURRENT_FETCHES: Joi.number()
    .integer()
    .min(1)
    .max(256)
    .default(DEFAULT_IDENTITY_PROVIDER.maxConcurrentFetches),
  IDENTITY_PROVIDER_MAX_CACHE_ENTRIES: Joi.number()
    .integer()
    .min(1)
    .max(4096)
    .default(DEFAULT_IDENTITY_PROVIDER.maxCacheEntries),
  IDENTITY_PROVIDER_MAX_JWKS_KEYS: Joi.number()
    .integer()
    .min(1)
    .max(256)
    .default(DEFAULT_IDENTITY_PROVIDER.maxJwksKeys),
  IDENTITY_PROVIDER_JWKS_CACHE_TTL_MS: Joi.number()
    .integer()
    .min(1000)
    .max(86400000)
    .default(DEFAULT_IDENTITY_PROVIDER.jwksCacheTtlMs),
  IDENTITY_PROVIDER_JWKS_REFRESH_COOLDOWN_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60000)
    .default(DEFAULT_IDENTITY_PROVIDER.jwksRefreshCooldownMs),
  IDENTITY_PROVIDER_INTROSPECTION_CACHE_TTL_MS: Joi.number()
    .integer()
    .min(0)
    .max(300000)
    .default(DEFAULT_IDENTITY_PROVIDER.introspectionCacheTtlMs),
  IDENTITY_PROVIDER_OUTBOUND_CACHE_TTL_MS: Joi.number()
    .integer()
    .min(0)
    .max(86400000)
    .default(DEFAULT_IDENTITY_PROVIDER.outboundCacheTtlMs),
  TLS_HANDSHAKE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(60000)
    .default(DEFAULT_TLS.handshakeTimeoutMs),
  HTTP_TLS_MAX_CONNECTIONS: Joi.number()
    .integer()
    .min(1)
    .max(100000)
    .default(DEFAULT_TLS.maxConnections),
  HTTP_TLS_CERT_FILE: Joi.string(),
  HTTP_TLS_KEY_FILE: Joi.string(),
  HTTP_TLS_CLIENT_CA_FILE: Joi.string(),
  HTTP_TLS_CRL_FILE: Joi.string(),
  GRPC_TLS_CLIENT_CA_FILE: Joi.string(),
  GRPC_TLS_CRL_FILE: Joi.string(),
  MTLS_MAX_CERTIFICATE_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(65536)
    .default(DEFAULT_MTLS.maxCertificateBytes),
  MTLS_MAX_CA_BUNDLE_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(DEFAULT_MTLS.maxCaBundleBytes)
    .default(DEFAULT_MTLS.maxCaBundleBytes),
  MTLS_MAX_CHAIN_DEPTH: Joi.number()
    .integer()
    .min(1)
    .max(16)
    .default(DEFAULT_MTLS.maxChainDepth),
  MTLS_MAX_IDENTITY_BYTES: Joi.number()
    .integer()
    .min(128)
    .max(16384)
    .default(DEFAULT_MTLS.maxIdentityBytes),
  REDIS_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  PROXY_TIMEOUT_MS: Joi.number().default(10000),
  PROXY_SERVICES: Joi.string().default('[]'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_UNAUTH_MAX: Joi.number().default(100),
  RATE_LIMIT_AUTH_MAX: Joi.number().default(500),
})
  .and('GRPC_TLS_CERT_FILE', 'GRPC_TLS_KEY_FILE')
  .and('HTTP_TLS_CERT_FILE', 'HTTP_TLS_KEY_FILE')
  .with('HTTP_TLS_CLIENT_CA_FILE', ['HTTP_TLS_CERT_FILE', 'HTTP_TLS_KEY_FILE'])
  .with('HTTP_TLS_CRL_FILE', 'HTTP_TLS_CLIENT_CA_FILE')
  .with('GRPC_TLS_CLIENT_CA_FILE', ['GRPC_TLS_CERT_FILE', 'GRPC_TLS_KEY_FILE'])
  .with('GRPC_TLS_CRL_FILE', 'GRPC_TLS_CLIENT_CA_FILE')
  .custom((value, helpers) => {
    if (
      value.GRPC_ENABLED === 'true' &&
      value.GRPC_ALLOW_INSECURE !== 'true' &&
      !value.GRPC_TLS_CERT_FILE
    )
      return helpers.error('any.invalid');
    return value;
  })
  .required();
