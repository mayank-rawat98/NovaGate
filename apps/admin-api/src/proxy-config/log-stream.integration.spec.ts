import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { DataSource, type QueryRunner } from 'typeorm';
import type { Request, Response, NextFunction } from 'express';
import { LOG_REDACTED_FIELDS } from '@api-gateway/shared-types';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { ConfigPushService } from '../config-push/config-push.service';
import { MigrationService } from '../database/migration.service';
import { RetentionCaseWork } from '../database/retention-case-work.fixture';
import { LogPrivacyService } from '../log-privacy/log-privacy.service';
import { LogRetentionService } from '../log-retention/log-retention.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { LogStreamController } from './log-stream.controller';
import { LogStreamService } from './log-stream.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Request-log SSE on real PostgreSQL and authenticated HTTP', () => {
  const secret = 'log-stream-fixture-secret-at-least-32-characters';
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const database = `novagate_tail_${randomUUID().replaceAll('-', '')}`;
  const cases = new RetentionCaseWork();
  let root: DataSource, db: DataSource, app: INestApplication, base: string;
  let service: LogStreamService;
  let holdStreamEnds = false;
  const tenants: string[] = [];
  const aborts: AbortController[] = [];
  const locks: QueryRunner[] = [];
  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = secret;
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
      extra: {
        max: 12,
        connectionTimeoutMillis: 3000,
        options: '-c statement_timeout=15000 -c lock_timeout=3000',
      },
    });
    await db.initialize();
    await db.query(
      readFileSync(
        resolve(__dirname, '../../../../docker/postgres-init.sql'),
        'utf8',
      ),
    );
    await new MigrationService(db).onModuleInit();
  }, 30000);
  beforeEach(async () => {
    holdStreamEnds = false;
    const module = await Test.createTestingModule({
      controllers: [LogStreamController],
      providers: [
        LogStreamService,
        { provide: DataSource, useValue: db },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication({
      logger: false,
      forceCloseConnections: true,
    });
    app.use((_request: Request, response: Response, next: NextFunction) => {
      const end = response.end.bind(response) as (
        ...args: unknown[]
      ) => Response;
      response.end = ((...args: unknown[]) => {
        if (
          holdStreamEnds &&
          String(response.getHeader('Content-Type')).startsWith(
            'text/event-stream',
          )
        )
          return response;
        return end(...args);
      }) as Response['end'];
      next();
    });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    service = app.get(LogStreamService);
  });
  afterEach(
    () =>
      cases.finish(async () => {
        aborts.splice(0).forEach((controller) => controller.abort());
        for (const lock of locks.splice(0)) {
          if (lock.isTransactionActive) await lock.rollbackTransaction();
          if (!lock.isReleased) await lock.release();
        }
        await app?.close();
        for (const tenant of tenants.splice(0)) {
          await db.query(
            `DROP SCHEMA IF EXISTS ${tenantSchema(tenant)} CASCADE`,
          );
          await db.query(
            'DELETE FROM public.pending_config_updates WHERE "tenantId"=$1',
            [tenant],
          );
          await db.query('DELETE FROM public.api_keys WHERE "tenantId"=$1', [
            tenant,
          ]);
          await db.query('DELETE FROM public.tenants WHERE id=$1', [tenant]);
        }
      }),
    30000,
  );
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await root.destroy();
    }
    if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousSecret;
  }, 30000);
  async function workspace() {
    const tenant = randomUUID();
    tenants.push(tenant);
    await db.query(
      "INSERT INTO public.tenants(id,name,email,\"planId\") VALUES($1,'Tail fixture',$2,'free')",
      [tenant, `${tenant}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(tenant);
    await db.query('UPDATE public.tenants SET "logPrivacy"=$2 WHERE id=$1', [
      tenant,
      JSON.stringify({ clientIp: 'retain', userAgent: 'retain' }),
    ]);
    return tenant;
  }
  const auth = (tenant: string, exp = 60) =>
    `Bearer ${sign({ sub: tenant }, secret, { expiresIn: exp })}`;
  function request(tenant: string, headers: Record<string, string> = {}) {
    const controller = new AbortController();
    aborts.push(controller);
    return fetch(`${base}/api/tenants/${tenant}/logs/stream`, {
      headers: { Authorization: auth(tenant), ...headers },
      signal: controller.signal,
    });
  }
  async function open(tenant: string, cursor?: string, token = auth(tenant)) {
    const controller = new AbortController();
    aborts.push(controller);
    const response = await fetch(`${base}/api/tenants/${tenant}/logs/stream`, {
      headers: {
        Authorization: token,
        ...(cursor ? { 'Last-Event-ID': cursor } : {}),
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (!response.body) throw new Error('Missing stream body');
    const reader = response.body.getReader();
    let pending = '';
    const decoder = new TextDecoder();
    async function next(event = 'logs'): Promise<{
      id?: string;
      data: Record<string, unknown>[];
      reason?: string;
    }> {
      const deadline = setTimeout(() => controller.abort(), 3500);
      try {
        while (true) {
          const boundary = pending.indexOf('\n\n');
          if (boundary >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const lines = frame.split('\n');
            if (!lines.includes(`event: ${event}`)) continue;
            const dataLine = lines.find((line) => line.startsWith('data: '));
            if (!dataLine) throw new Error('Missing stream data');
            const value = JSON.parse(dataLine.slice(6));
            return {
              id: lines.find((line) => line.startsWith('id: '))?.slice(4),
              data: value,
              reason: value.reason,
            };
          }
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error('Log stream ended before the expected frame');
          pending += decoder.decode(chunk.value, { stream: true });
          if (Buffer.byteLength(pending) > 262144)
            throw new Error('Unbounded log stream');
        }
      } finally {
        clearTimeout(deadline);
      }
    }
    const close = async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    };
    return { response, reader, next, close, controller };
  }
  function cursor(frame: { id?: string }) {
    if (!frame.id) throw new Error('Missing encrypted log cursor');
    return frame.id;
  }
  async function seed(
    tenant: string,
    count = 1,
    receipt = 'clock_timestamp()',
    path = '/tail',
  ) {
    return db.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`log-receipt:${tenant}`],
      );
      return manager.query(
        `INSERT INTO ${tenantSchema(tenant)}.request_logs(id,method,path,"statusCode","responseTimeMs","requestId","traceId","spanId","consumerId","downstreamService","clientIp","userAgent",timestamp,"receivedAt")
        SELECT gen_random_uuid(),'GET',$1,200,3,'private-request','12345678901234567890123456789012','1234567890123456',gen_random_uuid(),'private-downstream','192.0.2.1','private-agent',clock_timestamp()-interval '30 days',${receipt} FROM generate_series(1,$2) RETURNING id`,
        [path, count],
      );
    });
  }
  async function lockReceipt(tenant: string) {
    const runner = db.createQueryRunner();
    locks.push(runner);
    await runner.connect();
    await runner.startTransaction();
    await runner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `log-receipt:${tenant}`,
    ]);
    return runner;
  }
  async function waiting(count: number) {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const [row] = await db.query(
        `SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory'`,
        [database],
      );
      if (row.n >= count) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Expected actual pending PostgreSQL reads');
  }
  async function admissionsReleased() {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if ((service as unknown as { clients: Set<unknown> }).clients.size === 0)
        return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Disconnected streams still hold admission');
  }
  it('rejects missing/query/foreign sessions before streaming and never permits caching', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        other = await workspace();
      for (const [url, headers, status] of [
        [`${base}/api/tenants/${tenant}/logs/stream`, {}, 401],
        [
          `${base}/api/tenants/${tenant}/logs/stream?token=${sign({ sub: tenant }, secret)}`,
          {},
          401,
        ],
        [
          `${base}/api/tenants/${other}/logs/stream`,
          { Authorization: auth(tenant) },
          403,
        ],
      ] as const) {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(1500),
        });
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await response.body?.cancel();
      }
    }));
  it('samples only the latest 50 retained receipts, orders microsecond/UUID ties and projects private columns away', () =>
    cases.run(async () => {
      const tenant = await workspace();
      await seed(
        tenant,
        55,
        "clock_timestamp()-interval '1 hour' + (generate_series::text || ' microseconds')::interval",
      );
      await seed(tenant, 1, "clock_timestamp()-interval '8 days'", '/expired');
      const schema = tenantSchema(tenant);
      const expected = await db.query(
        `SELECT id FROM (SELECT id,"receivedAt" FROM ${schema}.request_logs WHERE path<> '/expired' ORDER BY "receivedAt" DESC,id DESC LIMIT 50) s ORDER BY "receivedAt",id`,
      );
      const stream = await open(tenant);
      const first = await stream.next();
      expect(first.data.map((row) => row.id)).toEqual(
        expected.map((row: { id: string }) => row.id),
      );
      expect(first.data[0]).not.toHaveProperty('receivedAt');
      expect(first.data[0]).not.toHaveProperty('consumerUsageStored');
      expect(first.data[0]).not.toHaveProperty('streamReceipt');
      const plaintext = Buffer.from(
        cursor(first).slice(3),
        'base64url',
      ).toString('utf8');
      expect(plaintext).not.toContain(tenant);
      expect(plaintext).not.toContain(String(first.data.at(-1)?.id));
      await stream.close();
      await admissionsReleased();
      await seed(
        tenant,
        2,
        "date_trunc('milliseconds',statement_timestamp())",
        '/late-request-timestamp',
      );
      const resumed = await open(tenant, first.id);
      const next = await resumed.next();
      expect(next.data).toHaveLength(2);
      expect(
        next.data.every((row) => row.path === '/late-request-timestamp'),
      ).toBe(true);
      expect(next.data.map((row) => row.id)).toEqual(
        [...next.data.map((row) => String(row.id))].sort(),
      );
      expect(
        next.data.every(
          (row) =>
            Date.parse(String(row.timestamp)) < Date.now() - 86400000 * 20,
        ),
      ).toBe(true);
    }));
  it('refuses tampered and cross-workspace cursors and distinguishes a missing workspace', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        other = await workspace();
      await seed(tenant);
      const stream = await open(tenant);
      const id = cursor(await stream.next());
      await stream.close();
      await admissionsReleased();
      const changed =
        id.slice(0, 10) + (id[10] === 'A' ? 'B' : 'A') + id.slice(11);
      for (const [target, cursor] of [
        [tenant, changed],
        [other, id],
        [tenant, 'invalid'],
      ] as const) {
        const response = await request(target, { 'Last-Event-ID': cursor });
        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await response.body?.cancel();
      }
      const missing = await request(randomUUID());
      expect(missing.status).toBe(404);
      await missing.body?.cancel();
    }));
  it('anchors an empty stream and reads actual new receipts on the next poll', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        stream = await open(tenant);
      expect((await stream.next()).data).toEqual([]);
      const inserted = await seed(tenant);
      const next = await stream.next();
      expect(next.data.map((row) => row.id)).toEqual(
        inserted.map((row: { id: string }) => row.id),
      );
    }));
  it('reapplies a saved privacy policy to live reads and reconnects before historical scrubbing', () =>
    cases.run(async () => {
      const tenant = await workspace();
      await seed(tenant);
      const stream = await open(tenant);
      const before = await stream.next();
      expect(before.data[0].clientIp).toBe('192.0.2.1');
      const push = new ConfigPushService(db);
      jest.spyOn(push, 'publish').mockResolvedValue(false);
      const privacy = new LogPrivacyService(db, push);
      const current = await privacy.get(tenant);
      await privacy.save(tenant, {
        expectedRevision: current.revision,
        policy: {
          clientIp: 'omit',
          userAgent: 'omit',
          redactedFields: [...LOG_REDACTED_FIELDS],
        },
      });
      await seed(tenant);
      const next = await stream.next();
      expect(next.data[0]).toMatchObject({
        path: '[redacted]',
        requestId: '[redacted]',
        clientIp: '[redacted]',
      });
      for (const field of [
        'userAgent',
        'consumerId',
        'downstreamService',
        'traceId',
        'spanId',
      ])
        expect(next.data[0]).not.toHaveProperty(field);
      const [raw] = await db.query(
        `SELECT "clientIp" FROM ${tenantSchema(tenant)}.request_logs LIMIT 1`,
      );
      expect(raw.clientIp).toBe('192.0.2.1');
      await stream.close();
      await admissionsReleased();
      const resumed = await open(tenant, before.id);
      expect((await resumed.next()).data[0].path).toBe('[redacted]');
      await privacy.onModuleDestroy();
    }));
  it('signals a retention gap and never resurrects old physical rows after the policy grows', () =>
    cases.run(async () => {
      const tenant = await workspace();
      await seed(tenant, 1, "clock_timestamp()-interval '2 days'", '/old');
      const stream = await open(tenant),
        first = await stream.next();
      expect(first.data[0].path).toBe('/old');
      await stream.close();
      await admissionsReleased();
      const retention = new LogRetentionService(db);
      let state = await retention.get(tenant);
      state = await retention.save(tenant, {
        days: 1,
        expectedRevision: state.revision,
      });
      await retention.save(tenant, {
        days: 7,
        expectedRevision: state.revision,
      });
      await seed(tenant, 1, 'clock_timestamp()', '/retained');
      const resumed = await open(tenant, first.id);
      expect((await resumed.next('gap')).reason).toBe('receipt_retention');
      expect((await resumed.next()).data.map((row) => row.path)).toEqual([
        '/retained',
      ]);
      const [physical] = await db.query(
        `SELECT count(*)::integer AS n FROM ${tenantSchema(tenant)}.request_logs WHERE path='/old'`,
      );
      expect(physical.n).toBe(1);
      await retention.onModuleDestroy();
    }));
  it('bounds two clients per workspace, allows another workspace and recovers admission on disconnect', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        other = await workspace();
      const first = await open(tenant),
        second = await open(tenant);
      expect((await request(tenant)).status).toBe(503);
      const third = await open(other);
      expect((await third.next()).data).toEqual([]);
      await Promise.all([first.close(), second.close(), third.close()]);
      await admissionsReleased();
      const recovered = await open(tenant);
      expect((await recovered.next()).data).toEqual([]);
    }));
  it('closes a stream at its authenticated session expiry', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        stream = await open(tenant, undefined, auth(tenant, 2));
      await stream.next();
      const deadline = setTimeout(() => stream.controller.abort(), 3000);
      try {
        expect((await stream.reader.read()).done).toBe(true);
      } finally {
        clearTimeout(deadline);
      }
    }));
  it('returns a bounded 503 for a blocked receipt fence and recovers after release', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        lock = await lockReceipt(tenant);
      const started = Date.now();
      const response = await request(tenant);
      expect(response.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(1500);
      await response.body?.cancel();
      await lock.rollbackTransaction();
      await lock.release();
      const recovered = await open(tenant);
      expect((await recovered.next()).data).toEqual([]);
    }));
  it('caps pending database work and drains actual blocked reads on shutdown', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        other = await workspace(),
        third = await workspace();
      const one = await lockReceipt(tenant),
        two = await lockReceipt(other);
      const reads = [
        request(tenant),
        request(tenant),
        request(other),
        request(other),
      ];
      await waiting(4);
      expect((await request(third)).status).toBe(503);
      let drained = false;
      const shutdown = service.onModuleDestroy().then(() => {
        drained = true;
      });
      await new Promise((done) => setTimeout(done, 25));
      expect(drained).toBe(false);
      expect((await request(third)).status).toBe(503);
      await Promise.all([one.rollbackTransaction(), two.rollbackTransaction()]);
      await shutdown;
      await Promise.allSettled(reads);
      expect(drained).toBe(true);
    }));
  it('ends an oversized legacy batch with a fixed finite protocol error', () =>
    cases.run(async () => {
      const tenant = await workspace();
      await seed(tenant, 1, 'clock_timestamp()', 'x'.repeat(140000));
      const stream = await open(tenant);
      expect((await stream.next('error')).reason).toBe('output_limit');
      expect((await stream.reader.read()).done).toBe(true);
    }));
  it('holds admission and shutdown until delayed HTTP responses actually close within the drain deadline', () =>
    cases.run(async () => {
      const tenant = await workspace();
      await seed(tenant, 1, 'clock_timestamp()', 'x'.repeat(140000));
      holdStreamEnds = true;
      const first = await open(tenant),
        second = await open(tenant);
      expect((await first.next('error')).reason).toBe('output_limit');
      expect((await second.next('error')).reason).toBe('output_limit');
      const completion = Promise.allSettled([
        first.reader.read(),
        second.reader.read(),
      ]);
      expect((await request(tenant)).status).toBe(503);
      let drained = false;
      const started = Date.now();
      const shutdown = service.onModuleDestroy().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(drained).toBe(false);
      await shutdown;
      await completion;
      expect(drained).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    }));
  it('expires a saved cursor after 24 hours even while a fresh session is valid', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        stream = await open(tenant);
      const first = await stream.next();
      await stream.close();
      await admissionsReleased();
      const now = Date.now(),
        clock = jest.spyOn(Date, 'now').mockReturnValue(now + 86400001);
      try {
        const response = await request(tenant, {
          'Last-Event-ID': cursor(first),
          Authorization: auth(tenant, 86400 * 7),
        });
        expect(response.status).toBe(400);
        await response.body?.cancel();
      } finally {
        clock.mockRestore();
      }
    }));
  it('ends an active stream on a real database read failure without reflecting SQL errors', () =>
    cases.run(async () => {
      const tenant = await workspace(),
        stream = await open(tenant);
      await stream.next();
      await db.query(`DROP TABLE ${tenantSchema(tenant)}.request_logs`);
      expect((await stream.next('error')).reason).toBe('read_failed');
      expect((await stream.reader.read()).done).toBe(true);
    }));
  it('caps established streams at 16 across workspaces', () =>
    cases.run(async () => {
      const owners = await Promise.all(
        Array.from({ length: 9 }, () => workspace()),
      );
      for (const tenant of owners.slice(0, 8)) {
        await open(tenant);
        await open(tenant);
      }
      const refused = await request(owners[8]);
      expect(refused.status).toBe(503);
      await refused.body?.cancel();
    }));
});
