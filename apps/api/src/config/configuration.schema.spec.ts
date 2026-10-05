import configuration from './configuration';
import { configSchema } from './configuration.schema';

const required = {
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'verification-only-secret-with-32-characters',
};

describe('Data-plane configuration', () => {
  it('starts without a database connection setting', () => {
    const result = configSchema.validate(required);
    expect(result.error).toBeUndefined();
    expect(result.value.DATABASE_URL).toBeUndefined();
  });
});

describe('Trusted reverse proxy configuration', () => {
  it('trusts no proxy unless configured', () => {
    expect(configSchema.validate(required).value.TRUSTED_PROXY_CIDRS).toBe('');
  });
  it.each(['127.0.0.1', '10.0.0.0/8, ::1/128', '2001:db8::/32'])(
    'accepts literal addresses and CIDRs: %s',
    (cidrs) => {
      expect(
        configSchema.validate({ ...required, TRUSTED_PROXY_CIDRS: cidrs })
          .error,
      ).toBeUndefined();
    },
  );
  it.each([
    'true',
    '*',
    'loopback',
    '10.0.0.0/33',
    '::1/129',
    '127.0.0.1/-1',
    '127.0.0.1/8/2',
  ])('rejects ambiguous or invalid trust policies: %s', (cidrs) => {
    expect(
      configSchema.validate({ ...required, TRUSTED_PROXY_CIDRS: cidrs }).error,
    ).toBeDefined();
  });
});

describe('upstream health startup settings', () => {
  it('provides bounded operational defaults', () => {
    const result = configSchema.validate(required);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      HEALTH_DEFAULT_INTERVAL_MS: 10000,
      HEALTH_FAILURE_THRESHOLD: 3,
      HEALTH_RECOVERY_THRESHOLD: 2,
      HEALTH_PROBE_TIMEOUT_MS: 3000,
      HEALTH_PROBE_CONCURRENCY: 8,
    });
  });
  it.each([
    ['HEALTH_DEFAULT_INTERVAL_MS', 999],
    ['HEALTH_DEFAULT_INTERVAL_MS', 60001],
    ['HEALTH_FAILURE_THRESHOLD', 0],
    ['HEALTH_FAILURE_THRESHOLD', 11],
    ['HEALTH_RECOVERY_THRESHOLD', 1.5],
    ['HEALTH_RECOVERY_THRESHOLD', 11],
    ['HEALTH_PROBE_TIMEOUT_MS', 99],
    ['HEALTH_PROBE_TIMEOUT_MS', 10001],
    ['HEALTH_PROBE_CONCURRENCY', 0],
    ['HEALTH_PROBE_CONCURRENCY', 65],
  ])('rejects unsafe %s=%s', (name, value) => {
    expect(
      configSchema.validate({ ...required, [name]: value }).error,
    ).toBeDefined();
  });
});

describe('gRPC listener startup validation', () => {
  it('keeps the listener disabled by default', () => {
    expect(configSchema.validate(required).value.GRPC_ENABLED).toBe('false');
  });
  it('requires TLS or explicit private cleartext operation', () => {
    expect(
      configSchema.validate({ ...required, GRPC_ENABLED: 'true' }).error,
    ).toBeDefined();
    expect(
      configSchema.validate({
        ...required,
        GRPC_ENABLED: 'true',
        GRPC_ALLOW_INSECURE: 'true',
      }).error,
    ).toBeUndefined();
    expect(
      configSchema.validate({
        ...required,
        GRPC_ENABLED: 'true',
        GRPC_TLS_CERT_FILE: '/cert.pem',
        GRPC_TLS_KEY_FILE: '/key.pem',
      }).error,
    ).toBeUndefined();
  });
  it('rejects partial TLS credentials even when the listener is disabled', () => {
    expect(
      configSchema.validate({ ...required, GRPC_TLS_CERT_FILE: '/cert.pem' })
        .error,
    ).toBeDefined();
  });
  it.each([
    ['GRPC_ENABLED', 'yes'],
    ['GRPC_ALLOW_INSECURE', '1'],
    ['GRPC_PORT', 0],
    ['GRPC_MAX_MESSAGE_BYTES', 0],
    ['GRPC_MAX_HEADER_BYTES', 65537],
    ['GRPC_MAX_CONCURRENT_STREAMS', 1001],
    ['GRPC_MAX_SESSIONS_PER_TARGET', 33],
    ['GRPC_MAX_ACTIVE_CALLS', 0],
    ['GRPC_DEADLINE_MS', 99],
    ['GRPC_IDLE_TIMEOUT_MS', 999],
    ['GRPC_SHUTDOWN_GRACE_MS', 60001],
  ])('rejects unsafe %s=%s', (name, value) => {
    expect(
      configSchema.validate({ ...required, [name]: value }).error,
    ).toBeDefined();
  });
});

