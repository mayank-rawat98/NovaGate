import { AlertCredentialCipher } from '../alerts/alert-credentials';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';

const tenant = 'aabbccdd-1111-2222-3333-444455556666';
const id = 'bbbbbbbb-1111-2222-3333-444455556666';
const first = Buffer.alloc(32, 1).toString('base64');
const second = Buffer.alloc(32, 2).toString('base64');
const env = {
  LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ first }),
  LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'first',
};
const credentials = {
  type: 'webhook',
  url: 'https://example.com/private-path?token=private-query',
  signingSecret: 'private-signing-secret',
};
describe('Dedicated export credential encryption and rotation', () => {
  it('randomizes ciphertext and binds tenant, destination and provider', () => {
    const cipher = new ExportDestinationCredentialCipher(env);
    const encrypted = cipher.encrypt(tenant, id, 'webhook', credentials);
    expect(
      cipher.decrypt(
        tenant.toUpperCase(),
        id.toUpperCase(),
        'webhook',
        encrypted,
      ),
    ).toEqual(credentials);
    expect(cipher.encrypt(tenant, id, 'webhook', credentials)).not.toEqual(
      encrypted,
    );
    expect(JSON.stringify(encrypted)).not.toMatch(
      /private-path|private-query|private-signing/,
    );
    for (const [owner, destination, type] of [
      [id, id, 'webhook'],
      [tenant, tenant, 'webhook'],
      [tenant, id, 's3'],
    ] as const)
      expect(() => cipher.decrypt(owner, destination, type, encrypted)).toThrow(
        'credentials are unavailable',
      );
  });
  it('separates the alert ciphertext domain even with identical operator keys', () => {
    const alert = new AlertCredentialCipher({
      ALERT_CHANNEL_KEYS: JSON.stringify({ first }),
      ALERT_CHANNEL_ACTIVE_KEY: 'first',
    });
    const cipher = new ExportDestinationCredentialCipher(env);
    expect(() =>
      cipher.decrypt(
        tenant,
        id,
        'webhook',
        alert.encrypt(tenant, id, credentials),
      ),
    ).toThrow('credentials are unavailable');
    expect(() =>
      alert.decrypt(
        tenant,
        id,
        cipher.encrypt(tenant, id, 'webhook', credentials),
      ),
    ).toThrow('credentials are unavailable');
  });
  it('writes only the active key, retains old reads and rejects retired keys', () => {
    const old = new ExportDestinationCredentialCipher(env).encrypt(
      tenant,
      id,
      'webhook',
      credentials,
    );
    const rotated = new ExportDestinationCredentialCipher({
      LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ first, second }),
      LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'second',
    });
    expect(rotated.decrypt(tenant, id, 'webhook', old)).toEqual(credentials);
    const next = rotated.encrypt(
      tenant,
      id,
      'webhook',
      rotated.decrypt(tenant, id, 'webhook', old),
    );
    expect(next.keyId).toBe('second');
    const retired = new ExportDestinationCredentialCipher({
      LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ second }),
      LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'second',
    });
    expect(retired.decrypt(tenant, id, 'webhook', next)).toEqual(credentials);
    expect(() => retired.decrypt(tenant, id, 'webhook', old)).toThrow(
      'credentials are unavailable',
    );
  });
  it('never falls back to JWT, alert or platform object-storage secrets', () => {
    const cipher = new ExportDestinationCredentialCipher({
      PLATFORM_JWT_SECRET: 'private',
      ALERT_CHANNEL_KEYS: JSON.stringify({ first }),
      ALERT_CHANNEL_ACTIVE_KEY: 'first',
      OBJECT_STORAGE_SECRET_KEY: 'private',
    });
    expect(cipher.enabled).toBe(false);
    expect(() => cipher.encrypt(tenant, id, 'webhook', credentials)).toThrow(
      'not enabled',
    );
  });
  it.each([
    {
      LOG_EXPORT_DESTINATION_KEYS: 'private-not-json',
      LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'first',
    },
    { ...env, LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'missing' },
    { ...env, LOG_EXPORT_DESTINATION_ACTIVE_KEY: undefined },
    { LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'first' },
    {
      ...env,
      LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ first: 'private-short' }),
    },
    { ...env, LOG_EXPORT_DESTINATION_KEYS: '[]' },
    {
      ...env,
      LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({
        a: first,
        b: first,
        c: first,
        d: first,
        e: first,
      }),
    },
  ])('rejects malformed keyrings without exposing key material', (input) => {
    expect(() => new ExportDestinationCredentialCipher(input)).toThrow(
      'Invalid log export destination encryption configuration.',
    );
  });
  it('rejects corruption and oversized plaintext and clears keys on disposal', () => {
    const cipher = new ExportDestinationCredentialCipher(env);
    const value = cipher.encrypt(tenant, id, 'webhook', credentials);
    for (const corrupt of [
      null,
      [],
      { ...value, version: 2 },
      { ...value, extra: 'private' },
      { ...value, keyId: 'second' },
      { ...value, nonce: 'invalid' },
      { ...value, tag: Buffer.alloc(16).toString('base64') },
      { ...value, ciphertext: value.ciphertext + '\n' },
      { ...value, ciphertext: Buffer.alloc(4097).toString('base64') },
    ])
      expect(() => cipher.decrypt(tenant, id, 'webhook', corrupt)).toThrow(
        'credentials are unavailable',
      );
    expect(() =>
      cipher.encrypt(tenant, id, 'webhook', { secret: 'x'.repeat(4097) }),
    ).toThrow('storage limit');
    cipher.destroy();
    expect(cipher.enabled).toBe(false);
    expect(() => cipher.decrypt(tenant, id, 'webhook', value)).toThrow(
      'credentials are unavailable',
    );
  });
});
