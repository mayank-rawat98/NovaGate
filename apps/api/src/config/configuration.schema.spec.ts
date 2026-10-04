import { configSchema } from './configuration.schema';

const required = {
  DATABASE_URL: 'postgres://gateway:placeholder@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'verification-only-secret-with-32-characters',
};

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