describe('WebSocket upgrade startup validation', () => {
  it('disables query credentials and supplies finite resource bounds', () => {
    expect(configSchema.validate(required).value).toMatchObject({
      WS_ALLOW_QUERY_TOKEN: 'false',
      WS_MAX_CONNECTIONS: 256,
      WS_HANDSHAKE_TIMEOUT_MS: 5000,
      WS_MAX_HEADER_BYTES: 16384,
      WS_MAX_BUFFERED_HEAD_BYTES: 65536,
      WS_IDLE_TIMEOUT_MS: 300000,
      WS_SHUTDOWN_GRACE_MS: 5000,
    });
  });
  it.each([
    ['WS_ALLOW_QUERY_TOKEN', 'yes'],
    ['WS_MAX_CONNECTIONS', 0],
    ['WS_MAX_CONNECTIONS', 10001],
    ['WS_HANDSHAKE_TIMEOUT_MS', 99],
    ['WS_HANDSHAKE_TIMEOUT_MS', 60001],
    ['WS_MAX_HEADER_BYTES', 1023],
    ['WS_MAX_HEADER_BYTES', 65537],
    ['WS_MAX_BUFFERED_HEAD_BYTES', -1],
    ['WS_MAX_BUFFERED_HEAD_BYTES', 1048577],
    ['WS_IDLE_TIMEOUT_MS', 999],
    ['WS_IDLE_TIMEOUT_MS', 3600001],
    ['WS_SHUTDOWN_GRACE_MS', -1],
    ['WS_SHUTDOWN_GRACE_MS', 60001],
  ])('rejects unsafe %s=%s', (name, value) => {
    expect(
      configSchema.validate({ ...required, [name]: value }).error,
    ).toBeDefined();
  });
});

describe('identity-provider resource limits', () => {
  it('requires secure transport and finite defaults', () => {
    expect(configSchema.validate(required).value).toMatchObject({
      IDENTITY_PROVIDER_ALLOW_INSECURE_HTTP: 'false',
      IDENTITY_PROVIDER_TIMEOUT_MS: 5000,
      IDENTITY_PROVIDER_MAX_PENDING_REQUESTS: 128,
      IDENTITY_PROVIDER_MAX_CONCURRENT_FETCHES: 16,
    });
  });
  it.each([
    ['IDENTITY_PROVIDER_ALLOW_INSECURE_HTTP', 'yes'],
    ['IDENTITY_PROVIDER_TIMEOUT_MS', 99],
    ['IDENTITY_PROVIDER_TIMEOUT_MS', 60001],
    ['IDENTITY_PROVIDER_MAX_RESPONSE_BYTES', 1048577],
    ['IDENTITY_PROVIDER_MAX_HEADER_BYTES', 65537],
    ['IDENTITY_PROVIDER_MAX_TOKEN_BYTES', 127],
    ['IDENTITY_PROVIDER_MAX_PENDING_REQUESTS', 0],
    ['IDENTITY_PROVIDER_MAX_CONCURRENT_FETCHES', 257],
    ['IDENTITY_PROVIDER_MAX_CACHE_ENTRIES', 0],
    ['IDENTITY_PROVIDER_MAX_JWKS_KEYS', 257],
    ['IDENTITY_PROVIDER_JWKS_CACHE_TTL_MS', 999],
    ['IDENTITY_PROVIDER_JWKS_REFRESH_COOLDOWN_MS', 60001],
    ['IDENTITY_PROVIDER_INTROSPECTION_CACHE_TTL_MS', -1],
    ['IDENTITY_PROVIDER_OUTBOUND_CACHE_TTL_MS', 86400001],
  ])('rejects unsafe %s=%s', (name, value) =>
    expect(
      configSchema.validate({ ...required, [name]: value }).error,
    ).toBeDefined(),
  );
});

