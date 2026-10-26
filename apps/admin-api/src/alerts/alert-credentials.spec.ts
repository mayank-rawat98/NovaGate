import { AlertCredentialCipher } from './alert-credentials';
const tenant = 'aabbccdd-1111-2222-3333-444455556666';
const channel = 'bbbbbbbb-1111-2222-3333-444455556666';
const key = Buffer.alloc(32, 1).toString('base64');
const next = Buffer.alloc(32, 2).toString('base64');
const env = {
  ALERT_CHANNEL_KEYS: JSON.stringify({ v1: key }),
  ALERT_CHANNEL_ACTIVE_KEY: 'v1',
};
const credentials = {
  type: 'webhook',
  url: 'https://example.test/private-path?token=private-token',
  secret: 'private-signing-secret-at-least-32-bytes',
};
describe('Private alert credential encryption', () => {
  it('encrypts every credential with randomized nonces and authenticates the tenant/channel', () => {
    const cipher = new AlertCredentialCipher(env);
    const encrypted = cipher.encrypt(tenant, channel, credentials);
    expect(
      cipher.decrypt(tenant.toUpperCase(), channel.toUpperCase(), encrypted),
    ).toEqual(credentials);
    expect(cipher.encrypt(tenant, channel, credentials)).not.toEqual(encrypted);
    expect(JSON.stringify(encrypted)).not.toMatch(
      /private-path|private-token|private-signing/,
    );
    expect(() => cipher.decrypt(channel, channel, encrypted)).toThrow(
      'credentials are unavailable',
    );
    expect(() => cipher.decrypt(tenant, tenant, encrypted)).toThrow(
      'credentials are unavailable',
    );
  });
  it('writes with the active key while retaining reads using the previous key', () => {
    const original = new AlertCredentialCipher(env).encrypt(
      tenant,
      channel,
      credentials,
    );
    const rotated = new AlertCredentialCipher({
      ALERT_CHANNEL_KEYS: JSON.stringify({ v1: key, v2: next }),
      ALERT_CHANNEL_ACTIVE_KEY: 'v2',
    });
    expect(rotated.decrypt(tenant, channel, original)).toEqual(credentials);
    expect(rotated.encrypt(tenant, channel, credentials).keyId).toBe('v2');
    const retired = new AlertCredentialCipher({
      ALERT_CHANNEL_KEYS: JSON.stringify({ v2: next }),
      ALERT_CHANNEL_ACTIVE_KEY: 'v2',
    });
    expect(() => retired.decrypt(tenant, channel, original)).toThrow(
      'credentials are unavailable',
    );
  });
  it('does not fall back to a JWT signing secret when encryption is disabled', () => {
    const cipher = new AlertCredentialCipher({
      PLATFORM_JWT_SECRET: 'private-jwt-secret',
    });
    expect(cipher.enabled).toBe(false);
    expect(
      new AlertCredentialCipher({
        ALERT_CHANNEL_KEYS: '',
        ALERT_CHANNEL_ACTIVE_KEY: '',
      }).enabled,
    ).toBe(false);
    expect(() => cipher.encrypt(tenant, channel, credentials)).toThrow(
      'delivery is not configured',
    );
  });
  it.each([
    {
      ALERT_CHANNEL_KEYS: 'private-invalid-json',
      ALERT_CHANNEL_ACTIVE_KEY: 'v1',
    },
    { ALERT_CHANNEL_KEYS: '[]', ALERT_CHANNEL_ACTIVE_KEY: 'v1' },
    { ALERT_CHANNEL_KEYS: '{}', ALERT_CHANNEL_ACTIVE_KEY: 'v1' },
    {
      ALERT_CHANNEL_KEYS: JSON.stringify({ v1: 'private-short-key' }),
      ALERT_CHANNEL_ACTIVE_KEY: 'v1',
    },
    { ...env, ALERT_CHANNEL_ACTIVE_KEY: 'missing' },
    { ...env, ALERT_CHANNEL_ACTIVE_KEY: undefined },
    { ALERT_CHANNEL_ACTIVE_KEY: 'v1' },
    {
      ALERT_CHANNEL_KEYS: JSON.stringify({
        v1: key,
        v2: key,
        v3: key,
        v4: key,
        v5: key,
      }),
      ALERT_CHANNEL_ACTIVE_KEY: 'v1',
    },
  ])(
    'rejects malformed operator keys without exposing configuration: %j',
    (input) => {
      expect(() => new AlertCredentialCipher(input)).toThrow(
        'Invalid alert channel encryption configuration.',
      );
    },
  );
  it('rejects corrupt or oversized envelopes without exposing the destination or secret', () => {
    const cipher = new AlertCredentialCipher(env);
    const encrypted = cipher.encrypt(tenant, channel, credentials);
    for (const corrupt of [
      null,
      [],
      { ...encrypted, version: 2 },
      { ...encrypted, extra: 'private' },
      { ...encrypted, keyId: 'unknown' },
      { ...encrypted, nonce: 'invalid' },
      { ...encrypted, tag: Buffer.alloc(16).toString('base64') },
      { ...encrypted, ciphertext: Buffer.alloc(4097).toString('base64') },
      { ...encrypted, ciphertext: encrypted.ciphertext + '\n' },
    ]) {
      expect(() => cipher.decrypt(tenant, channel, corrupt)).toThrow(
        'Alert channel credentials are unavailable.',
      );
    }
    expect(() =>
      cipher.encrypt(tenant, channel, { secret: 'x'.repeat(4097) }),
    ).toThrow('storage limit');
  });
});
