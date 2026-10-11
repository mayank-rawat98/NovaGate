import { ConfigService } from '@nestjs/config';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { LogPrivacyService } from '../log-privacy/log-privacy.service';
import { LogRetentionService } from '../log-retention/log-retention.service';
import { ExportDestinationsService } from './export-destinations.service';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { ExportTransportService } from './export-transport.service';
import { ExportDeliveryWorkerService } from './export-delivery-worker.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const keys = {
  LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({
    test: Buffer.alloc(32, 7).toString('base64'),
  }),
  LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'test',
};
integration('Durable external log delivery on real PostgreSQL', () => {
  let root: DataSource, db: DataSource;
  let store: ExportDeliveryStoreService,
    replica: ExportDeliveryStoreService,
    destinations: ExportDestinationsService;
  const tenant = randomUUID(),
    other = randomUUID(),
    record = randomUUID(),
    second = randomUUID();
  const database = `novagate_delivery_${randomUUID().replace(/-/g, '')}`;
  const config = new ConfigService(keys);
  const runtimeWorkers = new Set<ExportDeliveryWorkerService>();
  const runtimeCases = new Set<Promise<void>>();
  let destination: { id: string; revision: string };
  async function source(id: string, owner = tenant) {
    await db.query(
      `INSERT INTO ${tenantSchema(owner)}.request_logs
      (id,method,path,"statusCode","responseTimeMs","requestId","clientIp","userAgent",timestamp)
      VALUES ($1,'GET','/private-account',200,2,$2,'203.0.113.1','private-agent','2001-01-01T00:00:00Z')`,
      [id, randomUUID()],
    );
  }
  async function admit(
    id: string = randomUUID(),
    ids: string[] = [record],
    privacy?: Parameters<typeof store.admit>[4],
  ) {
    return store.admit(tenant, destination.id, id, ids, privacy);
  }
  async function claimed(owner = store) {
    const lease = await owner.claim(tenant, destination.id);
    expect(lease).toBeDefined();
    if (!lease) throw new Error('Expected an owned delivery lease');
    return lease;
  }
  async function due(id: string) {
    await db.query(
      "UPDATE public.log_export_deliveries SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [id],
    );
  }
  async function raw(id: string) {
    const [row] = await db.query(
      'SELECT * FROM public.log_export_deliveries WHERE id=$1',
      [id],
    );
    return row;
  }
  async function stalledWorker(
    operation: (
      worker: ExportDeliveryWorkerService,
      work: Promise<unknown>,
      closed: Promise<unknown>,
      id: string,
    ) => Promise<void>,
  ) {
    const owned = (async () => {
      const sockets = new Set<import('node:net').Socket>();
      const server = http.createServer((req) => req.resume());
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      let privateStore: ExportDeliveryStoreService | undefined;
      let transport: ExportTransportService | undefined;
      let worker: ExportDeliveryWorkerService | undefined;
      let work: Promise<unknown> | undefined;
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const cipher = new ExportDestinationCredentialCipher(keys);
        try {
          await db.query(
            'UPDATE public.log_export_destinations SET credentials=$2::jsonb WHERE id=$1',
            [
              destination.id,
              JSON.stringify(
                cipher.encrypt(tenant, destination.id, 'webhook', {
                  type: 'webhook',
                  url: `${origin}/inbox`,
                  signingSecret: 'fixture-signing-secret-more-than-32-bytes',
                }),
              ),
            ],
          );
        } finally {
          cipher.destroy();
        }
        const settings = new ConfigService({
          ...keys,
          LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
        });
        privateStore = new ExportDeliveryStoreService(db, settings);
        transport = new ExportTransportService(settings);
        worker = new ExportDeliveryWorkerService(privateStore, transport);
        runtimeWorkers.add(worker);
        const received = once(server, 'request');
        const id = (await admit()).id;
        work = worker.deliverNext(
          tenant,
          destination.id,
          new AbortController().signal,
        );
        const [req] = await Promise.race([
          received,
          work.then(() => {
            throw new Error(
              'Attempt ended before reaching the controlled receiver',
            );
          }),
        ]);
        // Observe actual owned socket termination, not just an abort signal or rejected promise.
        const closed = once((req as http.IncomingMessage).socket, 'close');
        await operation(worker, work, closed, id);
      } finally {
        await worker?.onModuleDestroy();
        await Promise.allSettled(work ? [work] : []);
        await transport?.onModuleDestroy();
        await privateStore?.onModuleDestroy();
        if (worker) runtimeWorkers.delete(worker);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((done) => server.close(() => done()));
      }
    })();
    runtimeCases.add(owned);
    try {
      await owned;
    } finally {
      runtimeCases.delete(owned);
    }
  }
  beforeAll(async () => {
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${database}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      extra: { max: 12, connectionTimeoutMillis: 3000 },
    });
    await db.initialize();
    await db.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    for (const id of [tenant, other]) {
      await db.query(
        "INSERT INTO public.tenants (id,name,email,\"planId\") VALUES ($1,'Delivery',$2,'free')",
        [id, `${id}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(id);
    }
    await new MigrationService(db).onModuleInit();
  }, 30000);
  beforeEach(async () => {
    await db.query(
      'DELETE FROM public.log_export_deliveries; DELETE FROM public.log_export_destinations; DELETE FROM public.log_export_delivery_history_totals',
    );
    await db.query(`UPDATE public.tenants SET "logPrivacy"='{"clientIp":"omit","userAgent":"omit"}',
      "logPrivacyRevision"=gen_random_uuid(),"logPrivacyScrubDone"=true,"logRetentionDays"=30,
      "logRetentionRevision"=gen_random_uuid(),"logRetentionFloor"=clock_timestamp()-INTERVAL '720 hours'`);
    for (const id of [tenant, other])
      await db.query(`DELETE FROM ${tenantSchema(id)}.request_logs`);
    await source(record);
    await source(second);
    store = new ExportDeliveryStoreService(db, config);
    replica = new ExportDeliveryStoreService(db, config);
    destinations = new ExportDestinationsService(db, config);
    destination = await destinations.create(tenant, {
      name: 'Operations',
      credentials: {
        type: 'webhook',
        url: 'https://logs.example.com/private',
        signingSecret: 'private-secret-with-more-than-32-bytes',
      },
    });
  });
  afterEach(async () => {
    await Promise.all(
      [...runtimeWorkers].map((worker) => worker.onModuleDestroy()),
    );
    await Promise.allSettled([...runtimeCases]);
    await Promise.all([
      store.onModuleDestroy(),
      replica.onModuleDestroy(),
      destinations.onModuleDestroy(),
    ]);
  }, 30000);
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const work of [
      async () => {
        if (db?.isInitialized) await db.destroy();
      },
      async () => {
        if (root?.isInitialized)
          await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      },
      async () => {
        if (root?.isInitialized) await root.destroy();
      },
    ]) {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Delivery fixture cleanup failed');
  });
  it('snapshots database receipts, tenant privacy and only documented records', async () => {
    const delivery = await admit();
    const row = await raw(delivery.id);
    expect(delivery.status).toBe('queued');
    expect(delivery.recordCount).toBe(1);
    expect(JSON.stringify(delivery)).not.toMatch(
      /private|credentials|payload|source_ids/,
    );
    expect(row.payload.records[0]).toMatchObject({
      id: record,
      clientIp: '[redacted]',
      timestamp: '2001-01-01T00:00:00.000000Z',
    });
    expect(JSON.stringify(row.payload)).not.toMatch(
      /203\.0\.113|private-agent|receipt|receivedAt|signingSecret/,
    );
    expect(row.receipt_from.getTime()).toBeGreaterThan(Date.now() - 10000);
    await new MigrationService(db).onModuleInit();
    expect((await raw(delivery.id)).payload).toEqual(row.payload);
  });
  it('applies destination omissions even when tenant metadata is retained', async () => {
    await db.query(
      `UPDATE public.tenants SET "logPrivacy"='{"clientIp":"retain","userAgent":"retain"}' WHERE id=$1`,
      [tenant],
    );
    const row = await raw(
      (
        await admit(undefined, undefined, {
          clientIp: 'omit',
          userAgent: 'retain',
          redactedFields: ['path', 'requestId'],
        })
      ).id,
    );
    expect(row.payload.records[0]).toMatchObject({
      clientIp: '[redacted]',
      path: '[redacted]',
      requestId: '[redacted]',
      userAgent: 'private-agent',
    });
  });
  it('keeps one immutable snapshot and stable ID across replicas and duplicate admissions', async () => {
    const id = randomUUID();
    const first = await admit(id, [second, record]);
    await db.query(
      `UPDATE ${tenantSchema(tenant)}.request_logs SET path='/changed'`,
    );
    const again = await replica.admit(tenant, destination.id, id, [
      record,
      second,
    ]);
    expect(again).toEqual(first);
    expect(
      (await raw(id)).payload.records.every(
        (r: { path: string }) => r.path === '/private-account',
      ),
    ).toBe(true);
    expect(await store.history(tenant, destination.id)).toHaveLength(1);
  });
  it('rejects delivery ID reuse with different records, policy or tenant', async () => {
    const id = (await admit()).id;
    await expect(admit(id, [second])).rejects.toBeInstanceOf(ConflictException);
    await expect(
      admit(id, [record], { clientIp: 'omit', userAgent: 'omit' }),
    ).rejects.toBeInstanceOf(ConflictException);
    const foreign = await destinations.create(other, {
      name: 'Other',
      credentials: {
        type: 'datadog',
        site: 'datadoghq.eu',
        apiKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    await source(randomUUID(), other);
    await expect(
      store.admit(other, foreign.id, id, [record]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await store.history(other, destination.id)).toEqual([]);
  });
  it.each(['missing', 'foreign', 'expired', 'duplicate', 'empty', 'oversized'])(
    'rejects %s source selection before it enters the outbox',
    async (kind) => {
      let ids = [record];
      if (kind === 'missing') ids = [randomUUID()];
      if (kind === 'foreign') {
        const id = randomUUID();
        await source(id, other);
        ids = [id];
      }
      if (kind === 'expired')
        await db.query(
          `UPDATE ${tenantSchema(tenant)}.request_logs SET "receivedAt"=clock_timestamp()-INTERVAL '721 hours' WHERE id=$1`,
          [record],
        );
      if (kind === 'duplicate') ids = [record, record];
      if (kind === 'empty') ids = [];
      if (kind === 'oversized')
        ids = Array.from({ length: 257 }, () => randomUUID());
      await expect(admit(undefined, ids)).rejects.toThrow();
      expect(await store.history(tenant, destination.id)).toEqual([]);
    },
  );
  it('preserves the exact PostgreSQL microsecond receipt floor', async () => {
    const [{ floor }] = await db.query(
      `SELECT to_char((clock_timestamp()-INTERVAL '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS floor`,
    );
    await db.query(
      'UPDATE public.tenants SET "logRetentionFloor"=$2::timestamptz WHERE id=$1',
      [tenant, floor],
    );
    await db.query(
      `UPDATE ${tenantSchema(tenant)}.request_logs SET "receivedAt"=$2::timestamptz-INTERVAL '1 microsecond' WHERE id=$1`,
      [record, floor],
    );
    await db.query(
      `UPDATE ${tenantSchema(tenant)}.request_logs SET "receivedAt"=$2::timestamptz WHERE id=$1`,
      [second, floor],
    );
    await expect(admit()).rejects.toBeInstanceOf(ConflictException);
    expect((await admit(undefined, [second])).recordCount).toBe(1);
  });
  it('enforces the pending cap atomically across replicas', async () => {
    for (let i = 0; i < 19; i++) await admit();
    const attempts = await Promise.allSettled([
      admit(),
      replica.admit(tenant, destination.id, randomUUID(), [record]),
    ]);
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(await store.history(tenant, destination.id)).toHaveLength(20);
  });
  it('claims a queued batch once across independent replicas', async () => {
    await admit();
    const leases = await Promise.all([
      store.claim(tenant, destination.id),
      replica.claim(tenant, destination.id),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect(leases.find(Boolean)?.attempts).toBe(1);
  });
  it('bounds retained history without evicting young delivery identities', async () => {
    const id = (await admit()).id;
    await db.query(
      `INSERT INTO public.log_export_deliveries
      (id,tenant_id,destination_id,destination_revision,privacy_revision,retention_revision,source_ids,payload_privacy,receipt_from,record_count,status,expires_at,completed_at)
      SELECT gen_random_uuid(),j.tenant_id,j.destination_id,j.destination_revision,j.privacy_revision,j.retention_revision,
        j.source_ids,j.payload_privacy,j.receipt_from,j.record_count,'delivered',j.expires_at,clock_timestamp()
      FROM public.log_export_deliveries j CROSS JOIN generate_series(1,999) WHERE j.id=$1`,
      [id],
    );
    await expect(admit()).rejects.toBeInstanceOf(ConflictException);
    expect((await admit(id)).id).toBe(id);
    await store.cleanup();
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::integer AS count FROM public.log_export_deliveries',
        )
      )[0].count,
    ).toBe(1000);
    await db.query(
      "UPDATE public.log_export_deliveries SET completed_at=clock_timestamp()-INTERVAL '169 hours' WHERE status='delivered'",
    );
    await store.cleanup();
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::integer AS count FROM public.log_export_deliveries',
        )
      )[0].count,
    ).toBe(500);
    expect((await admit()).status).toBe('queued');
  });
  it('fences stale lease acknowledgement after recovery', async () => {
    const id = (await admit()).id;
    const original = await claimed(store);
    await db.query(
      "UPDATE public.log_export_deliveries SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [id],
    );
    const recovery = await claimed(replica);
    expect(recovery.id).toBe(original.id);
    expect(recovery.leaseId).not.toBe(original.leaseId);
    expect(recovery.batch).toEqual(original.batch);
    expect(recovery.attempts).toBe(2);
    expect(
      await store.finish(tenant, id, original.leaseId, { delivered: true }),
    ).toBe(false);
    expect(
      await replica.finish(tenant, id, recovery.leaseId, { delivered: true }),
    ).toBe(true);
    expect((await raw(id)).payload).toBeNull();
  });
  it('persists bounded backoff and terminates at six attempts', async () => {
    const id = (await admit()).id;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const lease = await claimed(store);
      expect(lease.attempts).toBe(attempt);
      await store.finish(tenant, id, lease.leaseId, {
        delivered: false,
        code: 'http_retryable',
        retryable: true,
      });
      const row = await raw(id);
      expect(row.status).toBe(attempt < 6 ? 'queued' : 'failed');
      if (attempt < 6) {
        expect(await store.claim(tenant, destination.id)).toBeUndefined();
        await due(id);
      }
    }
    expect((await raw(id)).payload).toBeNull();
    expect(await store.claim(tenant, destination.id)).toBeUndefined();
  });
  it('terminates an expired sixth lease instead of stranding it in processing', async () => {
    const id = (await admit()).id;
    await store.claim(tenant, destination.id);
    await db.query(
      "UPDATE public.log_export_deliveries SET attempts=6,lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
      [id],
    );
    expect(await replica.claim(tenant, destination.id)).toBeUndefined();
    expect(await raw(id)).toMatchObject({
      status: 'failed',
      error: 'attempts_exhausted',
      payload: null,
      lease_id: null,
    });
  });
  it('erases payload on a permanent error and stores only a fixed error code', async () => {
    const id = (await admit()).id;
    const lease = await claimed(store);
    await store.finish(tenant, id, lease.leaseId, {
      delivered: false,
      code: 'https://secret:credential@example.com/response',
      retryable: false,
    });
    expect(await raw(id)).toMatchObject({
      status: 'failed',
      error: 'delivery_failed',
      payload: null,
    });
    expect(
      JSON.stringify(await store.history(tenant, destination.id)),
    ).not.toMatch(/secret|credential|payload|response/);
  });
  it('backs off unavailable credentials without consuming unbounded retries', async () => {
    const id = (await admit()).id;
    const missing = new ExportDeliveryStoreService(db, new ConfigService({}));
    try {
      for (let attempt = 1; attempt <= 6; attempt++) {
        expect(await missing.claim(tenant, destination.id)).toBeUndefined();
        expect((await raw(id)).attempts).toBe(attempt);
        if (attempt < 6) {
          expect(await missing.claim(tenant, destination.id)).toBeUndefined();
          await due(id);
        }
      }
      expect(await raw(id)).toMatchObject({
        status: 'failed',
        error: 'credentials_unavailable',
        payload: null,
      });
    } finally {
      await missing.onModuleDestroy();
    }
  });
  it.each(['update', 'rotate', 'remove'])(
    'revokes payload and lease in the same destination %s transaction',
    async (kind) => {
      const id = (await admit()).id;
      const lease = await claimed(store);
      if (kind === 'update')
        await destinations.update(tenant, destination.id, {
          name: 'Renamed',
          expectedRevision: destination.revision,
        });
      if (kind === 'rotate')
        await destinations.rotateKey(tenant, destination.id, {
          expectedRevision: destination.revision,
        });
      if (kind === 'remove')
        await destinations.remove(tenant, destination.id, {
          expectedRevision: destination.revision,
        });
      expect(await raw(id)).toMatchObject({
        status: 'expired',
        error: 'destination_changed',
        payload: null,
        lease_id: null,
      });
      expect(
        await store.finish(tenant, id, lease.leaseId, { delivered: true }),
      ).toBe(false);
    },
  );
  it('revokes batches atomically with an actual tenant privacy save', async () => {
    const id = (await admit()).id;
    const lease = await claimed(store);
    const privacy = new LogPrivacyService(db, {
      persistUpdate: async () => undefined,
      publish: async () => undefined,
    } as never);
    try {
      const current = await privacy.get(tenant);
      await privacy.save(tenant, {
        expectedRevision: current.revision,
        policy: {
          clientIp: 'omit',
          userAgent: 'omit',
          redactedFields: ['path'],
        },
      });
      expect(await raw(id)).toMatchObject({ status: 'expired', payload: null });
      expect(
        await store.finish(tenant, id, lease.leaseId, { delivered: true }),
      ).toBe(false);
    } finally {
      await privacy.onModuleDestroy();
    }
  });
  it('keeps reads non-mutating and revokes batches with an actual retention save', async () => {
    const id = (await admit()).id;
    const retention = new LogRetentionService(db);
    try {
      const current = await retention.get(tenant);
      expect((await raw(id)).status).toBe('queued');
      await retention.save(tenant, {
        expectedRevision: current.revision,
        days: 1,
      });
      expect(await raw(id)).toMatchObject({ status: 'expired', payload: null });
    } finally {
      await retention.onModuleDestroy();
    }
  });
  it('checks advancing receipt retention before an attempt and acknowledgement', async () => {
    const id = (await admit()).id;
    const lease = await claimed(store);
    await db.query(
      "UPDATE public.log_export_deliveries SET receipt_from=clock_timestamp()-INTERVAL '721 hours' WHERE id=$1",
      [id],
    );
    expect(
      await store.finish(tenant, id, lease.leaseId, { delivered: true }),
    ).toBe(false);
    expect(await raw(id)).toMatchObject({ status: 'expired', payload: null });
  });
  it('expires payloads and removes only completed seven-day history', async () => {
    const id = (await admit()).id;
    await db.query(
      "UPDATE public.log_export_deliveries SET expires_at=clock_timestamp()-INTERVAL '1 microsecond' WHERE id=$1",
      [id],
    );
    await store.cleanup();
    expect(await raw(id)).toMatchObject({ status: 'expired', payload: null });
    await store.cleanup();
    expect(await raw(id)).toBeDefined();
    await db.query(
      "UPDATE public.log_export_deliveries SET completed_at=clock_timestamp()-INTERVAL '169 hours' WHERE id=$1",
      [id],
    );
    await store.cleanup();
    expect(await raw(id)).toBeUndefined();
  });
  it('delivers the same stored bytes after a real HTTP failure and reconstruction of the worker', async () => {
    const bodies: Buffer[] = [];
    const identities: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        identities.push(String(req.headers['x-novagate-delivery-id']));
        res.statusCode = bodies.length === 1 ? 503 : 200;
        res.end('accepted');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const connection = {
      type: 'webhook',
      url: `${origin}/inbox`,
      signingSecret: 'fixture-signing-secret-more-than-32-bytes',
    };
    const cipher = new ExportDestinationCredentialCipher(keys);
    await db.query(
      'UPDATE public.log_export_destinations SET credentials=$2::jsonb WHERE id=$1',
      [
        destination.id,
        JSON.stringify(
          cipher.encrypt(tenant, destination.id, 'webhook', connection),
        ),
      ],
    );
    cipher.destroy();
    const local = new ConfigService({
      ...keys,
      LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
    });
    const worker = new ExportDeliveryStoreService(db, local),
      transport = new ExportTransportService(local);
    const runner = new ExportDeliveryWorkerService(worker, transport);
    let restarted: ExportDeliveryStoreService | undefined;
    let restartedRunner: ExportDeliveryWorkerService | undefined;
    try {
      const id = (await admit()).id;
      expect(
        await runner.deliverNext(
          tenant,
          destination.id,
          new AbortController().signal,
        ),
      ).toBe('retrying');
      await runner.onModuleDestroy();
      await worker.onModuleDestroy();
      await db.query(
        `UPDATE ${tenantSchema(tenant)}.request_logs SET path='/changed'`,
      );
      await due(id);
      restarted = new ExportDeliveryStoreService(db, local);
      restartedRunner = new ExportDeliveryWorkerService(restarted, transport);
      expect(
        await restartedRunner.deliverNext(
          tenant,
          destination.id,
          new AbortController().signal,
        ),
      ).toBe('delivered');
      expect(identities).toEqual([id, id]);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0].toString()).not.toMatch(
        /private-agent|203\.0\.113|changed|receivedAt/,
      );
      expect(await raw(id)).toMatchObject({
        status: 'delivered',
        attempts: 2,
        payload: null,
      });
    } finally {
      await runner.onModuleDestroy();
      await restartedRunner?.onModuleDestroy();
      await transport.onModuleDestroy();
      await worker.onModuleDestroy();
      await restarted?.onModuleDestroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it('waits for owned SQL work on shutdown and rejects new admissions', async () => {
    await admit();
    const lock = db.createQueryRunner();
    await lock.connect();
    await lock.startTransaction();
    try {
      await lock.query(
        'SELECT id FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE',
        [tenant],
      );
      const claim = store.claim(tenant, destination.id);
      // Promise scheduling starts the owned transaction before shutdown seals admission.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      let closed = false;
      const closing = store.onModuleDestroy().then(() => {
        closed = true;
      });
      await expect(store.claim(tenant, destination.id)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(closed).toBe(false);
      await lock.commitTransaction();
      await claim;
      await closing;
      expect(closed).toBe(true);
    } finally {
      if (lock.isTransactionActive) await lock.rollbackTransaction();
      await lock.release();
    }
  });
  it('cancels the actual in-flight socket when a destination revision is revoked', async () => {
    await stalledWorker(async (_worker, work, closed, id) => {
      await destinations.update(tenant, destination.id, {
        name: 'Revised',
        expectedRevision: destination.revision,
      });
      expect(await work).toBe('revoked');
      await closed;
      expect(await raw(id)).toMatchObject({
        status: 'expired',
        payload: null,
        lease_id: null,
      });
    });
  });
  it('drains an actual in-flight request on worker shutdown and retains bounded retry state', async () => {
    await stalledWorker(async (worker, work, closed, id) => {
      await worker.onModuleDestroy();
      await closed;
      expect(await work).toBe('retrying');
      expect(await raw(id)).toMatchObject({
        status: 'queued',
        attempts: 1,
        error: 'cancelled',
        lease_id: null,
      });
      await expect(
        worker.deliverNext(
          tenant,
          destination.id,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'cancelled' });
    });
  });
  it('holds all four worker admissions through actual cancellation', async () => {
    await stalledWorker(async (worker, work, closed) => {
      for (let i = 0; i < 3; i++) await admit();
      const siblings = Array.from({ length: 3 }, () =>
        worker.deliverNext(
          tenant,
          destination.id,
          new AbortController().signal,
        ),
      );
      const settled = Promise.allSettled(siblings);
      await expect(
        worker.deliverNext(
          tenant,
          destination.id,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'busy' });
      await worker.onModuleDestroy();
      await closed;
      expect(await work).toBe('retrying');
      expect(
        (await settled).every(
          (result) =>
            result.status === 'fulfilled' && result.value === 'retrying',
        ),
      ).toBe(true);
    });
  });
});
