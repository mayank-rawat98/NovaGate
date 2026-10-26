import { DATADOG_LOG_SITES } from '@api-gateway/shared-types';
import {
  destinationCredentials,
  destinationName,
} from './export-destination-input';

const webhook = {
  type: 'webhook',
  url: 'https://logs.example.com/private-path?token=private-query',
  signingSecret: 'private-signing-secret-of-at-least-32-bytes',
};
describe('Export destination private input boundary', () => {
  it('retains private webhook connection details but projects only the origin', () => {
    expect(destinationCredentials(webhook)).toEqual({
      destination: 'https://logs.example.com',
      credentials: webhook,
    });
    expect(destinationName('  Operations  ')).toBe('Operations');
  });
  it.each([
    'http://logs.example.com/',
    'https://logs.example.com:8443/',
    'https://user:private-password@logs.example.com/',
    'https://logs.example.com/#private',
    'https://localhost/',
    'https://a.localhost/',
    'https://metadata.google.internal/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://169.254.169.254/',
    'https://10.1.1.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[2001:db8::1]/',
    'https://a.local/',
    'https://a.internal/',
    'https://a.home.arpa/',
    ' https://logs.example.com/',
    'https://logs.example.com/\n',
    'https://logs.example.com\\private',
  ])('rejects unsafe or ambiguous webhook URLs: %s', (url) => {
    expect(() => destinationCredentials({ ...webhook, url })).toThrow(
      'public HTTPS',
    );
  });
  it.each([
    null,
    [],
    {},
    { ...webhook, authorization: 'private-extra' },
    { ...webhook, signingSecret: 'short' },
    { ...webhook, signingSecret: 'a'.repeat(257) },
    { ...webhook, signingSecret: 'a'.repeat(40) + '\r' },
  ])(
    'rejects malformed credentials without returning their contents',
    (input) => {
      try {
        destinationCredentials(input);
        throw new Error('Expected rejection');
      } catch (error) {
        expect((error as Error).message).not.toMatch(
          /private-extra|short|aaaaa/,
        );
        expect((error as Error).message).not.toBe('Expected rejection');
      }
    },
  );
  it('accepts explicit S3 provider options and temporary session credentials', () => {
    const input = {
      type: 's3',
      endpoint: 'https://s3.example.com/',
      bucket: 'tenant-logs',
      region: 'us-east-1',
      accessKeyId: 'private-key',
      secretAccessKey: 'private-secret',
      sessionToken: 'private-session',
      forcePathStyle: true,
    };
    expect(destinationCredentials(input)).toEqual({
      destination: 'https://s3.example.com',
      credentials: { ...input, endpoint: 'https://s3.example.com' },
    });
  });
  it.each([
    'a',
    'A-logs',
    'a..logs',
    '192.168.1.1',
    'xn--logs',
    'sthree-logs',
    'amzn-s3-demo-logs',
    'logs-s3alias',
    'logs--ol-s3',
    'logs.mrap',
    'logs--x-s3',
    'logs--table-s3',
  ])('rejects reserved or invalid bucket names: %s', (bucket) => {
    expect(() =>
      destinationCredentials({
        type: 's3',
        endpoint: 'https://s3.example.com',
        bucket,
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        forcePathStyle: false,
      }),
    ).toThrow();
  });
  it.each(DATADOG_LOG_SITES)(
    'supports the explicit Datadog site %s',
    (site) => {
      expect(
        destinationCredentials({
          type: 'datadog',
          site,
          apiKey: 'b'.repeat(32),
        }).destination,
      ).toBe(site);
    },
  );
  it('rejects arbitrary Datadog hosts, application keys and ignored S3 fields', () => {
    expect(() =>
      destinationCredentials({
        type: 'datadog',
        site: 'attacker.example.com',
        apiKey: 'b'.repeat(32),
      }),
    ).toThrow();
    expect(() =>
      destinationCredentials({
        type: 'datadog',
        site: 'datadoghq.com',
        apiKey: 'b'.repeat(32),
        applicationKey: 'private',
      }),
    ).toThrow();
    expect(() =>
      destinationCredentials({
        type: 's3',
        endpoint: 'https://s3.example.com/private?token=private',
        bucket: 'logs-archive',
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        forcePathStyle: false,
      }),
    ).toThrow();
  });
});
