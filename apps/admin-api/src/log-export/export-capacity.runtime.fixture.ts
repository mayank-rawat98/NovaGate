import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { ExportDestinationsService } from './export-destinations.service';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { ExportDeliveryWorkerService } from './export-delivery-worker.service';
import { ExportTransportService } from './export-transport.service';

async function verifyCapacity() {
  // No public application endpoint: exercise real source/store/worker code directly
  // through 1,101 settled windows. Bootstrap/fair timer behavior has its own smoke.
  const windows = 1101;
  const tenant = randomUUID(),
    database = `novagate_capacity_${randomUUID().replaceAll('-', '')}`;
  const schema = tenantSchema(tenant),
    signingSecret = 'bounded-capacity-fixture-signing-secret-at-least-32-bytes';
  const keySettings = {
    LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({
      fixture: randomBytes(32).toString('base64'),
    }),
    LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'fixture',
  };
  const url = process.env.EXPORT_CAPACITY_DATABASE_URL;
  assert.ok(
    url,
    'Capacity verification requires the disposable PostgreSQL URL',
  );
  assert.equal(process.getuid?.(), 1000, 'Use the production image node user');
  const root = new DataSource({
    type: 'postgres',
    url,
    extra: {
      max: 2,
      connectionTimeoutMillis: 3000,
      options: '-c statement_timeout=3000 -c lock_timeout=1000',
    },
  });
  let db: DataSource | undefined,
    store: ExportDeliveryStoreService | undefined,
    worker: ExportDeliveryWorkerService | undefined;
  let destinations: ExportDestinationsService | undefined,
    transport: ExportTransportService | undefined,
    cipher: ExportDestinationCredentialCipher | undefined;
  let server: Server | undefined,
    created = false;
  const sockets = new Set<Socket>(),
    errors: unknown[] = [];
  const received = new Set<string>(),
    deliveries = new Set<string>();
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 120000);
  const failures: unknown[] = [];
  let evidence: Record<string, unknown> | undefined;
  try {
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    created = true;
    const ownedUrl = new URL(url);
    ownedUrl.pathname = `/${database}`;
    db = new DataSource({
      type: 'postgres',
      url: ownedUrl.toString(),
      extra: {
        max: 4,
        connectionTimeoutMillis: 3000,
        options:
          '-c timezone=America/New_York -c statement_timeout=3000 -c lock_timeout=1000',
      },
    });
    await db.initialize();
    await db.query(readFileSync('/app/verification/postgres-init.sql', 'utf8'));
    await db.query(
      "INSERT INTO public.tenants (id,name,email,\"planId\") VALUES ($1,'Capacity fixture',$2,'free')",
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    await new MigrationService(db).onModuleInit();
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          errors.push(new Error('Fixture body exceeded the transport bound'));
          request.destroy();
        } else chunks.push(chunk);
      });
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks),
            id = request.headers['x-novagate-delivery-id'],
            timestamp = request.headers['x-novagate-timestamp'];
          assert.equal(request.method, 'POST');
          assert.equal(request.url, '/capacity');
          assert.equal(typeof id, 'string');
          assert.equal(typeof timestamp, 'string');
          assert.equal(
            request.headers['x-novagate-signature'],
            `v1=${createHmac('sha256', signingSecret).update(`${timestamp}.${id}.`).update(body).digest('hex')}`,
          );
          assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30);
          assert.equal(
            deliveries.has(id as string),
            false,
            'A source window was replayed',
          );
          const records = body
            .toString('utf8')
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line));
          assert.equal(records.length, 1);
          const row = records[0];
          assert.equal(row.timestamp, '2001-01-01T00:00:00.000000Z');
          assert.equal(row.clientIp, '[redacted]');
          assert.equal(row.userAgent, undefined);
          assert.equal(row.receivedAt, undefined);
          assert.equal(
            received.has(row.id),
            false,
            'A receipt was delivered twice',
          );
          received.add(row.id);
          deliveries.add(id as string);
          response.writeHead(202);
          response.end('Accepted by controlled fixture');
        } catch (error) {
          errors.push(error);
          response.writeHead(400);
          response.end('Fixture rejected payload');
        }
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = new ConfigService({
      ...keySettings,
      LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
    });
    destinations = new ExportDestinationsService(db, config);
    transport = new ExportTransportService(config);
    store = new ExportDeliveryStoreService(db, config);
    worker = new ExportDeliveryWorkerService(store, transport);
    const destination = await destinations.create(tenant, {
      name: 'Capacity fixture',
      credentials: {
        type: 'webhook',
        url: 'https://logs.example.com/fixture',
        signingSecret,
      },
    });
    cipher = new ExportDestinationCredentialCipher(keySettings);
    await db.query(
      'UPDATE public.log_export_destinations SET credentials=$2::jsonb WHERE id=$1',
      [
        destination.id,
        JSON.stringify(
          cipher.encrypt(tenant, destination.id, 'webhook', {
            type: 'webhook',
            url: `${origin}/capacity`,
            signingSecret,
          }),
        ),
      ],
    );
    const policy = { clientIp: 'omit', userAgent: 'omit' } as const;
    await store.saveSchedule(tenant, destination.id, {
      enabled: true,
      cadence: 'near_real_time',
      filter: {},
      payloadPrivacy: policy,
      expectedRevision: null,
      expectedDestinationRevision: destination.revision,
    });
    // Fixture-owned closed backlog; normal first-save behavior never backfills.
    const [{ start }] = await db.query(
      `SELECT to_char(date_bin(INTERVAL '1 minute',clock_timestamp()-make_interval(secs=>($1::integer+3)*60),'1970-01-01T00:00:00Z'::timestamptz)
    AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start`,
      [windows],
    );
    await db.query(
      'UPDATE public.log_export_delivery_schedules SET started_at=$2::timestamptz,cursor_at=$2::timestamptz,cursor_id=NULL,next_due_at=$2::timestamptz WHERE destination_id=$1',
      [destination.id, start],
    );
    const records: Array<{ id: string }> = await db.query(
      `INSERT INTO ${schema}.request_logs
    (id,method,path,"statusCode","responseTimeMs","requestId","clientIp","userAgent",timestamp,"receivedAt")
    SELECT gen_random_uuid(),'GET','/capacity-receipt',200,1,gen_random_uuid()::text,'203.0.113.16','private-fixture-agent','2001-01-01T00:00:00Z',
      $1::timestamptz+make_interval(secs=>(n-1)*60+10) FROM generate_series(1,$2::integer) n RETURNING id`,
      [start, windows],
    );
    // Synthetic caller metadata fills the independent identity budget. All scheduled
    // batches below come from the actual immutable source-admission transaction.
    const manual: Array<{ id: string }> = await db.query(
      `INSERT INTO public.log_export_deliveries
    (id,tenant_id,destination_id,destination_revision,privacy_revision,retention_revision,source_ids,payload_privacy,receipt_from,record_count,
     status,attempts,expires_at,created_at,completed_at)
    SELECT gen_random_uuid(),t.id,d.id,d.revision,t."logPrivacyRevision",t."logRetentionRevision",$3::uuid[],$4::jsonb,$5::timestamptz,1,
      'delivered',1,clock_timestamp()+INTERVAL '1 hour',clock_timestamp()-INTERVAL '1 hour',clock_timestamp()-INTERVAL '1 hour'
    FROM public.tenants t JOIN public.log_export_destinations d ON d.tenant_id=t.id CROSS JOIN generate_series(1,1000) n
    WHERE t.id=$1 AND d.id=$2 RETURNING id`,
      [tenant, destination.id, [records[0].id], JSON.stringify(policy), start],
    );
    const started = performance.now();
    let resumedCursor: string | undefined;
    for (let i = 0; i < windows; i++) {
      controller.signal.throwIfAborted();
      assert.equal(await store.produceNext(tenant, destination.id), true);
      assert.equal(
        await worker.deliverNext(tenant, destination.id, controller.signal),
        'delivered',
      );
      if (errors.length)
        throw new AggregateError(
          errors,
          'Capacity receiver rejected an actual delivery',
        );
      if (i === 550) {
        resumedCursor = (await store.getSchedule(tenant, destination.id))
          ?.cursor;
        await worker.onModuleDestroy();
        await store.onModuleDestroy();
        store = new ExportDeliveryStoreService(db, config);
        worker = new ExportDeliveryWorkerService(store, transport);
        assert.equal(
          (await store.getSchedule(tenant, destination.id))?.cursor,
          resumedCursor,
        );
      }
    }
    const elapsedMs = Math.round(performance.now() - started);
    assert.deepEqual([...received].sort(), records.map((row) => row.id).sort());
    assert.equal(deliveries.size, windows);
    const schedule = await store.getSchedule(tenant, destination.id);
    assert.equal(schedule?.admittedRecords, windows);
    const history = await store.historyState(tenant, destination.id);
    assert.equal(
      history.coverage.prunedScheduledBatches.delivered,
      String(windows - 1000),
    );
    assert.equal(
      history.coverage.prunedScheduledRecords.delivered,
      String(windows - 1000),
    );
    assert.equal(
      (
        await store.admit(
          tenant,
          destination.id,
          manual[0].id,
          [records[0].id],
          policy,
        )
      ).id,
      manual[0].id,
    );
    const [retained] = await db.query(
      `SELECT COUNT(*) FILTER (WHERE NOT is_scheduled)::integer AS caller,
    COUNT(*) FILTER (WHERE is_scheduled)::integer AS scheduled,COUNT(*) FILTER (WHERE payload IS NOT NULL)::integer AS payloads
    FROM public.log_export_deliveries WHERE tenant_id=$1`,
      [tenant],
    );
    assert.deepEqual(retained, { caller: 1000, scheduled: 1000, payloads: 0 });
    assert.equal(
      (
        await db.query(
          'SELECT COUNT(*)::integer AS rows FROM public.log_export_delivery_history_totals WHERE tenant_id=$1',
          [tenant],
        )
      )[0].rows,
      1,
    );
    evidence = {
      actualScheduledWindows: windows,
      actualUniqueRecords: received.size,
      syntheticCallerTerminalRows: 1000,
      elapsedMs,
      workerAndStoreReconstructed: Boolean(resumedCursor),
      retained,
      coverage: history.coverage,
      uid: process.getuid?.(),
      checks: [
        'real-PostgreSQL-non-UTC-immutable-source-admission',
        'actual-signed-private-NDJSON-per-window',
        'no-source-replay-after-reconstruction',
        'completed-history-does-not-stop-new-windows',
        'caller-deduplication-survives-automatic-compaction',
        'one-fixed-workspace-coverage-row',
      ],
      limitation:
        'Direct producer/worker loop; timer discovery and provider operations are verified separately. No comparative performance claim.',
    };
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const release of [
      () => worker?.onModuleDestroy(),
      () => transport?.onModuleDestroy(),
      () => store?.onModuleDestroy(),
      () => destinations?.onModuleDestroy(),
      async () => {
        cipher?.destroy();
        for (const socket of sockets) socket.destroy();
        if (server)
          await new Promise<void>((done) => server!.close(() => done()));
      },
      async () => {
        if (db?.isInitialized) await db.destroy();
      },
      async () => {
        if (created && root.isInitialized)
          await root.query(`DROP DATABASE ${database} WITH (FORCE)`);
      },
      async () => {
        if (root.isInitialized) await root.destroy();
      },
    ])
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Capacity verification or owned cleanup failed',
    );
  console.log(`EXPORT_CAPACITY_EVIDENCE=${JSON.stringify(evidence)}`);
}
void verifyCapacity().catch((error) => {
  console.error('External export capacity verification failed.', error);
  process.exitCode = 1;
});
