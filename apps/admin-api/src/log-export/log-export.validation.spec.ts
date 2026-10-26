import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { validateExportFilter } from './log-export.service';
import { ObjectStorageService } from './object-storage.service';

const range = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
describe('Archive request and installation boundaries', () => {
  it.each([
    null,
    [],
    {},
    { ...range, from: '2026-02-31T00:00:00Z' },
    { ...range, from: '2026-01-01' },
    { ...range, from: range.to },
    { ...range, to: '2026-03-01T00:00:00Z' },
    { ...range, to: '2999-01-01T00:00:00Z' },
    { ...range, minStatusCode: '500' },
    { ...range, minStatusCode: 99 },
    { ...range, minStatusCode: 600 },
    { ...range, pathPrefix: 'not/a/path' },
    { ...range, pathPrefix: '/bad\npath' },
    { ...range, consumerId: '../tenant' },
    { ...range, objectKey: 'tenants/other/key' },
  ])('rejects invalid or unsafe filters %p', (input) => {
    expect(() => validateExportFilter(input)).toThrow();
  });
  it('normalizes UTC and accepts literal wildcard characters in a path prefix', () => {
    expect(
      validateExportFilter({
        ...range,
        pathPrefix: '/%_',
        minStatusCode: 500,
        consumerId: 'ABCDEF01-1234-1234-1234-123456789ABC',
      }),
    ).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      pathPrefix: '/%_',
      minStatusCode: 500,
      consumerId: 'abcdef01-1234-1234-1234-123456789abc',
    });
  });
  it('refuses public ACL grants reported by an S3 provider', async () => {
    const send = jest.spyOn(
      S3Client.prototype,
      'send',
    ) as unknown as jest.SpyInstance<Promise<unknown>, unknown[]>;
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('No policy'), { name: 'NoSuchBucketPolicy' }),
      )
      .mockResolvedValueOnce({
        Grants: [
          {
            Grantee: { URI: 'http://acs.amazonaws.com/groups/global/AllUsers' },
            Permission: 'READ',
          },
        ],
      });
    const storage = new ObjectStorageService(
      new ConfigService({
        OBJECT_STORAGE_ENABLED: 'true',
        OBJECT_STORAGE_ENDPOINT: 'http://storage.test',
        OBJECT_STORAGE_ACCESS_KEY: 'test-only-access',
        OBJECT_STORAGE_SECRET_KEY: 'test-only-secret-at-least-16',
      }),
    );
    try {
      await expect(storage.onModuleInit()).rejects.toThrow(
        'private access ACL',
      );
    } finally {
      storage.onModuleDestroy();
      send.mockRestore();
    }
  });
  it('supports a disabled installation without requiring storage credentials', () => {
    const storage = new ObjectStorageService(
      new ConfigService({ OBJECT_STORAGE_ENABLED: 'false' }),
    );
    expect(storage.enabled).toBe(false);
    storage.onModuleDestroy();
  });
  it.each([
    { OBJECT_STORAGE_ENABLED: 'yes' },
    { OBJECT_STORAGE_ENABLED: 'true' },
    { LOG_EXPORT_RETENTION_DAYS: '0' },
    { LOG_EXPORT_RETENTION_DAYS: '91' },
    { OBJECT_STORAGE_CREATE_BUCKET: 'yes' },
  ])('fails invalid installation configuration %p', (config) => {
    expect(() => new ObjectStorageService(new ConfigService(config))).toThrow();
  });
});
