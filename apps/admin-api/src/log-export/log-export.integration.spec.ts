import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import {
  S3Client,
  DeleteBucketCommand,
  PutBucketPolicyCommand,
  PutBucketAclCommand,
  GetBucketAclCommand,
  DeleteBucketPolicyCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { MigrationService } from '../database/migration.service';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import { LogExportController } from './log-export.controller';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_OBJECT_STORAGE_ENDPOINT
    ? describe
    : describe.skip;
integration('Private log archives on real PostgreSQL and RustFS', () => {
  let root: DataSource;
  let db: DataSource;
  let storage: ObjectStorageService;
  let exports: LogExportService;
  let app: INestApplication;
  let url: string;
  const tenant = randomUUID();
  const other = randomUUID();
  const database = `novagate_exports_${randomUUID().replace(/-/g, '')}`;
  const bucket = `novagate-test-${randomUUID()}`;
  const endpoint = process.env.TEST_OBJECT_STORAGE_ENDPOINT as string;
  const accessKeyId =
    process.env.TEST_OBJECT_STORAGE_ACCESS_KEY ?? 'novagate-verification';
  const secretAccessKey =
    process.env.TEST_OBJECT_STORAGE_SECRET_KEY ??
    'local-object-storage-verification-only';
  const client = new S3Client({
    endpoint,
    forcePathStyle: true,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });
  const secret = 'archive-integration-secret-at-least-32-characters';
  const oldSecret = process.env.PLATFORM_JWT_SECRET;
  const now = new Date();
  const filter = {
    from: new Date(now.getTime() - 3600000).toISOString(),
    to: now.toISOString(),
  };
  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Expected a claimed archive job');
    return value;
  }
  let archiveId: string;
  const headers = (id = tenant) => ({
    Authorization: `Bearer ${sign({}, secret, { subject: id })}`,
    'Content-Type': 'application/json',
  });

  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = secret;
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL as string);
    databaseUrl.pathname = `/${database}`;
    db = new DataSource({ type: 'postgres', url: databaseUrl.toString() });
    await db.initialize();
    await db.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    for (const id of [tenant, other]) {
      await db.query(
        `INSERT INTO public.tenants (id,name,email,"planId") VALUES ($1,'Archive tenant',$2,'free')`,
        [id, `${id}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(id);
    }
    await new MigrationService(db).onModuleInit();
    // Equal microsecond timestamps across pages exercise the UUID tie-breaker.
    await db.query(
      `INSERT INTO ${tenantSchema(tenant)}.request_logs (id,method,path,"statusCode",timestamp) SELECT gen_random_uuid(),'GET','/products',CASE WHEN i%2=0 THEN 500 ELSE 200 END,$1::timestamp + INTERVAL '0.000123 seconds' FROM generate_series(1,1201) i`,
      [new Date(now.getTime() - 60000).toISOString()],
    );
    await db.query(
      `INSERT INTO ${tenantSchema(other)}.request_logs (id,method,path,"statusCode",timestamp) VALUES (gen_random_uuid(),'GET','/private-other-tenant',200,$1)`,
      [new Date(now.getTime() - 60000).toISOString()],
    );
    storage = new ObjectStorageService(
      new ConfigService({
        OBJECT_STORAGE_ENABLED: 'true',
        OBJECT_STORAGE_ENDPOINT: endpoint,
        OBJECT_STORAGE_ACCESS_KEY: accessKeyId,
        OBJECT_STORAGE_SECRET_KEY: secretAccessKey,
        OBJECT_STORAGE_BUCKET: bucket,
        OBJECT_STORAGE_CREATE_BUCKET: 'true',
      }),
    );
    exports = new LogExportService(db, storage);
    jest
      .spyOn(exports, 'onApplicationBootstrap')
      .mockImplementation(() => undefined);
    const module = await Test.createTestingModule({
      controllers: [LogExportController],
      providers: [
        { provide: LogExportService, useValue: exports },
        { provide: ObjectStorageService, useValue: storage },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/tenants`;
  }, 30000);
  afterAll(async () => {
    if (storage?.enabled) {
      await storage.cleanup('tenants/');
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    await app?.close();
    client.destroy();
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
    if (oldSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = oldSecret;
  }, 30000);

  it('requires a matching tenant session and validates ranges before persisting jobs', async () => {
    expect((await fetch(`${url}/${tenant}/log-exports`)).status).toBe(401);
    expect(
      (await fetch(`${url}/${tenant}/log-exports`, { headers: headers(other) }))
        .status,
    ).toBe(403);
    const invalid = await fetch(`${url}/${tenant}/log-exports`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...filter, from: '2026-02-31T00:00:00Z' }),
    });
    expect(invalid.status).toBe(400);
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::integer AS count FROM public.log_export_jobs',
        )
      )[0].count,
    ).toBe(0);
  });
  it('claims a durable job only once across concurrent workers and streams every row without duplicates', async () => {
    const created = await fetch(`${url}/${tenant}/log-exports`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(filter),
    });
    expect(created.status).toBe(201);
    archiveId = ((await created.json()) as { id: string }).id;
    const claims = await Promise.all([
      exports.claim(),
      new LogExportService(db, storage).claim(),
    ]);
    const job = claims.find(Boolean);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(job?.id).toBe(archiveId);
    await exports.process(required(job));
    const list = await exports.list(tenant);
    expect(list.jobs[0]).toMatchObject({
      id: archiveId,
      status: 'completed',
      rowCount: 1201,
      attempts: 1,
    });
    expect(JSON.stringify(list)).not.toContain('object_key');
    expect(JSON.stringify(list)).not.toContain('lease_id');
    const downloaded = await fetch(
      `${url}/${tenant}/log-exports/${archiveId}/download`,
      { headers: headers() },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('cache-control')).toBe('no-store');
    expect(downloaded.headers.get('content-type')).toContain(
      'application/x-ndjson',
    );
    const lines = (await downloaded.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1201);
    expect(new Set(lines.map((line) => line.id)).size).toBe(1201);
    expect(
      lines.every(
        (line) => line.path === '/products' && !('export_cursor' in line),
      ),
    ).toBe(true);
  }, 30000);
  it('denies anonymous object access and cross-tenant archive access', async () => {
    const [job] = await db.query(
      'SELECT object_key FROM public.log_export_jobs WHERE id=$1',
      [archiveId],
    );
    expect(
      (await fetch(`${endpoint}/${bucket}/${job.object_key}`)).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/${other}/log-exports/${archiveId}/download`, {
          headers: headers(other),
        })
      ).status,
    ).toBe(404);
    expect((await exports.list(other)).jobs).toEqual([]);
  });
  it('exports status/prefix filters literally and stores a valid empty archive', async () => {
    await exports.create(tenant, {
      ...filter,
      minStatusCode: 500,
      pathPrefix: '/products',
    });
    const filtered = await exports.claim();
    await exports.process(required(filtered));
    expect((await exports.list(tenant)).jobs[0].rowCount).toBe(600);
    await exports.create(tenant, { ...filter, pathPrefix: '/%' });
    const empty = await exports.claim();
    await exports.process(required(empty));
    const latest = (await exports.list(tenant)).jobs[0];
    expect(latest).toMatchObject({
      rowCount: 0,
      bytes: 0,
      status: 'completed',
    });
    const stream = await exports.download(tenant, latest.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).length).toBe(0);
  }, 30000);
  it('keeps a stable snapshot while new logs arrive between pages', async () => {
    const [{ count }] = await db.query(
      `SELECT COUNT(*)::integer AS count FROM ${tenantSchema(tenant)}.request_logs`,
    );
    const appended = randomUUID();
    const original = storage.upload.bind(storage);
    const upload = jest
      .spyOn(storage, 'upload')
      .mockImplementationOnce(async (key, body, signal) => {
        const iterator = body[Symbol.asyncIterator]();
        const first = await iterator.next();
        await db.query(
          `INSERT INTO ${tenantSchema(tenant)}.request_logs (id,method,path,"statusCode",timestamp) VALUES ($1,'GET','/snapshot-after-start',200,$2)`,
          [appended, new Date(now.getTime() - 50000).toISOString()],
        );
        await original(
          key,
          Readable.from(
            (async function* () {
              if (!first.done) yield first.value;
              for await (const chunk of iterator) yield chunk;
            })(),
          ),
          signal,
        );
      });
    const created = await exports.create(tenant, filter);
    const claimed = await exports.claim();
    try {
      await exports.process(required(claimed));
    } finally {
      upload.mockRestore();
    }
    const stream = await exports.download(tenant, created.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const records = Buffer.concat(chunks)
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(count);
    expect(records.some((record) => record.id === appended)).toBe(false);
    expect(
      records.every((record) => String(record.timestamp).endsWith('Z')),
    ).toBe(true);
  }, 30000);
  it('allows only one active export per tenant across replicas', async () => {
    await exports.create(tenant, filter);
    await exports.create(tenant, filter);
    const claims = await Promise.all([
      exports.claim(),
      new LogExportService(db, storage).claim(),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await exports.process(required(claims.find(Boolean)));
    const next = await exports.claim();
    expect(next).toBeDefined();
    await exports.process(required(next));
  }, 30000);
  it('recovers an expired lease after a worker restart and fences a stale worker', async () => {
    const created = await exports.create(tenant, filter);
    const stale = await exports.claim();
    await db.query(
      `UPDATE public.log_export_jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1`,
      [created.id],
    );
    const restarted = new LogExportService(db, storage);
    const reclaimed = await restarted.claim();
    expect(reclaimed?.lease_id).not.toBe(stale?.lease_id);
    expect(reclaimed?.attempts).toBe(2);
    await restarted.process(required(reclaimed));
    await exports.process(required(stale));
    const [record] = await db.query(
      `SELECT * FROM public.log_export_jobs WHERE id=$1`,
      [created.id],
    );
    expect(record.status).toBe('completed');
    expect(record.object_key).toContain(required(reclaimed).lease_id);
    await expect(
      storage.download(
        `tenants/${tenant}/log-exports/${created.id}/${required(stale).lease_id}.ndjson`,
      ),
    ).rejects.toMatchObject({ name: 'NoSuchKey' });
  }, 30000);
  it('preserves failed-job retries and expires private objects without exposing downloads', async () => {
    const created = await exports.create(tenant, filter);
    const upload = jest
      .spyOn(storage, 'upload')
      .mockRejectedValueOnce(new Error('Simulated storage outage'));
    const job = await exports.claim();
    await exports.process(required(job));
    upload.mockRestore();
    expect((await exports.list(tenant)).jobs[0]).toMatchObject({
      id: created.id,
      status: 'queued',
      attempts: 1,
    });
    const retry = await exports.claim();
    await exports.process(required(retry));
    expect((await exports.list(tenant)).jobs[0]).toMatchObject({
      status: 'completed',
      attempts: 2,
    });
    await db.query(
      `UPDATE public.log_export_jobs SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`,
      [created.id],
    );
    await exports.cleanupExpired();
    expect(
      (
        await fetch(`${url}/${tenant}/log-exports/${created.id}/download`, {
          headers: headers(),
        })
      ).status,
    ).toBe(404);
    const [record] = await db.query(
      'SELECT * FROM public.log_export_jobs WHERE id=$1',
      [created.id],
    );
    expect(record.status).toBe('expired');
    await expect(storage.download(record.object_key)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  }, 30000);
  it('streams multipart objects and aborts unfinished uploads during prefix cleanup', async () => {
    const prefix = `tenants/${tenant}/log-exports/${randomUUID()}/`;
    const key = prefix + 'multipart.ndjson';
    await storage.upload(
      key,
      Readable.from(
        (async function* () {
          for (let i = 0; i < 12; i++) yield Buffer.alloc(1024 * 1024, i);
        })(),
      ),
      new AbortController().signal,
    );
    const download = await storage.download(key);
    let bytes = 0;
    for await (const chunk of download) bytes += chunk.length;
    expect(bytes).toBe(12 * 1024 * 1024);
    await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: prefix + 'unfinished.ndjson',
      }),
    );
    expect(
      (
        await client.send(
          new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
        )
      ).Uploads,
    ).toHaveLength(1);
    await storage.cleanup(prefix);
    expect(
      (
        await client.send(
          new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
        )
      ).Uploads ?? [],
    ).toHaveLength(0);
    await expect(storage.download(key)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  }, 30000);
  it('RustFS retains its private ACL and pre-cancelled uploads do not leak objects', async () => {
    await client.send(
      new PutBucketAclCommand({ Bucket: bucket, ACL: 'public-read' }),
    );
    try {
      const acl = await client.send(
        new GetBucketAclCommand({ Bucket: bucket }),
      );
      expect(
        acl.Grants?.some((grant) =>
          grant.Grantee?.URI?.includes('/global/AllUsers'),
        ),
      ).toBe(false);
      expect((await fetch(`${endpoint}/${bucket}?list-type=2`)).status).toBe(
        403,
      );
      await storage.onModuleInit();
    } finally {
      await client.send(
        new PutBucketAclCommand({ Bucket: bucket, ACL: 'private' }),
      );
    }
    const abort = new AbortController();
    abort.abort();
    await expect(
      storage.upload(
        `tenants/${tenant}/cancelled.ndjson`,
        Readable.from(['cancelled']),
        abort.signal,
      ),
    ).rejects.toThrow('cancelled');
    await expect(
      storage.download(`tenants/${tenant}/cancelled.ndjson`),
    ).rejects.toMatchObject({ name: 'NoSuchKey' });
  });
  it('refuses a bucket that permits anonymous access without modifying its policy', async () => {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
      ],
    };
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify(policy),
      }),
    );
    try {
      await expect(storage.onModuleInit()).rejects.toThrow(
        'private access policy',
      );
    } finally {
      await client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    }
  });
  it('removes old metadata only after storage cleanup succeeds', async () => {
    const job = await exports.create(tenant, filter);
    const claimed = await exports.claim();
    await exports.process(required(claimed));
    const [record] = await db.query(
      'SELECT object_key FROM public.log_export_jobs WHERE id=$1',
      [job.id],
    );
    await db.query(
      `UPDATE public.log_export_jobs SET expires_at=NOW()-INTERVAL '31 days' WHERE id=$1`,
      [job.id],
    );
    const cleanup = jest
      .spyOn(storage, 'cleanup')
      .mockRejectedValueOnce(new Error('Cleanup outage'));
    await exports.cleanupExpired();
    cleanup.mockRestore();
    expect(
      await db.query('SELECT id FROM public.log_export_jobs WHERE id=$1', [
        job.id,
      ]),
    ).toHaveLength(1);
    await db.query(
      'UPDATE public.log_export_jobs SET cleanup_at=NULL WHERE id=$1',
      [job.id],
    );
    await exports.cleanupExpired();
    expect(
      await db.query('SELECT id FROM public.log_export_jobs WHERE id=$1', [
        job.id,
      ]),
    ).toHaveLength(0);
    await expect(storage.download(record.object_key)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  }, 30000);
  it('enforces per-tenant pending limits atomically', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => exports.create(other, filter)),
    );
    await expect(exports.create(other, filter)).rejects.toThrow(
      'Wait for your pending archives',
    );
  });
});
