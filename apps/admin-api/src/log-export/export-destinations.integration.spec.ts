import { ConfigService } from '@nestjs/config';
import { HttpException, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import type {
  LogExportDestination,
  LogExportDestinationList,
  LogExportDeliverySchedule,
  LogExportDeliveryState,
  LogExportDeliveryHistory,
} from '@api-gateway/shared-types';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { ExportDestinationsController } from './export-destinations.controller';
import {
  ExportDestinationsService,
  EXPORT_DESTINATION_LIMIT,
} from './export-destinations.service';
import { ExportDestinationCredentialCipher } from './export-destination-credentials';
import { ExportDeliveryController } from './export-delivery.controller';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { tenantSchema } from '../tenants/tenant-schema';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const first = Buffer.alloc(32, 1).toString('base64');
const second = Buffer.alloc(32, 2).toString('base64');
const initialKeys = {
  LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ first }),
  LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'first',
};
const webhook = {
  type: 'webhook',
  url: 'https://logs.example.com/private-path?token=private-query',
  signingSecret: 'private-signing-secret-of-at-least-32-bytes',
};
const secret = 'destination-integration-secret-at-least-32-characters';
integration(
  'Private export destination management on real PostgreSQL and HTTP',
  () => {
    let root: DataSource, db: DataSource, app: INestApplication, url: string;
    const tenant = randomUUID(),
      other = randomUUID();
    const database = `novagate_destinations_${randomUUID().replace(/-/g, '')}`;
    const previousSecret = process.env.PLATFORM_JWT_SECRET;
    async function start(keys: Record<string, unknown> = initialKeys) {
      if (app) await app.close();
      const module = await Test.createTestingModule({
        controllers: [ExportDestinationsController, ExportDeliveryController],
        providers: [
          ExportDestinationsService,
          ExportDeliveryStoreService,
          { provide: APP_GUARD, useClass: TenantAuthGuard },
          { provide: DataSource, useValue: db },
          { provide: ConfigService, useValue: new ConfigService(keys) },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.listen(0, '127.0.0.1');
      url = await app.getUrl();
    }
    function request(
      method: string,
      suffix = '',
      body?: unknown,
      owner = tenant,
      session: string | null = tenant,
    ) {
      return fetch(`${url}/tenants/${owner}/log-export-destinations${suffix}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(session
            ? {
                authorization: `Bearer ${sign({}, secret, { subject: session })}`,
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function create(credentials: unknown = webhook) {
      const response = await request('POST', '', {
        name: 'Operations',
        credentials,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const output: LogExportDestination =
        (await response.json()) as LogExportDestination;
      expect(JSON.stringify(output)).not.toMatch(
        /private-path|private-query|private-signing|ciphertext|accessKeyId|apiKey|sessionToken/,
      );
      return output;
    }
    beforeAll(async () => {
      process.env.PLATFORM_JWT_SECRET = secret;
      root = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await root.initialize();
      await root.query(`CREATE DATABASE ${database}`);
      const connection = new URL(process.env.TEST_DATABASE_URL as string);
      connection.pathname = `/${database}`;
      db = new DataSource({
        type: 'postgres',
        url: connection.toString(),
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
          "INSERT INTO public.tenants (id,name,email,\"planId\") VALUES ($1,'Destinations',$2,'free')",
          [id, `${id}@example.test`],
        );
        await new TenantProvisioningService(db).provisionTenant(id);
      }
      await new MigrationService(db).onModuleInit();
      await start();
    }, 30000);
    afterAll(async () => {
      const failures: unknown[] = [];
      async function release(fn: () => Promise<unknown>) {
        try {
          await fn();
        } catch (error) {
          failures.push(error);
        }
      }
      if (app) await release(() => app.close());
      if (db?.isInitialized) await release(() => db.destroy());
      if (root?.isInitialized) {
        await release(() =>
          root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
        );
        await release(() => root.destroy());
      }
      if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previousSecret;
      if (failures.length)
        throw new AggregateError(
          failures,
          'Destination fixture cleanup failed',
        );
    }, 30000);
    beforeEach(async () => {
      await db.query(
        'DELETE FROM public.log_export_deliveries;DELETE FROM public.log_export_destinations;DELETE FROM public.log_export_delivery_history_totals',
      );
      await db.query(`DELETE FROM ${tenantSchema(tenant)}.request_logs`);
      await db.query(
        `UPDATE public.tenants SET "logPrivacy"='{"clientIp":"omit","userAgent":"omit"}' WHERE id=$1`,
        [tenant],
      );
      await start();
    });
    it('stores all webhook secrets encrypted without activating a draft', async () => {
      const created = await create();
      const [{ credentials }]: Array<{ credentials: unknown }> = await db.query(
        'SELECT credentials FROM public.log_export_destinations WHERE id=$1',
        [created.id],
      );
      expect(JSON.stringify(credentials)).not.toMatch(
        /private-path|private-query|private-signing/,
      );
      expect(
        new ExportDestinationCredentialCipher(initialKeys).decrypt(
          tenant,
          created.id,
          'webhook',
          credentials,
        ),
      ).toEqual(webhook);
      const response = await request('GET');
      const output: LogExportDestinationList =
        (await response.json()) as LogExportDestinationList;
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(output).toEqual({
        configurationAvailable: true,
        deliveryAvailable: true,
        limit: 10,
        destinations: [created],
      });
      expect(created).toMatchObject({
        destination: 'https://logs.example.com',
        credentialStatus: 'available',
        state: 'draft',
      });
      expect(JSON.stringify(output)).not.toMatch(
        /private-path|private-query|private-signing|nonce|ciphertext/,
      );
    });
    function delivery(
      id: string,
      method = 'GET',
      suffix = '',
      body?: unknown,
      owner = tenant,
      session: string | null = tenant,
    ) {
      return request(method, `/${id}/delivery${suffix}`, body, owner, session);
    }
    async function state(id: string) {
      const response = await delivery(id);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return (await response.json()) as LogExportDeliveryState;
    }
    async function configure(
      id: string,
      enabled = true,
      overrides: Record<string, unknown> = {},
    ) {
      const current = await state(id);
      const response = await delivery(id, 'PUT', '', {
        enabled,
        cadence: current.schedule?.cadence ?? 'near_real_time',
        filter: current.schedule?.filter ?? {},
        payloadPrivacy: current.schedule?.payloadPrivacy ?? {
          clientIp: 'omit',
          userAgent: 'omit',
        },
        expectedRevision: current.schedule?.revision ?? null,
        expectedDestinationRevision: current.destinationRevision,
        ...overrides,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return (await response.json()) as LogExportDeliverySchedule;
    }
    it('enables only through an authenticated revision-aware save and starts without backfill', async () => {
      const created = await create();
      const id = randomUUID();
      await db.query(
        `INSERT INTO ${tenantSchema(tenant)}.request_logs (id,method,path,"statusCode","responseTimeMs","requestId",timestamp,"receivedAt") VALUES ($1,'GET','/old',200,1,$2,'2001-01-01T00:00:00Z',clock_timestamp()-INTERVAL '1 minute')`,
        [id, randomUUID()],
      );
      expect(await state(created.id)).toMatchObject({
        available: true,
        credentialStatus: 'available',
        schedule: null,
        pendingBatches: 0,
        processingBatches: 0,
        limits: {
          pendingBatches: 20,
          settlementSeconds: 15,
          maxAttempts: 6,
          payloadLifetimeHours: 24,
        },
      });
      const enabled = await configure(created.id);
      expect(enabled.enabled).toBe(true);
      const [{ after }] = await db.query(`SELECT clock_timestamp() AS after`);
      expect(Date.parse(enabled.startedAt)).toBeLessThanOrEqual(
        after.getTime(),
      );
      expect(enabled.cursor).toBe(enabled.startedAt);
      expect(enabled.admittedRecords).toBe(0);
      expect(
        (
          await app
            .get(ExportDeliveryStoreService)
            .getSchedule(tenant, created.id)
        )?.cursor,
      ).toBe(enabled.cursor);
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations[0].state,
      ).toBe('enabled');
      const paused = await configure(created.id, false);
      expect(paused.cursor).toBe(enabled.cursor);
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations[0].state,
      ).toBe('paused');
      const resumed = await configure(created.id, true);
      expect(resumed.cursor).toBe(enabled.cursor);
      expect(JSON.stringify(await state(created.id))).not.toMatch(
        /private-path|private-query|private-signing|ciphertext|nonce|source_ids/,
      );
    });
    it.each(['GET', 'PUT', 'DELETE'])(
      'authorizes every %s delivery operation and isolates destination identifiers',
      async (method) => {
        const created = await create();
        expect(
          (
            await delivery(
              created.id,
              method,
              '',
              method === 'GET' ? undefined : {},
              tenant,
              null,
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await delivery(
              created.id,
              method,
              '',
              method === 'GET' ? undefined : {},
              other,
              tenant,
            )
          ).status,
        ).toBe(403);
        expect(
          (await delivery(created.id, 'GET', '', undefined, other, other))
            .status,
        ).toBe(404);
        expect(
          (
            await delivery(
              created.id,
              'GET',
              '/history',
              undefined,
              other,
              other,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await delivery(
              created.id,
              'GET',
              '/history',
              undefined,
              tenant,
              null,
            )
          ).status,
        ).toBe(401);
      },
    );
    it.each([
      'records',
      'receiptFrom',
      'credentials',
      'payload',
      'expectedRevision',
      'cadence',
      'payloadPrivacy',
      'filter',
    ])(
      'rejects invalid %s before mutating delivery configuration',
      async (field) => {
        const created = await create();
        const values: Record<string, unknown> = {
          records: [],
          receiptFrom: '2001-01-01',
          credentials: webhook,
          payload: {},
          expectedRevision: 'stale',
          cadence: 'daily',
          payloadPrivacy: {
            clientIp: 'retain',
            userAgent: 'retain',
            headers: true,
          },
          filter: { rawBody: true },
        };
        const response = await delivery(created.id, 'PUT', '', {
          enabled: true,
          cadence: 'hourly',
          filter: {},
          payloadPrivacy: { clientIp: 'omit', userAgent: 'omit' },
          expectedRevision: null,
          expectedDestinationRevision: created.revision,
          [field]: values[field],
        });
        expect(response.status).toBe(400);
        expect((await state(created.id)).schedule).toBeNull();
      },
    );
    it('preserves schedule and leases on stale edits and allows pause/removal without readable keys', async () => {
      const created = await create();
      const enabled = await configure(created.id);
      expect(
        (
          await delivery(created.id, 'PUT', '', {
            ...enabled,
            expectedRevision: randomUUID(),
            expectedDestinationRevision: enabled.destinationRevision,
          })
        ).status,
      ).toBe(400);
      const stale = await delivery(created.id, 'PUT', '', {
        enabled: false,
        cadence: enabled.cadence,
        filter: enabled.filter,
        payloadPrivacy: enabled.payloadPrivacy,
        expectedRevision: randomUUID(),
        expectedDestinationRevision: enabled.destinationRevision,
      });
      expect(stale.status).toBe(409);
      expect((await state(created.id)).schedule?.revision).toBe(
        enabled.revision,
      );
      await start({});
      expect((await state(created.id)).available).toBe(false);
      const paused = await configure(created.id, false);
      expect(paused.cursor).toBe(enabled.cursor);
      const unavailable = await delivery(created.id, 'PUT', '', {
        enabled: true,
        cadence: paused.cadence,
        filter: paused.filter,
        payloadPrivacy: paused.payloadPrivacy,
        expectedRevision: paused.revision,
        expectedDestinationRevision: paused.destinationRevision,
      });
      expect(unavailable.status).toBe(503);
      const removed = await delivery(created.id, 'DELETE', '', {
        expectedRevision: paused.revision,
        expectedDestinationRevision: paused.destinationRevision,
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ removed: true });
      expect((await state(created.id)).schedule).toBeNull();
    });
    it('stops only automatic leases on schedule removal, retains safe history and starts anew on recreation', async () => {
      const created = await create();
      const enabled = await configure(created.id);
      const [{ receipt }] = await db.query(
        `SELECT clock_timestamp() AS receipt`,
      );
      const source = randomUUID();
      await db.query(
        `INSERT INTO ${tenantSchema(tenant)}.request_logs (id,method,path,"statusCode","responseTimeMs","requestId",timestamp,"receivedAt") VALUES ($1,'GET','/scoped',200,1,$2,'2001-01-01T00:00:00Z',$3)`,
        [source, randomUUID(), receipt],
      );
      const store = app.get(ExportDeliveryStoreService);
      const caller = await store.admit(
        tenant,
        created.id,
        randomUUID(),
        [source],
        enabled.payloadPrivacy,
      );
      const automatic = await store.admit(
        tenant,
        created.id,
        randomUUID(),
        [source],
        enabled.payloadPrivacy,
      );
      await db.query(
        `UPDATE public.log_export_deliveries SET is_scheduled=true,schedule_id=$2 WHERE id=$1`,
        [automatic.id, created.id],
      );
      const lease = await store.claim(tenant, created.id, true);
      expect(lease?.id).toBe(automatic.id);
      const denied = await delivery(created.id, 'DELETE', '', {
        expectedRevision: randomUUID(),
        expectedDestinationRevision: enabled.destinationRevision,
      });
      expect(denied.status).toBe(409);
      const [unchanged] = await db.query(
        'SELECT status,payload,lease_id FROM public.log_export_deliveries WHERE id=$1',
        [automatic.id],
      );
      expect(unchanged.status).toBe('processing');
      expect(unchanged.payload).not.toBeNull();
      expect(unchanged.lease_id).toBe(lease?.leaseId);
      const removed = await delivery(created.id, 'DELETE', '', {
        expectedRevision: enabled.revision,
        expectedDestinationRevision: enabled.destinationRevision,
      });
      expect(removed.status).toBe(200);
      const [{ payload, status, lease_id }] = await db.query(
        'SELECT payload,status,lease_id FROM public.log_export_deliveries WHERE id=$1',
        [automatic.id],
      );
      expect({ payload, status, lease_id }).toEqual({
        payload: null,
        status: 'expired',
        lease_id: null,
      });
      const response = await delivery(created.id, 'GET', '/history');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const history = (await response.json()) as LogExportDeliveryHistory;
      expect(
        history.deliveries.find((r: { id: string }) => r.id === caller.id),
      ).toMatchObject({
        status: 'queued',
        source: 'selected_records',
        attempts: 0,
      });
      expect(
        history.deliveries.find((r: { id: string }) => r.id === automatic.id),
      ).toMatchObject({
        status: 'expired',
        source: 'scheduled',
        error: 'schedule_removed',
      });
      expect(JSON.stringify(history)).not.toMatch(
        /source_ids|payload|credentials|private-|lease_id/,
      );
      const renewed = await configure(created.id);
      expect(Date.parse(renewed.startedAt)).toBeGreaterThanOrEqual(
        Date.parse(enabled.startedAt),
      );
      expect(renewed.cursor).toBe(renewed.startedAt);
      expect(renewed.admittedRecords).toBe(0);
      expect(
        (
          await request('DELETE', `/${created.id}`, {
            expectedRevision: renewed.destinationRevision,
          })
        ).status,
      ).toBe(204);
      expect((await delivery(created.id)).status).toBe(404);
      expect((await delivery(created.id, 'GET', '/history')).status).toBe(200);
    });
    it('preserves enabled configuration state on destination rename and key re-encryption', async () => {
      const created = await create();
      const enabled = await configure(created.id);
      const renamed = await request('PUT', `/${created.id}`, {
        name: 'Enabled metadata',
        expectedRevision: enabled.destinationRevision,
      });
      expect(renamed.status).toBe(200);
      const row = (await renamed.json()) as LogExportDestination;
      expect(row.state).toBe('enabled');
      const rotated = await request('POST', `/${created.id}/rotate-key`, {
        expectedRevision: row.revision,
      });
      expect(rotated.status).toBe(200);
      expect(((await rotated.json()) as LogExportDestination).state).toBe(
        'enabled',
      );
    });
    it('allows pausing a preserved filter after workspace privacy makes it unavailable', async () => {
      const created = await create();
      const enabled = await configure(created.id, true, {
        filter: { pathPrefix: '/private-prefix' },
      });
      await db.query(
        `UPDATE public.tenants SET "logPrivacy"='{"clientIp":"omit","userAgent":"omit","redactedFields":["path"]}' WHERE id=$1`,
        [tenant],
      );
      const paused = await configure(created.id, false);
      expect(paused.filter).toEqual(enabled.filter);
      expect(paused.enabled).toBe(false);
      const response = await delivery(created.id, 'PUT', '', {
        enabled: true,
        cadence: paused.cadence,
        filter: paused.filter,
        payloadPrivacy: paused.payloadPrivacy,
        expectedRevision: paused.revision,
        expectedDestinationRevision: paused.destinationRevision,
      });
      expect(response.status).toBe(400);
    });
    it('stores S3 session credentials and Datadog API keys without exposing them', async () => {
      for (const credentials of [
        {
          type: 's3',
          endpoint: 'https://s3.example.com',
          bucket: 'operations-logs',
          region: 'us-east-1',
          accessKeyId: 'private-access-key',
          secretAccessKey: 'private-secret',
          sessionToken: 'private-session',
          forcePathStyle: true,
        },
        { type: 'datadog', site: 'datadoghq.eu', apiKey: 'b'.repeat(32) },
      ]) {
        const created = await create(credentials);
        const [stored]: Array<{ credentials: unknown }> = await db.query(
          'SELECT credentials FROM public.log_export_destinations WHERE id=$1',
          [created.id],
        );
        expect(
          new ExportDestinationCredentialCipher(initialKeys).decrypt(
            tenant,
            created.id,
            created.type,
            stored.credentials,
          ),
        ).toEqual(credentials);
        expect(JSON.stringify(stored)).not.toMatch(
          /private-access-key|private-secret|private-session|bbbbbbbb/,
        );
      }
    });
    it.each(['GET', 'POST', 'PUT', 'DELETE', 'ROTATE'])(
      'denies %s access without the tenant session and across tenants',
      async (operation) => {
        const created = await create();
        const method = operation === 'ROTATE' ? 'POST' : operation;
        const suffix = ['GET', 'POST'].includes(operation)
          ? ''
          : `/${created.id}${operation === 'ROTATE' ? '/rotate-key' : ''}`;
        const body =
          method === 'GET'
            ? undefined
            : {
                name: 'Operations',
                credentials: webhook,
                expectedRevision: created.revision,
              };
        expect((await request(method, suffix, body, tenant, null)).status).toBe(
          401,
        );
        expect(
          (await request(method, suffix, body, tenant, other)).status,
        ).toBe(403);
        const [stored]: Array<{ revision: string }> = await db.query(
          'SELECT revision FROM public.log_export_destinations WHERE id=$1',
          [created.id],
        );
        expect(stored.revision).toBe(created.revision);
      },
    );
    it('does not reveal or mutate a destination ID owned by another tenant', async () => {
      const created = await create();
      for (const [method, suffix, body] of [
        [
          'PUT',
          `/${created.id}`,
          { name: 'Stolen', expectedRevision: created.revision },
        ],
        ['DELETE', `/${created.id}`, { expectedRevision: created.revision }],
        [
          'POST',
          `/${created.id}/rotate-key`,
          { expectedRevision: created.revision },
        ],
      ] as const)
        expect((await request(method, suffix, body, other, other)).status).toBe(
          404,
        );
      expect(
        (
          (await (
            await request('GET', '', undefined, other, other)
          ).json()) as LogExportDestinationList
        ).destinations,
      ).toEqual([]);
    });
    it('keeps credentials on metadata edits and requires complete same-type replacement', async () => {
      const created = await create();
      const [before]: Array<{ credentials: unknown }> = await db.query(
        'SELECT credentials FROM public.log_export_destinations WHERE id=$1',
        [created.id],
      );
      const response = await request('PUT', `/${created.id}`, {
        name: 'Renamed',
        expectedRevision: created.revision,
      });
      expect(response.status).toBe(200);
      const updated: LogExportDestination =
        (await response.json()) as LogExportDestination;
      const [after]: Array<{ credentials: unknown }> = await db.query(
        'SELECT credentials FROM public.log_export_destinations WHERE id=$1',
        [created.id],
      );
      expect(after.credentials).toEqual(before.credentials);
      expect(updated.revision).not.toBe(created.revision);
      expect(
        (
          await request('PUT', `/${created.id}`, {
            name: 'Renamed',
            expectedRevision: updated.revision,
            credentials: {
              type: 'datadog',
              site: 'datadoghq.com',
              apiKey: 'a'.repeat(32),
            },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('PUT', `/${created.id}`, {
            name: 'Renamed',
            expectedRevision: updated.revision,
            credentials: { type: 'webhook' },
          })
        ).status,
      ).toBe(400);
      const replacement = {
        ...webhook,
        url: 'https://next.example.com/private-new?key=private-query',
        signingSecret: 'new-private-signing-secret-at-least-32-bytes',
      };
      const replaced = await request('PUT', `/${created.id}`, {
        name: 'Replaced',
        expectedRevision: updated.revision,
        credentials: replacement,
      });
      expect(replaced.status).toBe(200);
      expect(
        ((await replaced.json()) as LogExportDestination).destination,
      ).toBe('https://next.example.com');
    });
    it('serializes competing updates and rejects stale deletion and key rotation', async () => {
      const created = await create();
      const results = await Promise.all(
        ['First', 'Second'].map((name) =>
          request('PUT', `/${created.id}`, {
            name,
            expectedRevision: created.revision,
          }),
        ),
      );
      expect(results.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      expect(
        (
          await request('DELETE', `/${created.id}`, {
            expectedRevision: created.revision,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request('POST', `/${created.id}/rotate-key`, {
            expectedRevision: created.revision,
          })
        ).status,
      ).toBe(409);
    });
    it('rewraps with the active key and remains readable after old-key retirement', async () => {
      const created = await create();
      await start({
        LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ first, second }),
        LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'second',
      });
      const rotated = await request('POST', `/${created.id}/rotate-key`, {
        expectedRevision: created.revision,
      });
      expect(rotated.status).toBe(200);
      const result: LogExportDestination =
        (await rotated.json()) as LogExportDestination;
      expect(result.revision).not.toBe(created.revision);
      const [stored]: Array<{ credentials: { keyId: string } }> =
        await db.query(
          'SELECT credentials FROM public.log_export_destinations WHERE id=$1',
          [created.id],
        );
      expect(stored.credentials.keyId).toBe('second');
      await start({
        LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ second }),
        LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'second',
      });
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations[0].credentialStatus,
      ).toBe('available');
      await new MigrationService(db).onModuleInit();
      await new MigrationService(db).onModuleInit();
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations[0],
      ).toEqual(result);
    });
    it('marks lost/corrupt keys unavailable while allowing replacement or removal', async () => {
      const created = await create();
      await start({
        LOG_EXPORT_DESTINATION_KEYS: JSON.stringify({ second }),
        LOG_EXPORT_DESTINATION_ACTIVE_KEY: 'second',
      });
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations[0].credentialStatus,
      ).toBe('unavailable');
      const failed = await request('POST', `/${created.id}/rotate-key`, {
        expectedRevision: created.revision,
      });
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toMatch(
        /private-path|private-signing|first|ciphertext/,
      );
      const fixed = await request('PUT', `/${created.id}`, {
        name: 'Repaired',
        expectedRevision: created.revision,
        credentials: webhook,
      });
      expect(fixed.status).toBe(200);
      expect(
        ((await fixed.json()) as LogExportDestination).credentialStatus,
      ).toBe('available');
    });
    it('destroys credentials on removal and keeps only a nonsecret tombstone', async () => {
      const created = await create();
      const removed = await request('DELETE', `/${created.id}`, {
        expectedRevision: created.revision,
      });
      expect(removed.status).toBe(204);
      const [stored]: Array<{ credentials: unknown; deleted_at: Date }> =
        await db.query(
          'SELECT credentials,deleted_at FROM public.log_export_destinations WHERE id=$1',
          [created.id],
        );
      expect(stored.credentials).toBeNull();
      expect(stored.deleted_at).toBeInstanceOf(Date);
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations,
      ).toEqual([]);
      expect(
        (
          await request('POST', `/${created.id}/rotate-key`, {
            expectedRevision: created.revision,
          })
        ).status,
      ).toBe(404);
    });
    it('bounds concurrent destination admission across replicas without dropping existing drafts', async () => {
      for (let i = 0; i < EXPORT_DESTINATION_LIMIT - 1; i++) await create();
      const replica = new ExportDestinationsService(
        db,
        new ConfigService(initialKeys),
      );
      try {
        const responses = await Promise.all([
          request('POST', '', { name: 'Concurrent', credentials: webhook }),
          request('POST', '', { name: 'Concurrent', credentials: webhook }),
          ...Array.from({ length: 2 }, () =>
            replica
              .create(tenant, { name: 'Replica', credentials: webhook })
              .then(() => ({ status: 201 }))
              .catch((error: HttpException) => ({ status: error.getStatus() })),
          ),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([
          201, 409, 409, 409,
        ]);
      } finally {
        await replica.onModuleDestroy();
      }
      expect(
        ((await (await request('GET')).json()) as LogExportDestinationList)
          .destinations,
      ).toHaveLength(EXPORT_DESTINATION_LIMIT);
    });
    it('retains readable metadata and removal when operator configuration is disabled', async () => {
      const created = await create();
      await start({
        LOG_EXPORT_DESTINATION_KEYS: '',
        LOG_EXPORT_DESTINATION_ACTIVE_KEY: '',
      });
      const state = (await (
        await request('GET')
      ).json()) as LogExportDestinationList;
      expect(state.configurationAvailable).toBe(false);
      expect(state.destinations[0].credentialStatus).toBe('unavailable');
      expect(
        (await request('POST', '', { name: 'New', credentials: webhook }))
          .status,
      ).toBe(503);
      expect(
        (
          await request('DELETE', `/${created.id}`, {
            expectedRevision: created.revision,
          })
        ).status,
      ).toBe(204);
    });
    it('rejects a contended update within the lock budget without changing its revision', async () => {
      const created = await create();
      const lock = db.createQueryRunner();
      await lock.connect();
      await lock.startTransaction();
      try {
        await lock.query(
          'SELECT id FROM public.log_export_destinations WHERE id=$1 FOR UPDATE',
          [created.id],
        );
        const started = performance.now();
        const response = await request('PUT', `/${created.id}`, {
          name: 'Contended',
          expectedRevision: created.revision,
        });
        expect(response.status).toBe(503);
        expect(performance.now() - started).toBeLessThan(3000);
        const [stored]: Array<{ revision: string }> = await db.query(
          'SELECT revision FROM public.log_export_destinations WHERE id=$1',
          [created.id],
        );
        expect(stored.revision).toBe(created.revision);
      } finally {
        await lock.rollbackTransaction();
        await lock.release();
      }
    });
    it('rejects unknown activation fields and malformed revisions without storing partial records', async () => {
      expect(
        (
          await request('POST', '', {
            name: 'New',
            credentials: webhook,
            enabled: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('POST', '', {
            name: 'New',
            credentials: { ...webhook, url: 'https://169.254.169.254/' },
          })
        ).status,
      ).toBe(400);
      const created = await create();
      expect(
        (
          await request('PUT', `/${created.id}`, {
            name: 'New',
            expectedRevision: 'invalid',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('DELETE', `/${created.id}`, {
            expectedRevision: created.revision,
            enabled: true,
          })
        ).status,
      ).toBe(400);
    });
  },
);
