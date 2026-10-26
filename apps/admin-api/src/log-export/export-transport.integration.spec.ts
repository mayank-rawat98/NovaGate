import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { LogExportDeliveryBatch } from '@api-gateway/shared-types';
import { ExportTransportService } from './export-transport.service';

const suite = process.env.TEST_OBJECT_STORAGE_ENDPOINT
  ? describe
  : describe.skip;
suite('external S3 transport with pinned RustFS', () => {
  it('stores immutable signed NDJSON, overwrites the same delivery key on retry, and removes the actual object', async () => {
    const endpoint = process.env.TEST_OBJECT_STORAGE_ENDPOINT as string;
    const credentials = {
      accessKeyId:
        process.env.TEST_OBJECT_STORAGE_ACCESS_KEY ?? 'novagate-verification',
      secretAccessKey:
        process.env.TEST_OBJECT_STORAGE_SECRET_KEY ??
        'local-object-storage-verification-only',
    };
    const bucket = `export-transport-${randomUUID()}`;
    const client = new S3Client({
      endpoint,
      credentials,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 5000,
        throwOnRequestTimeout: true,
      },
    });
    const transport = new ExportTransportService(
      new ConfigService({
        LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([
          new URL(endpoint).origin,
        ]),
      }),
    );
    const batch: LogExportDeliveryBatch = {
      version: 1,
      tenantId: randomUUID(),
      destinationId: randomUUID(),
      deliveryId: randomUUID(),
      privacy: {
        clientIp: 'omit',
        userAgent: 'omit',
        redactedFields: ['path', 'requestId'],
      },
      records: [
        {
          id: randomUUID(),
          method: 'GET',
          path: '/private/path',
          statusCode: 200,
          responseTimeMs: 1,
          requestId: randomUUID(),
          timestamp: '2026-10-11T00:00:00.000001Z',
          clientIp: '192.168.0.1',
          userAgent: 'private-user-agent',
        },
      ],
    };
    const key = `novagate/${batch.tenantId}/${batch.destinationId}/${batch.deliveryId}.ndjson`;
    const failures: unknown[] = [];
    let created = false;
    const send = <T>(operation: (signal: AbortSignal) => Promise<T>) =>
      operation(AbortSignal.timeout(5000));
    try {
      await send((abortSignal) =>
        client.send(new CreateBucketCommand({ Bucket: bucket }), {
          abortSignal,
        }),
      );
      created = true;
      const connection = {
        type: 's3',
        endpoint,
        bucket,
        region: 'us-east-1',
        forcePathStyle: true,
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      };
      for (let i = 0; i < 2; i++)
        await transport.deliver(
          connection,
          batch,
          new AbortController().signal,
        );
      const response = await send((abortSignal) =>
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal,
        }),
      );
      expect(response.ContentType).toBe('application/x-ndjson');
      expect(response.Metadata?.['novagate-delivery-id']).toBe(
        batch.deliveryId,
      );
      const text = await response.Body?.transformToString();
      expect(text).toBeDefined();
      expect(text).not.toMatch(/private|192\.168/);
      const record = JSON.parse(text as string);
      expect(record).toEqual({
        ...batch.records[0],
        path: '[redacted]',
        requestId: '[redacted]',
        clientIp: '[redacted]',
        userAgent: undefined,
      });
      const listed = await send((abortSignal) =>
        client.send(new ListObjectsV2Command({ Bucket: bucket }), {
          abortSignal,
        }),
      );
      expect(listed.Contents?.map((object) => object.Key)).toEqual([key]);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await transport.onModuleDestroy();
      } catch (error) {
        failures.push(error);
      }
      if (created) {
        try {
          await send((abortSignal) =>
            client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
              abortSignal,
            }),
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await send((abortSignal) =>
            client.send(new DeleteBucketCommand({ Bucket: bucket }), {
              abortSignal,
            }),
          );
        } catch (error) {
          failures.push(error);
        }
      }
      client.destroy();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        'External S3 transport or fixture cleanup failed',
      );
  }, 20000);
});