describe('native TLS and mTLS trust policy startup', () => {
  it('trusts no certificate assertion proxy by default', () =>
    expect(configSchema.validate(required).value.MTLS_TRUSTED_PROXY_CIDRS).toBe(
      '',
    ));
  it.each([
    { HTTP_TLS_CERT_FILE: '/cert' },
    { HTTP_TLS_CLIENT_CA_FILE: '/ca' },
    { HTTP_TLS_CRL_FILE: '/crl' },
    { GRPC_TLS_CLIENT_CA_FILE: '/ca' },
    { GRPC_TLS_CRL_FILE: '/crl' },
    { MTLS_TRUSTED_PROXY_CIDRS: '0.0.0.0/0' },
    { MTLS_TRUSTED_PROXY_CIDRS: '::/0' },
    { MTLS_TRUSTED_PROXY_CIDRS: '*' },
    { TLS_HANDSHAKE_TIMEOUT_MS: 99 },
    { HTTP_TLS_MAX_CONNECTIONS: 0 },
    { MTLS_MAX_CERTIFICATE_BYTES: 65537 },
    { MTLS_MAX_CA_BUNDLE_BYTES: 65537 },
    { MTLS_MAX_CHAIN_DEPTH: 0 },
    { MTLS_MAX_IDENTITY_BYTES: 127 },
  ])('rejects incomplete or unsafe listener/trust settings %j', (settings) =>
    expect(
      configSchema.validate({ ...required, ...settings }).error,
    ).toBeDefined(),
  );
  it('accepts native TLS plus client trust and CRL with an explicit certificate-proxy CIDR', () =>
    expect(
      configSchema.validate({
        ...required,
        HTTP_TLS_CERT_FILE: '/cert',
        HTTP_TLS_KEY_FILE: '/key',
        HTTP_TLS_CLIENT_CA_FILE: '/ca',
        HTTP_TLS_CRL_FILE: '/crl',
        MTLS_TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
      }).error,
    ).toBeUndefined());
  it.each([
    { HMAC_MAX_BODY_BYTES: 0 },
    { HMAC_MAX_BODY_BYTES: 16777217 },
    { HMAC_BODY_TIMEOUT_MS: 99 },
    { HMAC_BODY_TIMEOUT_MS: 30001 },
    { HMAC_MAX_PENDING_REQUESTS: 0 },
    { HMAC_MAX_PENDING_REQUESTS: 257 },
    { HMAC_MAX_HEADER_BYTES: 127 },
    { HMAC_MAX_HEADER_BYTES: 16385 },
  ])('rejects unsafe webhook upload settings %j', (settings) => {
    expect(
      configSchema.validate({ ...required, ...settings }).error,
    ).toBeDefined();
  });
  it.each([
    { GRAPHQL_MAX_QUERY_BYTES: 127 },
    { GRAPHQL_MAX_TOKENS: 15 },
    { GRAPHQL_MAX_LEXICAL_DEPTH: 257 },
    { GRAPHQL_MAX_BODY_BYTES: 127 },
    { GRAPHQL_BODY_TIMEOUT_MS: 99 },
    { GRAPHQL_MAX_PENDING_REQUESTS: 0 },
    { BODY_CAPTURE_MAX_BODY_BYTES: 0 },
    { BODY_CAPTURE_TIMEOUT_MS: 99 },
    { BODY_CAPTURE_MAX_PENDING_REQUESTS: 0 },
  ])('rejects unsafe GraphQL/body capture settings %j', (settings) => {
    expect(
      configSchema.validate({ ...required, ...settings }).error,
    ).toBeDefined();
  });
});

