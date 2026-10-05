import {
  alertTrustedOrigins,
  isPublicAlertAddress,
} from './alert-egress-policy';
describe('Alert egress address policy', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('permits global unicast: %s', (address) => {
    expect(isPublicAlertAddress(address)).toBe(true);
  });
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.170',
    '192.0.2.1',
    '192.88.99.2',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '100::1',
    '100:0:0:1::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    'not-an-address',
  ])(
    'denies private, metadata, reserved and transition addresses: %s',
    (address) => {
      expect(isPublicAlertAddress(address)).toBe(false);
    },
  );
  it('requires an exact origin rather than a prefix or path allowlist', () => {
    const origins = alertTrustedOrigins(
      '["http://127.0.0.1:9001","https://alerts.example.test"]',
    );
    expect(origins.has('http://127.0.0.1:9001')).toBe(true);
    expect(origins.has('http://127.0.0.1:9002')).toBe(false);
    expect(origins.has('https://alerts.example.test.evil.test')).toBe(false);
    expect(alertTrustedOrigins(undefined).size).toBe(0);
  });
  it.each([
    'not-json',
    '{}',
    '["https://example.test/path"]',
    '["https://user:pass@example.test"]',
    '["file:///tmp"]',
    '["https://example.test/"]',
    JSON.stringify(Array(17).fill('https://example.test')),
  ])('rejects invalid operator exceptions: %s', (value) => {
    expect(() => alertTrustedOrigins(value)).toThrow(
      'Invalid ALERT_HTTP_TRUSTED_ORIGINS',
    );
  });
});
