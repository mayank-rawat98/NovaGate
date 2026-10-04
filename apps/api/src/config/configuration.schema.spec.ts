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