describe('bounded HTTP/2 startup settings', () => {
  it.each([
    ['HTTP2_MAX_TARGETS', 0],
    ['HTTP2_MAX_TARGETS', 1025],
    ['HTTP2_MAX_SESSIONS', 0],
    ['HTTP2_MAX_SESSIONS_PER_TARGET', 33],
    ['HTTP2_MAX_STREAMS_PER_SESSION', 1.5],
    ['HTTP2_MAX_ACTIVE_REQUESTS', 1025],
    ['HTTP2_MAX_RESPONSE_BYTES', 67108865],
    ['HTTP2_MAX_HEADER_BYTES', 1023],
    ['HTTP2_CONNECT_TIMEOUT_MS', 99],
    ['HTTP2_IDLE_TIMEOUT_MS', 300001],
    ['PROXY_MAX_HANDLER_CACHE_ENTRIES', 4097],
  ])('rejects unsafe %s=%s', (name, value) => {
    expect(
      configSchema.validate({ ...required, [name]: value }).error,
    ).toBeDefined();
  });
  it('validates finite default pool and cache budgets', () => {
    expect(configSchema.validate(required).value).toMatchObject({
      HTTP2_MAX_TARGETS: 64,
      HTTP2_MAX_SESSIONS: 64,
      HTTP2_MAX_ACTIVE_REQUESTS: 64,
      HTTP2_MAX_RESPONSE_BYTES: 4194304,
      PROXY_MAX_HANDLER_CACHE_ENTRIES: 256,
    });
  });
});

describe('balancer state startup bounds', () => {
  it.each([
    ['LOAD_BALANCER_MAX_SERVICES', 0],
    ['LOAD_BALANCER_MAX_SERVICES', 4097],
    ['LOAD_BALANCER_MAX_TARGETS_PER_SERVICE', 1025],
    ['LOAD_BALANCER_MAX_ACTIVE_RESERVATIONS', 65537],
  ])('rejects unsafe %s=%s', (name, value) => {
    expect(
      configSchema.validate({ ...required, [name]: value }).error,
    ).toBeDefined();
  });
});

describe('bounded tracing startup settings', () => {
  it('keeps case-insensitive disabled settings consistent between validation and runtime', () => {
    const before = process.env.TRACING_ENABLED;
    try {
      process.env.TRACING_ENABLED = 'FALSE';
      expect(
        configSchema.validate({ ...required, TRACING_ENABLED: 'FALSE' }).value
          .TRACING_ENABLED,
      ).toBe(false);
      expect(configuration().tracing.enabled).toBe(false);
    } finally {
      if (before === undefined) delete process.env.TRACING_ENABLED;
      else process.env.TRACING_ENABLED = before;
    }
  });
  it.each([
    { TRACING_SAMPLE_RATE: 1.1 },
    { TRACING_SAMPLE_RATE: -0.1 },
    { TRACING_MAX_ACTIVE_SPANS: 0 },
    { TRACING_MAX_QUEUED_SPANS: 100000 },
    { TRACING_MAX_BATCH_SPANS: 129 },
    { TRACING_MAX_BATCH_BYTES: 65537 },
    { TRACING_FLUSH_INTERVAL_MS: 99 },
    { TRACING_ENABLED: 'sometimes' },
  ])('rejects invalid tracing limits %j', (values) => {
    expect(
      configSchema.validate({ ...required, ...values }).error,
    ).toBeDefined();
  });
});
