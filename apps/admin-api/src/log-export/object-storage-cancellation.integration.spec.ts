import { ConfigService } from '@nestjs/config';
import {
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ObjectStorageService } from './object-storage.service';

/**
 * Issue #90: archive removals carry deadlines and shutdown cancellation. On
 * RustFS 1.0.1 a DeleteObject cancelled by the caller while the server was
 * processing it left residue no S3 API lists (xl.meta.bkp,
 * reserve-delete-data.<UUID>, part.1), so DeleteBucket answered 409
 * BucketNotEmpty after every listed object was gone. The pinned release must
 * let a bucket go after cancelled deletes and an owned cleanup.
 */
const suite = process.env.TEST_OBJECT_STORAGE_ENDPOINT
  ? describe
  : describe.skip;
suite('cancelled archive deletes on the pinned RustFS', () => {
  it('leaves no unreachable residue: the bucket deletes after an owned cleanup', async () => {
    const endpoint = process.env.TEST_OBJECT_STORAGE_ENDPOINT as string;
    const accessKeyId =
      process.env.TEST_OBJECT_STORAGE_ACCESS_KEY ?? 'novagate-verification';
    const secretAccessKey =
      process.env.TEST_OBJECT_STORAGE_SECRET_KEY ??
      'local-object-storage-verification-only';
    const bucket = `novagate-test-${randomUUID()}`;
    const client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
    });
    const storage = new ObjectStorageService(
      new ConfigService({
        OBJECT_STORAGE_ENABLED: 'true',
        OBJECT_STORAGE_ENDPOINT: endpoint,
        OBJECT_STORAGE_ACCESS_KEY: accessKeyId,
        OBJECT_STORAGE_SECRET_KEY: secretAccessKey,
        OBJECT_STORAGE_BUCKET: bucket,
        OBJECT_STORAGE_CREATE_BUCKET: 'true',
      }),
    );
    try {
      await storage.onModuleInit();
      const prefix = `tenants/${randomUUID()}/log-exports/`;
      const body = Buffer.alloc(300000, 7);
      let cancelled = 0;
      for (let i = 0; i < 40; i++) {
        const key = `${prefix}${randomUUID()}/archive.ndjson`;
        await storage.upload(
          key,
          Readable.from([body]),
          new AbortController().signal,
        );
        // The caller gives up while the server is processing the delete,
        // as an archive deadline or application shutdown does.
        const caller = new AbortController();
        const removal = storage.remove(key, caller.signal);
        setTimeout(() => caller.abort(), i % 5);
        await removal.catch(() => cancelled++);
      }
      expect(cancelled).toBeGreaterThan(0);
      await storage.cleanup(prefix);
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      const uploads = await client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket }),
      );
      expect(listed.KeyCount ?? 0).toBe(0);
      expect(uploads.Uploads ?? []).toEqual([]);
      // 1.0.1 answered 409 BucketNotEmpty here.
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      storage.onModuleDestroy();
      client.destroy();
    }
  }, 120000);
});
