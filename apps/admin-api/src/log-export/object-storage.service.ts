import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type BucketLocationConstraint,
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetBucketAclCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';

@Injectable()
export class ObjectStorageService implements OnModuleInit, OnModuleDestroy {
  readonly enabled: boolean;
  readonly retentionDays: number;
  readonly bucket: string;
  private readonly client?: S3Client;
  private readonly createBucket: boolean;
  private readonly region: string;
  private readonly shutdown = new AbortController();
  private readonly downloads = new Set<Readable>();

  constructor(config: ConfigService) {
    const flag = config.get<string>('OBJECT_STORAGE_ENABLED') ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('OBJECT_STORAGE_ENABLED must be true or false');
    this.enabled = flag === 'true';
    const retention = Number(config.get('LOG_EXPORT_RETENTION_DAYS') ?? 7);
    if (!Number.isInteger(retention) || retention < 1 || retention > 90)
      throw new Error('LOG_EXPORT_RETENTION_DAYS must be 1–90');
    this.retentionDays = retention;
    this.bucket = config.get('OBJECT_STORAGE_BUCKET') ?? 'novagate-archives';
    this.region = config.get('OBJECT_STORAGE_REGION') ?? 'us-east-1';
    const create =
      config.get<string>('OBJECT_STORAGE_CREATE_BUCKET') ?? 'false';
    if (!['true', 'false'].includes(create))
      throw new Error('OBJECT_STORAGE_CREATE_BUCKET must be true or false');
    this.createBucket = create === 'true';
    if (!this.enabled) return;
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket) ||
      this.bucket.includes('..')
    )
      throw new Error('Invalid OBJECT_STORAGE_BUCKET');
    const endpoint = config.get<string>('OBJECT_STORAGE_ENDPOINT');
    const accessKeyId = config.get<string>('OBJECT_STORAGE_ACCESS_KEY');
    const secretAccessKey = config.get<string>('OBJECT_STORAGE_SECRET_KEY');
    if (
      !endpoint ||
      !accessKeyId ||
      !secretAccessKey ||
      secretAccessKey.length < 16
    )
      throw new Error('Object storage endpoint and credentials are required');
    const url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid object storage endpoint');
    this.client = new S3Client({
      endpoint,
      region: this.region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 15000,
        throwOnRequestTimeout: true,
      },
    });
  }

  async onModuleInit() {
    if (!this.client) return;
    try {
      await this.request((client, abortSignal) =>
        client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
          abortSignal,
        }),
      );
    } catch (error) {
      if (
        !this.createBucket ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 404
      )
        throw new Error('Archive bucket is unavailable');
      try {
        await this.request((client, abortSignal) =>
          client.send(
            new CreateBucketCommand({
              Bucket: this.bucket,
              ...(this.region === 'us-east-1'
                ? {}
                : {
                    CreateBucketConfiguration: {
                      LocationConstraint: this
                        .region as BucketLocationConstraint,
                    },
                  }),
            }),
            { abortSignal },
          ),
        );
      } catch (creationError) {
        if (
          (creationError as { name?: string }).name !==
          'BucketAlreadyOwnedByYou'
        )
          throw new Error('Archive bucket could not be created');
      }
    }
    // New buckets are private by default. Refuse a configured public policy;
    // never mutate an operator-owned policy or add anonymous access.
    try {
      const result = await this.request((client, abortSignal) =>
        client.send(new GetBucketPolicyCommand({ Bucket: this.bucket }), {
          abortSignal,
        }),
      );
      const policy = JSON.parse(result.Policy ?? '{}') as {
        Statement?: unknown;
      };
      const statements = Array.isArray(policy.Statement)
        ? policy.Statement
        : [policy.Statement];
      if (
        statements.some(
          (
            statement:
              | { Effect?: string; Principal?: unknown; NotPrincipal?: unknown }
              | undefined,
          ) =>
            statement?.Effect === 'Allow' &&
            (statement.Principal === undefined ||
              statement.NotPrincipal !== undefined ||
              (JSON.stringify(statement.Principal) ?? '').includes('*')),
        )
      ) {
        throw new Error('Archive bucket must have a private access policy');
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchBucketPolicy')
        throw error;
    }
    const acl = await this.request((client, abortSignal) =>
      client.send(new GetBucketAclCommand({ Bucket: this.bucket }), {
        abortSignal,
      }),
    );
    if (
      acl.Grants?.some((grant) =>
        ['/groups/global/AllUsers', '/groups/global/AuthenticatedUsers'].some(
          (group) => grant.Grantee?.URI?.endsWith(group),
        ),
      )
    ) {
      throw new Error('Archive bucket must have a private access ACL');
    }
  }
  private async withDeadline<T>(
    timeout: number,
    operation: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      this.shutdown.signal,
      deadline.signal,
      ...(caller ? [caller] : []),
    ]);
    const timer = setTimeout(
      () => deadline.abort(new Error('Archive storage deadline exceeded')),
      timeout,
    );
    timer.unref();
    try {
      if (signal.aborted)
        throw new Error('Archive storage operation cancelled');
      return await operation(signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private request<T>(
    operation: (client: S3Client, signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('Object storage is disabled'));
    // Absolute budget also covers signing, connection acquisition, retry backoff and attempts.
    return this.withDeadline(
      15000,
      (signal) => operation(client, signal),
      caller,
    );
  }

  onModuleDestroy() {
    this.shutdown.abort();
    for (const stream of this.downloads) stream.destroy();
    this.downloads.clear();
    this.client?.destroy();
  }

  async upload(key: string, body: Readable, signal: AbortSignal) {
    if (!this.client) throw new Error('Object storage is disabled');
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    if (signal.aborted) {
      body.destroy();
      throw new Error('Archive upload cancelled');
    }
    // The SDK upload helper does not forward its abort controller to client.send.
    // Decorate its promise-based calls, including multipart completion/cleanup.
    const client = new Proxy(this.client, {
      get: (target, property, receiver) => {
        if (property !== 'send') return Reflect.get(target, property, receiver);
        return (command: Parameters<S3Client['send']>[0]) =>
          this.request(
            (source, abortSignal) => source.send(command, { abortSignal }),
            // Best-effort multipart cleanup remains possible after caller cancellation;
            // application shutdown still cancels it through the global signal.
            command instanceof AbortMultipartUploadCommand ? undefined : signal,
          );
      },
    });
    const upload = new Upload({
      client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
      },
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
      leavePartsOnError: false,
    });
    const abort = () => {
      body.destroy(new Error('Archive upload cancelled'));
      void upload.abort().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) {
        abort();
        throw new Error('Archive upload cancelled');
      }
      await upload.done();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async download(key: string, signal?: AbortSignal): Promise<Readable> {
    if (!this.client) throw new Error('Object storage is disabled');
    const result = await this.request(
      (client, abortSignal) =>
        client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal,
        }),
      signal,
    );
    if (!(result.Body instanceof Readable))
      throw new Error('Archive stream is unavailable');
    const stream = result.Body;
    if (this.shutdown.signal.aborted) {
      stream.destroy();
      throw new Error('Archive storage operation cancelled');
    }
    this.downloads.add(stream);
    stream.once('close', () => this.downloads.delete(stream));
    return stream;
  }
  async remove(key: string, signal?: AbortSignal) {
    if (!this.client) return;
    await this.request(
      (client, abortSignal) =>
        client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
          { abortSignal },
        ),
      signal,
    );
  }
  async cleanup(prefix: string, caller?: AbortSignal) {
    if (!this.client) return;
    return this.withDeadline(
      120000,
      async (signal) => {
        // Bounded pages and sequential deletes keep cleanup independent of archive size.
        let continuation: string | undefined;
        do {
          const page = await this.request(
            (client, abortSignal) =>
              client.send(
                new ListObjectsV2Command({
                  Bucket: this.bucket,
                  Prefix: prefix,
                  MaxKeys: 100,
                  ContinuationToken: continuation,
                }),
                { abortSignal },
              ),
            signal,
          );
          for (const object of page.Contents ?? [])
            if (object.Key) await this.remove(object.Key, signal);
          continuation = page.IsTruncated
            ? page.NextContinuationToken
            : undefined;
        } while (continuation);
        let keyMarker: string | undefined;
        let uploadIdMarker: string | undefined;
        let truncated: boolean | undefined;
        do {
          const page = await this.request(
            (client, abortSignal) =>
              client.send(
                new ListMultipartUploadsCommand({
                  Bucket: this.bucket,
                  Prefix: prefix,
                  MaxUploads: 100,
                  KeyMarker: keyMarker,
                  UploadIdMarker: uploadIdMarker,
                }),
                { abortSignal },
              ),
            signal,
          );
          for (const upload of page.Uploads ?? [])
            await this.request(
              (client, abortSignal) =>
                client.send(
                  new AbortMultipartUploadCommand({
                    Bucket: this.bucket,
                    Key: upload.Key,
                    UploadId: upload.UploadId,
                  }),
                  { abortSignal },
                ),
              signal,
            );
          truncated = page.IsTruncated;
          keyMarker = page.NextKeyMarker;
          uploadIdMarker = page.NextUploadIdMarker;
        } while (truncated);
      },
      caller,
    );
  }
}
