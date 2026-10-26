import {
  normalizeAlertChannel,
  normalizeAlertCredentials,
} from './alert-channel-input';
const secret = 'fixture-signing-secret-at-least-32-bytes';
const channel = {
  name: ' Operations ',
  type: 'webhook',
  url: 'https://example.test/private?token=fixture',
  secret,
};
describe('Alert channel credential validation and redaction', () => {
  it('exposes only the origin while retaining normalized private write credentials', () => {
    expect(normalizeAlertChannel(channel)).toEqual({
      name: 'Operations',
      type: 'webhook',
      enabled: true,
      destination: 'https://example.test',
      credentials: { type: 'webhook', url: channel.url, secret },
    });
    const slack = normalizeAlertChannel({
      name: 'Slack',
      type: 'slack',
      webhookUrl:
        'https://hooks.slack.com/services/TEXAMPLE/BEXAMPLE/FIXTURETOKEN',
    });
    expect(slack.destination).toBe('https://hooks.slack.com');
    expect(slack.destination).not.toMatch(/services|FIXTURE/);
    expect(
      normalizeAlertChannel({
        name: 'Email',
        type: 'email',
        address: 'alerts+gateway@example.test',
      }).destination,
    ).toBe('alerts+gateway@example.test');
  });
  it.each(
    [
      null,
      [],
      {},
      { ...channel, tenantId: 'other' },
      { ...channel, revision: 1 },
      { ...channel, enabled: 'true' },
      { ...channel, name: '' },
      { ...channel, name: 'x'.repeat(101) },
      { ...channel, name: 'a\nb' },
      { ...channel, type: 'sms' },
      { ...channel, secret: undefined },
      { ...channel, secret: 'short' },
      { ...channel, secret: 'x'.repeat(257) },
      { ...channel, secret: secret + '\r\n' },
    ].map((value) => [value]),
  )('rejects invalid channel configuration: %j', (value) => {
    expect(() => normalizeAlertChannel(value)).toThrow();
  });
  it.each([
    'http://example.test/path',
    'file:///private',
    'https://user:pass@example.test/path',
    'https://example.test/path#fragment',
    'https://example.test:8443/',
    'https://localhost/',
    'https://localhost./',
    'https://metadata.google.internal/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://10.0.0.1/',
    'https://169.254.169.254/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[fc00::1]/',
    'https://[2001:db8::1]/',
    ' https://example.test/',
    'https://example.test/\r\n',
    'https://example.test/' + 'x'.repeat(2048),
  ])('rejects unsafe URL forms before storage: %s', (url) => {
    expect(() => normalizeAlertChannel({ ...channel, url })).toThrow(
      'public HTTPS',
    );
  });
  it('allows global IP literals and an explicit operator-owned internal origin', () => {
    expect(
      normalizeAlertChannel({ ...channel, url: 'https://8.8.8.8/alerts' })
        .destination,
    ).toBe('https://8.8.8.8');
    expect(
      normalizeAlertChannel({
        ...channel,
        url: 'https://[2606:4700:4700::1111]/alerts',
      }).destination,
    ).toContain('2606:4700');
    const trusted = new Set(['http://127.0.0.1:9001']);
    expect(
      normalizeAlertChannel(
        { ...channel, url: 'http://127.0.0.1:9001/local-fixture' },
        trusted,
      ).destination,
    ).toBe('http://127.0.0.1:9001');
    expect(() =>
      normalizeAlertChannel(
        { ...channel, url: 'http://127.0.0.1:9002/local-fixture' },
        trusted,
      ),
    ).toThrow();
  });
  it.each([
    'https://evil.example.test/services/TEXAMPLE/BEXAMPLE/FIXTURE',
    'https://hooks.slack.com/not-a-webhook',
    'https://hooks.slack.com/services/TEXAMPLE/BEXAMPLE/FIXTURE?token=secret',
  ])('rejects an untrusted Slack destination: %s', (webhookUrl) => {
    expect(() =>
      normalizeAlertCredentials({ type: 'slack', webhookUrl }),
    ).toThrow('Slack incoming');
  });
  it.each([
    'a@example.test,b@example.test',
    'a@example.test\r\nBcc: victim@example.test',
    'Name <a@example.test>',
    'a@localhost',
    'a@-example.test',
    'a@example.-test',
    '.a@example.test',
    'a.@example.test',
    'a..b@example.test',
    'x'.repeat(65) + '@example.test',
  ])('rejects invalid email recipients: %s', (address) => {
    expect(() => normalizeAlertCredentials({ type: 'email', address })).toThrow(
      'valid email',
    );
  });
});
