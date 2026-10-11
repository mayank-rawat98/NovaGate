import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { MigrationService } from '../database/migration.service';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';
import { ExportDestinationsService } from './export-destinations.service';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { ExportDeliveryWorkerService } from './export-delivery-worker.service';
import { ExportDeliverySchedulerService } from './export-delivery-scheduler.service';
import { ExportTransportService } from './export-transport.service';

async function verifyScheduler() {
  assert.equal(process.getuid?.(), 1000);
  const url = process.env.EXPORT_SCHEDULER_DATABASE_URL;
  assert.ok(url, 'Use the disposable PostgreSQL verification database');
  const database = `novagate_scheduler_${randomUUID().replaceAll('-', '')}`;
  const owners = [randomUUID(), randomUUID()];
  const keys = {
    LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({
      fixture: randomBytes(32).toString('base64'),
    }),
    LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'fixture',
  };
  const signingSecret =
    'actual-timer-fixture-signing-secret-more-than-32-bytes';
  const options = {
    connectionTimeoutMillis: 3000,
    options:
      '-c timezone=America/New_York -c statement_timeout=3000 -c lock_timeout=1000',
  };
  const root = new DataSource({
    type: 'postgres',
    url,
    extra: { ...options, max: 2 },
  });
  let db: DataSource | undefined,
    created = false,
    server: Server | undefined;
  let destinations: ExportDestinationsService | undefined,
    cipher: ExportDestinationCredentialCipher | undefined;
  let store: ExportDeliveryStoreService | undefined,
    worker: ExportDeliveryWorkerService | undefined;
  let scheduler: ExportDeliverySchedulerService | undefined,
    transport: ExportTransportService | undefined;
  const sockets = new Set<Socket>(),
    held = new Set<ServerResponse>();
  const received = new Map<string, Set<string>>(),
    bodies = new Map<string, string>();
  const sourceDeliveries = new Map<string, string>(),
    receiverErrors: unknown[] = [];
  let maxConnections = 0,
    maxProcessing = 0,
    maxPending = 0,
    allowSlow = false;
  const failures: unknown[] = [],
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  let evidence: Record<string, unknown> | undefined;
  const targets: Array<{
    tenant: string;
    id: string;
    slow: boolean;
    expected: string[];
  }> = [];
  const count = (target: (typeof targets)[number]) =>
    received.get(target.id)?.size ?? 0;
  try {
    await root.initialize();
    await root.query(`CREATE DATABASE ${database}`);
    created = true;
    const ownedUrl = new URL(url);
    ownedUrl.pathname = `/${database}`;
    db = new DataSource({
      type: 'postgres',
      url: ownedUrl.toString(),
      extra: { ...options, max: 12 },
    });
    await db.initialize();
    await db.query(readFileSync('/app/verification/postgres-init.sql', 'utf8'));
    for (const tenant of owners) {
      await db.query(
        `INSERT INTO public.tenants (id,name,email,"planId") VALUES ($1,'Scheduler fixture',$2,'free')`,
        [tenant, `${tenant}@example.test`],
      );
      await new TenantProvisioningService(db).provisionTenant(tenant);
    }
    await new MigrationService(db).onModuleInit();
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          receiverErrors.push(new Error('Receiver body exceeded its bound'));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const target = targets.find((t) => `/${t.id}` === req.url);
          assert.ok(target);
          assert.equal(req.method, 'POST');
          const id = req.headers['x-novagate-delivery-id'],
            timestamp = req.headers['x-novagate-timestamp'];
          assert.equal(typeof id, 'string');
          assert.equal(typeof timestamp, 'string');
          const body = Buffer.concat(chunks);
          assert.equal(
            req.headers['x-novagate-signature'],
            `v1=${createHmac('sha256', signingSecret).update(`${timestamp}.${id}.`).update(body).digest('hex')}`,
          );
          assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30);
          const previous = bodies.get(id as string);
          if (previous !== undefined)
            assert.equal(
              body.toString(),
              previous,
              'A retry changed its immutable bytes',
            );
          const rows = body
            .toString()
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line));
          assert.equal(rows.length, 1);
          for (const row of rows) {
            assert.ok(
              target.expected.includes(row.id),
              'Source escaped its tenant/filter',
            );
            assert.equal(row.clientIp, '[redacted]');
            assert.equal(row.userAgent, undefined);
            assert.equal(row.receivedAt, undefined);
            assert.equal(row.timestamp, '2001-01-01T00:00:00.000000Z');
            const key = `${target.id}:${row.id}`,
              previousId = sourceDeliveries.get(key);
            if (previousId)
              assert.equal(
                previousId,
                id,
                'A committed source was replayed under a new identity',
              );
            sourceDeliveries.set(key, id as string);
            const set = received.get(target.id) ?? new Set<string>();
            set.add(row.id);
            received.set(target.id, set);
          }
          bodies.set(id as string, body.toString());
          if (target.slow && !allowSlow) {
            held.add(res);
            res.once('close', () => held.delete(res));
          } else {
            res.writeHead(202);
            res.end();
          }
        } catch (error) {
          receiverErrors.push(error);
          res.writeHead(400);
          res.end();
        }
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      maxConnections = Math.max(maxConnections, sockets.size);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = new ConfigService({
      ...keys,
      LOG_EXPORT_HTTP_TRUSTED_ORIGINS: JSON.stringify([origin]),
    });
    destinations = new ExportDestinationsService(db, config);
    cipher = new ExportDestinationCredentialCipher(keys);
    store = new ExportDeliveryStoreService(db, config);
    transport = new ExportTransportService(config);
    worker = new ExportDeliveryWorkerService(store, transport);
    scheduler = new ExportDeliverySchedulerService(store, worker);
    for (const tenant of owners)
      for (let i = 0; i < (tenant === owners[0] ? 4 : 3); i++) {
        const slow = tenant === owners[0] && i === 0;
        const destination = await destinations.create(tenant, {
          name: 'Timer fixture',
          credentials: {
            type: 'webhook',
            url: 'https://logs.example.com/timer',
            signingSecret,
          },
        });
        await db.query(
          'UPDATE public.log_export_destinations SET credentials=$2 WHERE id=$1',
          [
            destination.id,
            cipher.encrypt(tenant, destination.id, 'webhook', {
              type: 'webhook',
              url: `${origin}/${destination.id}`,
              signingSecret,
            }),
          ],
        );
        await store.saveSchedule(tenant, destination.id, {
          enabled: true,
          cadence: 'near_real_time',
          filter: { pathPrefix: slow ? '/slow' : '/fast' },
          payloadPrivacy: { clientIp: 'omit', userAgent: 'omit' },
          expectedRevision: null,
          expectedDestinationRevision: destination.revision,
        });
        targets.push({ tenant, id: destination.id, slow, expected: [] });
      }
    for (const slow of [false, true]) {
      const windows = slow ? 25 : 8;
      const [{ start }] = await db.query(
        `SELECT to_char(date_bin(INTERVAL '1 minute',clock_timestamp()-make_interval(secs=>($1::integer+3)*60),'1970-01-01'::timestamptz) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start`,
        [windows],
      );
      for (const tenant of slow ? [owners[0]] : owners) {
        const rows: Array<{ id: string }> = await db.query(
          `INSERT INTO ${tenantSchema(tenant)}.request_logs (id,method,path,"statusCode","responseTimeMs","requestId","clientIp","userAgent",timestamp,"receivedAt")
          SELECT gen_random_uuid(),'GET',$3,200,2,gen_random_uuid()::text,'203.0.113.8','private-agent','2001-01-01T00:00:00Z'::timestamptz,$1::timestamptz+make_interval(secs=>(n-1)*60+10)
          FROM generate_series(1,$2::integer) n RETURNING id`,
          [start, windows, slow ? '/slow/receipt' : '/fast/receipt'],
        );
        for (const target of targets.filter(
          (t) => t.tenant === tenant && t.slow === slow,
        )) {
          target.expected = rows.map((row) => row.id);
          await db.query(
            `UPDATE public.log_export_delivery_schedules SET started_at=$2,cursor_at=$2,cursor_id=NULL,next_due_at=$2 WHERE destination_id=$1`,
            [target.id, start],
          );
        }
      }
    }
    const slow = targets.find((t) => t.slow);
    assert.ok(slow);
    const ownedDb = db;
    const currentStore = () => {
      assert.ok(store);
      return store;
    };
    const fast = targets.filter((t) => !t.slow);
    // Fill a real immutable 20-batch queue before timing. All subsequent admission
    // and dispatch belongs to the actual bootstrap timer, with no manual tick calls.
    for (let i = 0; i < 20; i++)
      assert.equal(await store.produceNext(slow.tenant, slow.id), true);
    const before = await store.getSchedule(slow.tenant, slow.id);
    assert.equal(before?.admittedRecords, 20);
    await db.query(
      `UPDATE public.log_export_delivery_schedules SET last_delivery_checked_at=CASE WHEN destination_id=$1 THEN NULL ELSE '2000-01-01'::timestamptz END`,
      [slow.id],
    );
    const sample = async () => {
      const [state] =
        await ownedDb.query(`SELECT COUNT(*) FILTER(WHERE status='processing')::integer AS processing,
        COALESCE((SELECT MAX(n) FROM(SELECT COUNT(*)::integer n FROM public.log_export_deliveries WHERE status IN('queued','processing') GROUP BY destination_id) q),0)::integer AS pending FROM public.log_export_deliveries`);
      maxProcessing = Math.max(maxProcessing, state.processing);
      maxPending = Math.max(maxPending, state.pending);
      assert.ok(state.processing <= 4, 'Worker attempts exceeded four');
      assert.ok(state.pending <= 20, 'A destination exceeded its queue budget');
      assert.ok(
        maxConnections <= 4,
        'More than four actual sockets were owned',
      );
      if (receiverErrors.length)
        throw new AggregateError(
          receiverErrors,
          'Controlled receiver rejected a delivery',
        );
    };
    const until = async (
      label: string,
      check: () => Promise<boolean> | boolean,
      budget: number,
    ) => {
      const deadline = performance.now() + budget;
      while (performance.now() < deadline) {
        controller.signal.throwIfAborted();
        await sample();
        if (await check()) return;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error(`${label} did not complete within its fixture budget`);
    };
    const started = performance.now();
    scheduler.onApplicationBootstrap();
    await until(
      'Healthy destinations behind a stalled receiver',
      () => fast.every((t) => count(t) > 0) && held.size === 1,
      10000,
    );
    const healthyFirstPassMs = Math.round(performance.now() - started);
    await until(
      'Queue pressure without cursor loss',
      async () =>
        (await currentStore().getSchedule(slow.tenant, slow.id))?.error ===
        'queue_full',
      3000,
    );
    const saturated = await store.getSchedule(slow.tenant, slow.id);
    assert.equal(saturated?.cursor, before?.cursor);
    assert.equal(saturated?.admittedRecords, 20);
    const change = async (enabled: boolean) => {
      const current = await currentStore().getSchedule(slow.tenant, slow.id);
      assert.ok(current);
      return currentStore().saveSchedule(slow.tenant, slow.id, {
        enabled,
        cadence: current.cadence,
        filter: current.filter,
        payloadPrivacy: current.payloadPrivacy,
        expectedRevision: current.revision,
        expectedDestinationRevision: current.destinationRevision,
      });
    };
    const paused = await change(false);
    allowSlow = true;
    for (const response of held) {
      response.writeHead(202);
      response.end();
    }
    await until(
      'Steady timer backlog before restart',
      () => fast.reduce((n, t) => n + count(t), 0) >= 18 && count(slow) >= 3,
      20000,
    );
    await scheduler.onModuleDestroy();
    await worker.onModuleDestroy();
    await transport.onModuleDestroy();
    await store.onModuleDestroy();
    await until(
      'Actual socket drain before reconstruction',
      () => sockets.size === 0,
      3000,
    );
    store = new ExportDeliveryStoreService(db, config);
    transport = new ExportTransportService(config);
    worker = new ExportDeliveryWorkerService(store, transport);
    scheduler = new ExportDeliverySchedulerService(store, worker);
    assert.equal(
      (await store.getSchedule(slow.tenant, slow.id))?.cursor,
      paused.cursor,
    );
    scheduler.onApplicationBootstrap();
    await until(
      'Paused queue and healthy backlog drain',
      async () => {
        const [{ delivered }] = await ownedDb.query(
          `SELECT COUNT(*)::integer AS delivered FROM public.log_export_deliveries WHERE status='delivered'`,
        );
        return (
          delivered === 68 &&
          fast.every((t) => count(t) === 8) &&
          count(slow) === 20
        );
      },
      60000,
    );
    assert.equal(
      (await store.getSchedule(slow.tenant, slow.id))?.admittedRecords,
      20,
    );
    await change(true);
    await until(
      'Resume of preserved source backlog',
      async () => {
        const [{ delivered }] = await ownedDb.query(
          `SELECT COUNT(*)::integer AS delivered FROM public.log_export_deliveries WHERE status='delivered'`,
        );
        return delivered === 73 && count(slow) === 25;
      },
      20000,
    );
    await scheduler.onModuleDestroy();
    for (const target of targets)
      assert.deepEqual(
        [...(received.get(target.id) ?? [])].sort(),
        target.expected.slice().sort(),
      );
    const [{ payloads }] = await db.query(
      `SELECT COUNT(*)::integer AS payloads FROM public.log_export_deliveries WHERE payload IS NOT NULL`,
    );
    assert.equal(payloads, 0);
    assert.equal(bodies.size, 73);
    assert.equal(sourceDeliveries.size, 73);
    const distinctSourceRecords = new Set(
      targets.flatMap((target) => target.expected),
    ).size;
    assert.equal(distinctSourceRecords, 41);
    evidence = {
      tenants: 2,
      destinations: 7,
      healthyDestinations: 6,
      actualDeliveredBatches: bodies.size,
      exportedRecordOccurrences: sourceDeliveries.size,
      distinctSourceRecords,
      healthyFirstPassMs,
      elapsedMs: Math.round(performance.now() - started),
      maxConnections,
      maxProcessing,
      maxPending,
      actualBootstrapTimer: true,
      manualTimerTicks: 0,
      fixturePrefilledSlowBatches: 20,
      pausedQueueDrains: true,
      resumePreservesCursor: true,
      workerAndStoreReconstructed: true,
      terminalPayloads: payloads,
      uid: process.getuid?.(),
      limitation:
        'Controlled two-workspace/seven-destination backlog; no claim of production scale, provider indexing or comparative Kong performance.',
    };
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const release of [
      () => scheduler?.onModuleDestroy(),
      () => worker?.onModuleDestroy(),
      () => transport?.onModuleDestroy(),
      () => store?.onModuleDestroy(),
      () => destinations?.onModuleDestroy(),
      async () => {
        cipher?.destroy();
        for (const socket of sockets) socket.destroy();
        const receiver = server;
        if (receiver?.listening)
          await new Promise<void>((done, fail) =>
            receiver.close((error) => (error ? fail(error) : done())),
          );
      },
      async () => {
        if (db?.isInitialized) await db.destroy();
      },
      async () => {
        if (created && root.isInitialized)
          await root.query(`DROP DATABASE ${database} WITH(FORCE)`);
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
      'Actual scheduler verification or owned cleanup failed',
    );
  console.log(`EXPORT_SCHEDULER_EVIDENCE=${JSON.stringify(evidence)}`);
}
void verifyScheduler().catch((error) => {
  console.error('External scheduler verification failed.', error);
  process.exitCode = 1;
});
