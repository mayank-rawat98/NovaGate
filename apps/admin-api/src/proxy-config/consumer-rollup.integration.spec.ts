import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import {
  CONSUMER_ROLLUP_CELL_LIMIT,
  CONSUMER_ROLLUP_HISTOGRAM_BOUNDS,
  CONSUMER_PATH_ROLLUP_CELL_LIMIT,
  consumerHistogramPercentile,
} from '@api-gateway/shared-types';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { LogPrivacyService } from '../log-privacy/log-privacy.service';
import { LogRetentionService } from '../log-retention/log-retention.service';
import { ConfigPushService } from '../config-push/config-push.service';
import { consumerRollupSchemaSql } from './consumer-rollup-schema';
import { eraseConsumerPathRollups } from './consumer-path-rollup-cleanup';
import { RetentionCaseWork } from '../database/retention-case-work.fixture';
import {
  ConsumerRollupService,
  eraseConsumerRollups,
} from './consumer-rollup.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Durable consumer rollups on actual PostgreSQL', () => {
  let root: DataSource, db: DataSource;
  const database = `novagate_rollup_${randomUUID().replace(/-/g, '')}`;
  const tenants: string[] = [];
  const cases = new RetentionCaseWork();
  const push = {
    persistUpdate: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConfigPushService;
  async function workspace() {
    const id = randomUUID();
    tenants.push(id);
    await db.query(
      `INSERT INTO public.tenants (id,name,email,"planId") VALUES ($1,'Rollup fixture',$2,'free')`,
      [id, `${id}@example.test`],
    );
    await new TenantProvisioningService(db).provisionTenant(id);
    return { id, schema: tenantSchema(id), consumer: randomUUID() };
  }
  async function insert(schema: string, rows: Array<Record<string, unknown>>) {
    // Same table-record conversion as the collector; the database receipt and
    // transition table are authoritative, not the attempted/replayed payload.
    await db.query(
      `INSERT INTO ${schema}.request_logs SELECT * FROM jsonb_populate_recordset(NULL::${schema}.request_logs,
      (SELECT jsonb_agg(value || jsonb_build_object('receivedAt',clock_timestamp())) FROM jsonb_array_elements($1::jsonb))) ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(rows)],
    );
  }
  async function state(schema: string) {
    const [row] = await db.query(
      `SELECT * FROM ${schema}.consumer_usage_rollup_state`,
    );
    return row;
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
      extra: {
        max: 8,
        connectionTimeoutMillis: 3000,
        options:
          '-c timezone=America/New_York -c statement_timeout=15000 -c lock_timeout=3000',
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
  afterEach(
    () =>
      cases.finish(async () => {
        for (const id of tenants.splice(0)) {
          await db.query(`DROP SCHEMA IF EXISTS ${tenantSchema(id)} CASCADE`);
          await db.query('DELETE FROM public.api_keys WHERE "tenantId"=$1', [
            id,
          ]);
          await db.query(
            'DELETE FROM public.pending_config_updates WHERE "tenantId"=$1',
            [id],
          );
          await db.query('DELETE FROM public.tenants WHERE id=$1', [id]);
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
  }, 30000);

  it('materializes only inserted IDs, preserves receipt identity and merges every integer latency bucket', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    const other = randomUUID();
    const latencies = [...CONSUMER_ROLLUP_HISTOGRAM_BOUNDS, 3, -1, null];
    const timestamp = new Date(Date.now() - 5 * 60000).toISOString();
    const rows = latencies.map((responseTimeMs, i) => ({
      id: randomUUID(),
      consumerId: consumer,
      responseTimeMs,
      statusCode: i % 2 ? 503 : 200,
      timestamp,
    }));
    await insert(schema, rows);
    const receipts = await db.query(
      `SELECT id,"receivedAt" FROM ${schema}.request_logs ORDER BY id`,
    );
    await insert(
      schema,
      rows.map((row) => ({
        ...row,
        consumerId: other,
        responseTimeMs: 100,
        statusCode: 200,
      })),
    );
    await db.query(consumerRollupSchemaSql(tenant));
    const [rollup] = await db.query(
      `SELECT * FROM ${schema}.consumer_usage_rollups`,
    );
    expect(rollup.consumer_id).toBe(consumer);
    expect(Number(rollup.requests)).toBe(rows.length);
    expect(Number(rollup.server_errors)).toBe(Math.floor(rows.length / 2));
    expect(Number(rollup.latency_samples)).toBe(rows.length - 2);
    expect(Number(rollup.late_records)).toBe(rows.length);
    const histogram = rollup.histogram.map((n: string) => BigInt(n));
    expect(histogram.reduce((sum: bigint, n: bigint) => sum + n, 0n)).toBe(
      BigInt(rows.length - 2),
    );
    expect(histogram[3]).toBe(2n); // both 3 ms and the 4 ms upper boundary
    expect(consumerHistogramPercentile(histogram, 99)).toBe(2147483647);
    expect(
      await db.query(
        `SELECT id,"receivedAt" FROM ${schema}.request_logs ORDER BY id`,
      ),
    ).toEqual(receipts);
    expect((await state(schema)).processed_records).toBe(String(rows.length));
    expect(JSON.stringify(rollup)).not.toMatch(
      /path|requestId|clientIp|userAgent/,
    );
  });

  it('rolls back the raw insert and row marker when aggregate persistence fails', async () => {
    const { schema, consumer } = await workspace();
    const timestamp = new Date(Date.now() - 5 * 60000).toISOString();
    await insert(schema, [
      {
        id: randomUUID(),
        consumerId: consumer,
        statusCode: 200,
        responseTimeMs: 1,
        timestamp,
      },
    ]);
    await db.query(
      `UPDATE ${schema}.consumer_usage_rollups SET requests=9223372036854775807`,
    );
    const id = randomUUID();
    await expect(
      insert(schema, [
        {
          id,
          consumerId: consumer,
          statusCode: 200,
          responseTimeMs: 1,
          timestamp,
        },
      ]),
    ).rejects.toThrow();
    expect(
      await db.query(`SELECT id FROM ${schema}.request_logs WHERE id=$1`, [id]),
    ).toEqual([]);
    expect((await state(schema)).processed_records).toBe('1');
  });

  it('normalizes durable method/path groups, merges every sample and ignores replayed IDs', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    const timestamp = new Date(Date.now() - 60000).toISOString();
    const rows = [3, 4, -1, null].map((responseTimeMs, i) => ({
      id: randomUUID(),
      consumerId: consumer,
      timestamp,
      method: 'GET',
      path: `/private/items?secret=${i}`,
      statusCode: i === 0 ? 503 : 200,
      responseTimeMs,
    }));
    await insert(schema, rows);
    await insert(
      schema,
      rows.map((row) => ({ ...row, path: '/replay', responseTimeMs: 100 })),
    );
    await db.query(consumerRollupSchemaSql(tenant));
    const [group] = await db.query(
      `SELECT * FROM ${schema}.consumer_path_rollups`,
    );
    expect(group).toMatchObject({
      method: 'GET',
      path: '/private/items',
      requests: '4',
      server_errors: '1',
      latency_samples: '2',
    });
    expect(
      group.histogram
        .map(BigInt)
        .reduce((sum: bigint, n: bigint) => sum + n, 0n),
    ).toBe(2n);
    expect(consumerHistogramPercentile(group.histogram.map(BigInt), 95)).toBe(
      4,
    );
    expect(JSON.stringify(group)).not.toMatch(
      /secret|requestId|clientIp|userAgent/,
    );
    expect(
      await db.query(`SELECT "pathRollupVersion" FROM ${schema}.request_logs`),
    ).toEqual(Array.from({ length: 4 }, () => ({ pathRollupVersion: 1 })));
    const longPath = '/' + '🔒'.repeat(600);
    await insert(schema, [
      {
        id: randomUUID(),
        consumerId: consumer,
        timestamp,
        method: 'LONG-METHOD-IDENTIFIER',
        path: longPath,
      },
    ]);
    expect(
      await db.query(
        `SELECT char_length(path) AS path, char_length(method) AS method FROM ${schema}.consumer_path_rollups WHERE path<> '/private/items'`,
      ),
    ).toEqual([{ path: 512, method: 16 }]);
  });

  it('provisions before public discovery migration and restores durable pending discovery on startup', async () => {
    await db.query('DROP TABLE public.consumer_rollup_backlog');
    await db.query(
      'ALTER TABLE public.tenants DROP COLUMN "consumerRollupPending",DROP COLUMN "consumerRollupError"',
    );
    try {
      const { schema, consumer } = await workspace();
      await insert(schema, [
        {
          id: randomUUID(),
          consumerId: consumer,
          timestamp: new Date().toISOString(),
          method: 'GET',
          path: '/pre-startup',
        },
      ]);
      expect(
        await db.query(`SELECT requests FROM ${schema}.consumer_path_rollups`),
      ).toEqual([{ requests: '1' }]);
    } finally {
      await new MigrationService(db).onModuleInit();
    }
    expect(
      await db.query('SELECT "consumerRollupPending" FROM public.tenants'),
    ).toEqual([{ consumerRollupPending: true }]);
  }, 10000);

  it('rolls back ingestion and count aggregates when path persistence fails', async () => {
    const { schema, consumer } = await workspace();
    const timestamp = new Date(Date.now() - 60000).toISOString();
    const first = {
      id: randomUUID(),
      consumerId: consumer,
      timestamp,
      method: 'GET',
      path: '/overflow',
      responseTimeMs: 3,
    };
    await insert(schema, [first]);
    await db.query(
      `UPDATE ${schema}.consumer_path_rollups SET requests=9223372036854775807`,
    );
    const id = randomUUID();
    await expect(insert(schema, [{ ...first, id }])).rejects.toThrow();
    expect(
      await db.query(`SELECT id FROM ${schema}.request_logs WHERE id=$1`, [id]),
    ).toEqual([]);
    expect((await state(schema)).processed_records).toBe('1');
    expect((await state(schema)).attributed_records).toBe('1');
    expect(
      await db.query(
        `SELECT processed_records FROM ${schema}.consumer_path_rollup_state`,
      ),
    ).toEqual([{ processed_records: '1' }]);
  });

  it('backfills a count-only installation without replay across competing replicas', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,method,path) SELECT gen_random_uuid(),$1,statement_timestamp(),'GET','/legacy?token=private' FROM generate_series(1,1201)`,
      [consumer],
    );
    const initial = new ConsumerRollupService(db);
    try {
      await initial.sweep();
    } finally {
      await initial.onModuleDestroy();
    }
    expect((await state(schema)).processed_records).toBe('1201');
    await db.query(
      `ALTER TABLE ${schema}.request_logs DROP COLUMN "pathRollupVersion" CASCADE`,
    );
    await db.query(
      `DROP TABLE ${schema}.consumer_path_rollups,${schema}.consumer_path_rollup_state`,
    );
    await db.query(
      `DROP FUNCTION ${schema}.materialize_consumer_paths(uuid[])`,
    );
    await db.query(
      'UPDATE public.tenants SET "consumerRollupPending"=false WHERE id=$1',
      [tenant],
    );
    await db.query(consumerRollupSchemaSql(tenant));
    expect(
      await db.query(
        'SELECT "consumerRollupPending" FROM public.tenants WHERE id=$1',
        [tenant],
      ),
    ).toEqual([{ consumerRollupPending: true }]);
    const replicas = [
      new ConsumerRollupService(db),
      new ConsumerRollupService(db),
    ];
    try {
      await Promise.all(replicas.map((worker) => worker.sweep()));
    } finally {
      await Promise.all(replicas.map((worker) => worker.onModuleDestroy()));
    }
    expect((await state(schema)).processed_records).toBe('1201');
    expect(
      await db.query(
        `SELECT processed_records,attributed_records,backfill_complete FROM ${schema}.consumer_path_rollup_state`,
      ),
    ).toEqual([
      {
        processed_records: '1201',
        attributed_records: '1201',
        backfill_complete: true,
      },
    ]);
    expect(
      await db.query(
        `SELECT path,SUM(requests)::text AS requests FROM ${schema}.consumer_path_rollups GROUP BY path`,
      ),
    ).toEqual([{ path: '/legacy', requests: '1201' }]);
  }, 10000);

  it('merges bounded historical path erasure without losing counts or allowing resurrection', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,method,path,"statusCode","responseTimeMs") SELECT gen_random_uuid(),$1, date_trunc('minute',statement_timestamp()),'GET',CASE WHEN i<=600 THEN '/private/'||i ELSE '[redacted]' END,CASE WHEN i%2=0 THEN 503 ELSE 200 END,3 FROM generate_series(1,606) i`,
      [consumer],
    );
    const erase = () =>
      db.transaction(async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`log-receipt:${tenant}`],
        );
        return eraseConsumerPathRollups(manager, tenant, {
          attributionHidden: false,
          pathHidden: true,
        });
      });
    expect(await erase()).toBe(500);
    expect(
      await db.query(`SELECT cells FROM ${schema}.consumer_path_rollup_state`),
    ).toEqual([{ cells: 101 }]);
    expect(await erase()).toBe(100);
    expect(await erase()).toBe(0);
    expect(
      await db.query(
        `SELECT path,requests,server_errors,latency_samples FROM ${schema}.consumer_path_rollups`,
      ),
    ).toEqual([
      {
        path: '[redacted]',
        requests: '606',
        server_errors: '303',
        latency_samples: '606',
      },
    ]);
    expect(
      await db.query(`SELECT cells FROM ${schema}.consumer_path_rollup_state`),
    ).toEqual([{ cells: 1 }]);
    await insert(schema, [
      {
        id: randomUUID(),
        consumerId: consumer,
        timestamp: new Date().toISOString(),
        method: 'GET',
        path: '/actual-historical-erasure',
        responseTimeMs: 3,
        statusCode: 200,
      },
    ]);
    const privacy = new LogPrivacyService(db, push);
    try {
      const before = await privacy.get(tenant);
      const omitted = await privacy.save(tenant, {
        expectedRevision: before.revision,
        policy: {
          clientIp: 'omit',
          userAgent: 'omit',
          redactedFields: ['path'],
        },
      });
      await expect(
        privacy.save(tenant, {
          expectedRevision: omitted.revision,
          policy: { clientIp: 'omit', userAgent: 'omit' },
        }),
      ).rejects.toThrow(/cleanup must finish/);
      // Fresh writes must never store their private path while omission is active.
      await insert(schema, [
        {
          id: randomUUID(),
          consumerId: consumer,
          timestamp: new Date().toISOString(),
          method: 'GET',
          path: '/never-return?credential=private',
          responseTimeMs: 3,
          statusCode: 200,
        },
      ]);
      await privacy.scrub();
      expect(
        await db.query(
          `SELECT path FROM ${schema}.consumer_path_rollups WHERE path<>'[redacted]'`,
        ),
      ).toEqual([]);
      const clean = await privacy.get(tenant);
      expect(clean.historicalCleanup).toBe('complete');
      await privacy.save(tenant, {
        expectedRevision: clean.revision,
        policy: { clientIp: 'omit', userAgent: 'omit' },
      });
      const worker = new ConsumerRollupService(db);
      try {
        await worker.sweep();
      } finally {
        await worker.onModuleDestroy();
      }
      expect(
        await db.query(
          `SELECT path FROM ${schema}.consumer_path_rollups WHERE path<>'[redacted]'`,
        ),
      ).toEqual([]);
      expect(
        await db.query(
          `SELECT SUM(requests)::text AS requests FROM ${schema}.consumer_path_rollups`,
        ),
      ).toEqual([{ requests: '608' }]);
    } finally {
      await privacy.onModuleDestroy();
    }
  }, 10000);

  it(
    'preserves count materialization at the independent real path cap and recovers after receipt expiry',
    () =>
      cases.run(async () => {
        const deadline = Date.now() + 60000;
        const checkpoint = () => {
          if (Date.now() >= deadline)
            throw new Error('Consumer path capacity work deadline exceeded');
        };
        const { id: tenant, schema, consumer } = await workspace();
        const [anchor] = await db.query(
          `SELECT to_char(date_trunc('minute',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at`,
        );
        checkpoint();
        await db.query(
          `INSERT INTO ${schema}.consumer_path_rollups SELECT $1::uuid,$2::timestamptz,$2::timestamptz,'GET','/p/'||i,$2::timestamptz,$2::timestamptz,1,0,1,ARRAY[0,0,0,1]::bigint[]||array_fill(0::bigint,ARRAY[29]) FROM generate_series(1,$3) i`,
          [consumer, anchor.at, CONSUMER_PATH_ROLLUP_CELL_LIMIT],
        );
        await db.query(
          `UPDATE ${schema}.consumer_path_rollup_state SET cells=$1 WHERE singleton`,
          [CONSUMER_PATH_ROLLUP_CELL_LIMIT],
        );
        await db.query(
          `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"responseTimeMs") VALUES (gen_random_uuid(),$1,$2,$2,'GET','/p/1',3),(gen_random_uuid(),$1,$2,$2,'GET','/new',3)`,
          [consumer, anchor.at],
        );
        expect((await state(schema)).attributed_records).toBe('2');
        expect(
          await db.query(
            `SELECT "usageRollupVersion","pathRollupVersion" FROM ${schema}.request_logs WHERE path='/new'`,
          ),
        ).toEqual([{ usageRollupVersion: 1, pathRollupVersion: null }]);
        expect(
          await db.query(
            `SELECT cells,capacity_blocked FROM ${schema}.consumer_path_rollup_state`,
          ),
        ).toEqual([
          { cells: CONSUMER_PATH_ROLLUP_CELL_LIMIT, capacity_blocked: true },
        ]);
        await db.query(
          `UPDATE ${schema}.consumer_path_rollups SET first_receipt=$1::timestamptz-INTERVAL '2 days',last_receipt=$1::timestamptz-INTERVAL '2 days' WHERE path='/p/2'`,
          [anchor.at],
        );
        expect(
          await db.transaction(async (manager) => {
            await manager.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`log-receipt:${tenant}`],
            );
            return eraseConsumerPathRollups(manager, tenant, {
              attributionHidden: false,
              receiptCutoff: anchor.at,
            });
          }),
        ).toBe(1);
        checkpoint();
        const worker = new ConsumerRollupService(db);
        try {
          await worker.sweep();
        } finally {
          await worker.onModuleDestroy();
        }
        expect(
          await db.query(
            `SELECT "pathRollupVersion" FROM ${schema}.request_logs WHERE path='/new'`,
          ),
        ).toEqual([{ pathRollupVersion: 1 }]);
        expect(
          await db.query(
            `SELECT cells,backfill_complete,capacity_blocked FROM ${schema}.consumer_path_rollup_state`,
          ),
        ).toEqual([
          {
            cells: CONSUMER_PATH_ROLLUP_CELL_LIMIT,
            backfill_complete: true,
            capacity_blocked: false,
          },
        ]);
        expect((await state(schema)).attributed_records).toBe('2');
      }),
    90000,
  );

  it('limits operator bulk-import materialization to 1,000 records and backfills the remainder', async () => {
    const { schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"responseTimeMs")
      SELECT gen_random_uuid(),$1,statement_timestamp(),3 FROM generate_series(1,1201)`,
      [consumer],
    );
    expect((await state(schema)).attributed_records).toBe('1000');
    const [pending] = await db.query(
      `SELECT COUNT(*)::integer AS records FROM ${schema}.request_logs WHERE "usageRollupVersion" IS NULL`,
    );
    expect(pending.records).toBe(201);
    const worker = new ConsumerRollupService(db);
    await worker.sweep();
    await worker.onModuleDestroy();
    expect((await state(schema)).attributed_records).toBe('1201');
    expect((await state(schema)).backfill_complete).toBe(true);
  });

  it('defers legacy naive-time imports until admin UTC migration before materializing consumer attribution', async () => {
    const { schema, consumer } = await workspace();
    await db.query(
      `ALTER TABLE ${schema}.request_logs ALTER COLUMN timestamp TYPE TIMESTAMP USING timestamp AT TIME ZONE 'UTC'`,
    );
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"responseTimeMs") VALUES (gen_random_uuid(),$1,'2026-10-01 12:34:56.123456',3)`,
      [consumer],
    );
    expect((await state(schema)).attributed_records).toBe('0');
    expect(
      await db.query(`SELECT "usageRollupVersion" FROM ${schema}.request_logs`),
    ).toEqual([{ usageRollupVersion: null }]);
    await new MigrationService(db).onModuleInit();
    const worker = new ConsumerRollupService(db);
    await worker.sweep();
    await worker.onModuleDestroy();
    const [rollup] = await db.query(
      `SELECT to_char(request_minute AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS minute,requests FROM ${schema}.consumer_usage_rollups`,
    );
    expect(rollup).toEqual({ minute: '2026-10-01T12:34:00Z', requests: '1' });
  });

  it('backfills 100,001 legacy records in bounded pages across reconstruction and concurrent replicas', async () => {
    const { schema, consumer } = await workspace();
    await db.query(
      `DROP TRIGGER consumer_usage_inserted ON ${schema}.request_logs`,
    );
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"receivedAt","statusCode","responseTimeMs")
      SELECT gen_random_uuid(),$1, date_trunc('minute',statement_timestamp())-INTERVAL '2 hours',date_trunc('minute',statement_timestamp())-INTERVAL '100 minutes'+make_interval(secs=>(i/1000)::integer*60),
        CASE WHEN i%10=0 THEN 503 ELSE 200 END,3 FROM generate_series(1,100001) i`,
      [consumer],
    );
    const first = new ConsumerRollupService(db);
    await first.sweep();
    expect(Number((await state(schema)).processed_records)).toBe(4000);
    await first.onModuleDestroy();
    const replicas = [
      new ConsumerRollupService(db),
      new ConsumerRollupService(db),
    ];
    for (let i = 0; i < 30; i++) {
      await Promise.all(replicas.map((service) => service.sweep()));
      if ((await state(schema)).backfill_complete) break;
    }
    await Promise.all(replicas.map((service) => service.onModuleDestroy()));
    const checkpoint = await state(schema);
    expect(checkpoint.processed_records).toBe('100001');
    expect(checkpoint.attributed_records).toBe('100001');
    expect(checkpoint.backfill_complete).toBe(true);
    expect(checkpoint.cells).toBe(101);
    const [totals] = await db.query(
      `SELECT SUM(requests)::text AS requests,SUM(server_errors)::text AS errors,SUM(latency_samples)::text AS samples FROM ${schema}.consumer_usage_rollups`,
    );
    expect(totals).toEqual({
      requests: '100001',
      errors: '10000',
      samples: '100001',
    });
    expect(
      await db.query(
        `SELECT id FROM ${schema}.request_logs WHERE "usageRollupVersion" IS NULL LIMIT 1`,
      ),
    ).toEqual([]);
  }, 60000);

  it('fences ingestion against a backfill receipt lock and preserves retry identity', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    const owner = db.createQueryRunner(),
      writer = db.createQueryRunner();
    await owner.connect();
    await writer.connect();
    try {
      await owner.startTransaction();
      await owner.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`log-receipt:${tenant}`],
      );
      await writer.startTransaction();
      await writer.query("SET LOCAL lock_timeout='100ms'");
      const id = randomUUID();
      await expect(
        writer.query(
          `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp) VALUES ($1,$2,clock_timestamp())`,
          [id, consumer],
        ),
      ).rejects.toThrow(/lock timeout/);
      await writer.rollbackTransaction();
      await owner.commitTransaction();
      await insert(schema, [
        {
          id,
          consumerId: consumer,
          timestamp: new Date().toISOString(),
          responseTimeMs: 1,
          statusCode: 200,
        },
      ]);
      await insert(schema, [
        {
          id,
          consumerId: consumer,
          timestamp: new Date().toISOString(),
          responseTimeMs: 1,
          statusCode: 200,
        },
      ]);
      expect((await state(schema)).attributed_records).toBe('1');
    } finally {
      if (owner.isTransactionActive) await owner.rollbackTransaction();
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await owner.release();
      await writer.release();
    }
  });

  it('preserves raw logs at the actual 250,000-cell cap and resumes after receipt cleanup frees space', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    const bins = CONSUMER_ROLLUP_HISTOGRAM_BOUNDS.length;
    await db.query(
      `INSERT INTO ${schema}.consumer_usage_rollups
      SELECT md5(i::text)::uuid,date_trunc('minute',clock_timestamp())-INTERVAL '100 days',date_trunc('minute',clock_timestamp())-INTERVAL '100 days',
      clock_timestamp()-INTERVAL '100 days',clock_timestamp()-INTERVAL '100 days',1,0,0,1,array_fill(0::bigint,ARRAY[$1::integer])
      FROM generate_series(1,$2::integer) i`,
      [bins, CONSUMER_ROLLUP_CELL_LIMIT],
    );
    await db.query(
      `UPDATE ${schema}.consumer_usage_rollup_state SET cells=$1`,
      [CONSUMER_ROLLUP_CELL_LIMIT],
    );
    const id = randomUUID();
    await insert(schema, [
      {
        id,
        consumerId: consumer,
        timestamp: new Date().toISOString(),
        statusCode: 200,
        responseTimeMs: 1,
      },
    ]);
    expect(
      await db.query(
        `SELECT "usageRollupVersion" FROM ${schema}.request_logs WHERE id=$1`,
        [id],
      ),
    ).toEqual([{ usageRollupVersion: null }]);
    expect((await state(schema)).capacity_blocked).toBe(true);
    const worker = new ConsumerRollupService(db);
    await worker.sweep();
    await worker.onModuleDestroy();
    expect((await state(schema)).attributed_records).toBe('1');
    expect((await state(schema)).cells).toBeLessThan(
      CONSUMER_ROLLUP_CELL_LIMIT,
    );
    expect(
      await db.query(
        `SELECT requests FROM ${schema}.consumer_usage_rollups WHERE consumer_id=$1`,
        [consumer],
      ),
    ).toEqual([{ requests: '1' }]);
    expect(
      (
        await db.query(
          `SELECT "consumerRollupError" FROM public.tenants WHERE id=$1`,
          [tenant],
        )
      )[0].consumerRollupError,
    ).toBe(false);
  }, 60000);

  it('retires completed tenants from pending discovery rather than revisiting them every page', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await insert(schema, [
      {
        id: randomUUID(),
        consumerId: consumer,
        timestamp: new Date().toISOString(),
      },
    ]);
    const worker = new ConsumerRollupService(db);
    const transactions = jest.spyOn(db, 'transaction');
    try {
      await worker.sweep();
      const [profile] = await db.query(
        `SELECT "consumerRollupPending" FROM public.tenants WHERE id=$1`,
        [tenant],
      );
      expect(profile.consumerRollupPending).toBe(false);
      expect(transactions).toHaveBeenCalledTimes(2);
      const before = transactions.mock.calls.length;
      await worker.sweep();
      expect(transactions.mock.calls.length - before).toBe(1);
      expect((await state(schema)).processed_records).toBe('1');
    } finally {
      transactions.mockRestore();
      await worker.onModuleDestroy();
    }
  });

  it(
    'wakes a recently idle workspace for new bulk backfill without reversing receipt/public locks',
    () =>
      cases.run(async () => {
        const { id: tenant, schema, consumer } = await workspace();
        const worker = new ConsumerRollupService(db);
        const locker = db.createQueryRunner();
        await locker.connect();
        try {
          await worker.sweep();
          expect((await state(schema)).backfill_complete).toBe(true);
          await locker.startTransaction();
          await locker.query(
            'SELECT id FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE',
            [tenant],
          );
          // An ingestion transaction already owns the receipt fence. Its wake-up
          // must commit while this unrelated public tenant lock remains held.
          await db.query(
            `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp)
        SELECT gen_random_uuid(),$1,statement_timestamp() FROM generate_series(1,1001)`,
            [consumer],
          );
          await locker.commitTransaction();
          expect(
            await db.query(
              'SELECT tenant_id FROM public.consumer_rollup_backlog WHERE tenant_id=$1',
              [tenant],
            ),
          ).toEqual([{ tenant_id: tenant }]);
          expect((await state(schema)).processed_records).toBe('1000');
          await worker.sweep();
          expect((await state(schema)).processed_records).toBe('1001');
          expect((await state(schema)).backfill_complete).toBe(true);
          expect(
            await db.query(
              'SELECT tenant_id FROM public.consumer_rollup_backlog WHERE tenant_id=$1',
              [tenant],
            ),
          ).toEqual([]);
          expect(
            (
              await db.query(
                `SELECT backfill_complete,processed_records::text AS processed FROM ${schema}.consumer_path_rollup_state`,
              )
            )[0],
          ).toEqual({ backfill_complete: true, processed: '1001' });
        } finally {
          if (locker.isTransactionActive) await locker.rollbackTransaction();
          await worker.onModuleDestroy();
          await locker.release();
        }
      }),
    10000,
  );

  it(
    'recovers pending wake-ups during an upgrade without replaying marked source records',
    () =>
      cases.run(async () => {
        const { id: tenant, schema, consumer } = await workspace();
        let worker = new ConsumerRollupService(db);
        try {
          await worker.sweep();
          await db.query(
            `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp)
        SELECT gen_random_uuid(),$1,statement_timestamp() FROM generate_series(1,1001)`,
            [consumer],
          );
          await db.query(
            'DELETE FROM public.consumer_rollup_backlog WHERE tenant_id=$1',
            [tenant],
          );
          await worker.sweep();
          expect((await state(schema)).processed_records).toBe('1000');
          await worker.onModuleDestroy();
          await db.query(consumerRollupSchemaSql(tenant));
          worker = new ConsumerRollupService(db);
          await worker.sweep();
          expect((await state(schema)).processed_records).toBe('1001');
          expect(
            await db.query(
              `SELECT SUM(requests)::text AS requests FROM ${schema}.consumer_usage_rollups`,
            ),
          ).toEqual([{ requests: '1001' }]);
          expect(
            await db.query(
              `SELECT SUM(requests)::text AS requests FROM ${schema}.consumer_path_rollups`,
            ),
          ).toEqual([{ requests: '1001' }]);
        } finally {
          await worker.onModuleDestroy();
        }
      }),
    10000,
  );

  it(
    'rolls back ingestion and both aggregates if durable wake-up persistence fails',
    () =>
      cases.run(async () => {
        const { id: tenant, schema, consumer } = await workspace();
        await db.query(
          `ALTER TABLE public.consumer_rollup_backlog ADD CONSTRAINT reject_wakeup CHECK(tenant_id<>'${tenant}'::uuid)`,
        );
        try {
          await expect(
            db.query(
              `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp)
        SELECT gen_random_uuid(),$1,statement_timestamp() FROM generate_series(1,1001)`,
              [consumer],
            ),
          ).rejects.toThrow(/reject_wakeup/);
          expect(
            await db.query(
              `SELECT COUNT(*)::integer AS rows FROM ${schema}.request_logs`,
            ),
          ).toEqual([{ rows: 0 }]);
          expect((await state(schema)).processed_records).toBe('0');
          expect(
            await db.query(
              `SELECT processed_records::text AS processed FROM ${schema}.consumer_path_rollup_state`,
            ),
          ).toEqual([{ processed: '0' }]);
          expect(
            await db.query(
              'SELECT tenant_id FROM public.consumer_rollup_backlog WHERE tenant_id=$1',
              [tenant],
            ),
          ).toEqual([]);
        } finally {
          await db.query(
            'ALTER TABLE public.consumer_rollup_backlog DROP CONSTRAINT reject_wakeup',
          );
        }
      }),
    10000,
  );

  it('makes progress after a brief tenant lock instead of losing the whole sweep', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp)
       SELECT gen_random_uuid(),$1,clock_timestamp() FROM generate_series(1,1001)`,
      [consumer],
    );
    const locker = db.createQueryRunner();
    const worker = new ConsumerRollupService(db);
    await locker.connect();
    let work: Promise<void> | undefined;
    try {
      await locker.startTransaction();
      await locker.query(
        'SELECT id FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE',
        [tenant],
      );
      work = worker.sweep();
      await new Promise((done) => setTimeout(done, 100));
      await locker.commitTransaction();
      await work;
      expect((await state(schema)).processed_records).toBe('1001');
      expect((await state(schema)).backfill_complete).toBe(true);
    } finally {
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await work;
      await worker.onModuleDestroy();
      await locker.release();
    }
  }, 10000);

  it('retries receipt-lock contention promptly without treating it as a materialization failure', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp)
       SELECT gen_random_uuid(),$1,clock_timestamp() FROM generate_series(1,1001)`,
      [consumer],
    );
    const healthy = await workspace();
    await db.query(
      `INSERT INTO ${healthy.schema}.request_logs(id,"consumerId",timestamp)
       SELECT gen_random_uuid(),$1,clock_timestamp() FROM generate_series(1,1001)`,
      [healthy.consumer],
    );
    // The blocked tenant is first; another workspace must still progress in
    // the same sweep while the receipt lock remains held.
    await db.query(
      `UPDATE public.tenants SET "consumerRollupCheckedAt"=clock_timestamp()-INTERVAL '2 minutes' WHERE id=$1`,
      [healthy.id],
    );
    const locker = db.createQueryRunner();
    const worker = new ConsumerRollupService(db);
    await locker.connect();
    try {
      await locker.startTransaction();
      await locker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`log-receipt:${tenant}`],
      );
      await worker.sweep();
      const [blocked] = await db.query(
        `SELECT "consumerRollupError" AS error,"consumerRollupPending" AS pending
         FROM public.tenants WHERE id=$1`,
        [tenant],
      );
      expect(blocked).toEqual({ error: false, pending: true });
      expect((await state(schema)).processed_records).toBe('1000');
      expect((await state(healthy.schema)).processed_records).toBe('1001');
      await locker.commitTransaction();
      const deadline = Date.now() + 5000;
      while (
        !(await state(schema)).backfill_complete &&
        Date.now() < deadline
      ) {
        await new Promise((done) => setTimeout(done, 100));
        await worker.sweep();
      }
      expect((await state(schema)).backfill_complete).toBe(true);
      expect((await state(schema)).processed_records).toBe('1001');
      expect(
        await db.query(
          `SELECT SUM(requests)::text AS requests FROM ${schema}.consumer_path_rollups`,
        ),
      ).toEqual([{ requests: '1001' }]);
    } finally {
      if (locker.isTransactionActive) await locker.rollbackTransaction();
      await worker.onModuleDestroy();
      await locker.release();
    }
  }, 10000);

  it('keeps actual aggregate failures in the one-minute cooldown without committing partial counts', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp)
       SELECT gen_random_uuid(),$1,statement_timestamp() FROM generate_series(1,1001)`,
      [consumer],
    );
    await db.query(
      `ALTER TABLE ${schema}.consumer_path_rollups ADD CONSTRAINT reject_backfill CHECK(requests<=1000)`,
    );
    const worker = new ConsumerRollupService(db);
    try {
      await worker.sweep();
      expect(
        (
          await db.query(
            `SELECT "consumerRollupError" AS error FROM public.tenants WHERE id=$1`,
            [tenant],
          )
        )[0].error,
      ).toBe(true);
      expect((await state(schema)).processed_records).toBe('1000');
      await db.query(
        `ALTER TABLE ${schema}.consumer_path_rollups DROP CONSTRAINT reject_backfill`,
      );
      await worker.sweep();
      expect((await state(schema)).processed_records).toBe('1000');
      await db.query(
        `UPDATE public.tenants SET "consumerRollupCheckedAt"=clock_timestamp()-INTERVAL '61 seconds' WHERE id=$1`,
        [tenant],
      );
      await worker.sweep();
      expect((await state(schema)).processed_records).toBe('1001');
      expect(
        (
          await db.query(
            `SELECT "consumerRollupError" AS error FROM public.tenants WHERE id=$1`,
            [tenant],
          )
        )[0].error,
      ).toBe(false);
    } finally {
      await worker.onModuleDestroy();
    }
  }, 10000);

  it(
    'lets competing privacy replicas progress after a brief tenant lock instead of losing both sweeps',
    () =>
      cases.run(async () => {
        const { id: tenant, schema, consumer } = await workspace();
        await db.query(
          `INSERT INTO ${schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"responseTimeMs")
      SELECT gen_random_uuid(),$1,statement_timestamp(),statement_timestamp(),'GET','/private/'||i,3 FROM generate_series(1,600) i`,
          [consumer],
        );
        const replicas = [
          new LogPrivacyService(db, push),
          new LogPrivacyService(db, push),
        ];
        const current = await replicas[0].get(tenant);
        await replicas[0].save(tenant, {
          expectedRevision: current.revision,
          policy: {
            clientIp: 'omit',
            userAgent: 'omit',
            redactedFields: ['path'],
          },
        });
        const locker = db.createQueryRunner();
        await locker.connect();
        let work: Promise<void[]> | undefined;
        try {
          await locker.startTransaction();
          await locker.query(
            'SELECT id FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE',
            [tenant],
          );
          work = Promise.all(replicas.map((replica) => replica.scrub()));
          await new Promise((done) => setTimeout(done, 100));
          await locker.commitTransaction();
          await work;
          expect(
            await db.query(
              `SELECT COUNT(*)::integer AS private FROM ${schema}.request_logs WHERE path<>'[redacted]'`,
            ),
          ).toEqual([{ private: 0 }]);
          expect(
            await db.query(
              `SELECT path,requests::text AS requests FROM ${schema}.consumer_path_rollups`,
            ),
          ).toEqual([{ path: '[redacted]', requests: '600' }]);
          expect(
            await db.query(
              `SELECT SUM(requests)::text AS requests FROM ${schema}.consumer_usage_rollups`,
            ),
          ).toEqual([{ requests: '600' }]);
          expect((await replicas[0].get(tenant)).historicalCleanup).toBe(
            'complete',
          );
        } finally {
          if (locker.isTransactionActive) await locker.rollbackTransaction();
          await work;
          await Promise.all(
            replicas.map((replica) => replica.onModuleDestroy()),
          );
          await locker.release();
        }
      }),
    10000,
  );

  it('returns actual bounded erasure counts alongside atomic capacity updates', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp)
       SELECT gen_random_uuid(),$1,date_trunc('minute',clock_timestamp())-make_interval(secs=>i*60) FROM generate_series(1,606) i`,
      [consumer],
    );
    const erase = () =>
      db.transaction(async (manager) => {
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          [`log-receipt:${tenant}`],
        );
        return eraseConsumerRollups(manager, tenant, {
          attributionHidden: true,
        });
      });
    expect(await erase()).toBe(500);
    expect((await state(schema)).cells).toBe(106);
    expect(await erase()).toBe(106);
    expect((await state(schema)).cells).toBe(0);
    expect(await erase()).toBe(0);
  });

  it('erases old consumer attribution before allowing privacy retention to be restored', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp)
      SELECT gen_random_uuid(),$1,date_trunc('minute',clock_timestamp())-make_interval(secs=>i*60) FROM generate_series(1,606) i`,
      [consumer],
    );
    const privacy = new LogPrivacyService(db, push);
    const before = await privacy.get(tenant);
    const omitted = await privacy.save(tenant, {
      expectedRevision: before.revision,
      policy: {
        clientIp: 'omit',
        userAgent: 'omit',
        redactedFields: ['consumerId'],
      },
    });
    await expect(
      privacy.save(tenant, {
        expectedRevision: omitted.revision,
        policy: { clientIp: 'omit', userAgent: 'omit' },
      }),
    ).rejects.toThrow(/cleanup must finish/);
    await privacy.scrub();
    expect(
      await db.query(
        `SELECT consumer_id FROM ${schema}.consumer_usage_rollups LIMIT 1`,
      ),
    ).toEqual([]);
    expect((await state(schema)).cells).toBe(0);
    expect(
      await db.query(
        `SELECT consumer_id FROM ${schema}.consumer_path_rollups LIMIT 1`,
      ),
    ).toEqual([]);
    expect(
      await db.query(`SELECT cells FROM ${schema}.consumer_path_rollup_state`),
    ).toEqual([{ cells: 0 }]);
    expect(
      await db.query(
        `SELECT id FROM ${schema}.request_logs WHERE "consumerId" IS NOT NULL LIMIT 1`,
      ),
    ).toEqual([]);
    const clean = await privacy.get(tenant);
    expect(clean.historicalCleanup).toBe('complete');
    await privacy.save(tenant, {
      expectedRevision: clean.revision,
      policy: { clientIp: 'omit', userAgent: 'omit' },
    });
    await db.query(
      `SELECT ${schema}.materialize_consumer_usage(ARRAY(SELECT id FROM ${schema}.request_logs LIMIT 500))`,
    );
    expect(
      await db.query(
        `SELECT consumer_id FROM ${schema}.consumer_usage_rollups LIMIT 1`,
      ),
    ).toEqual([]);
    await privacy.onModuleDestroy();
  });

  it.each([
    { fields: null, attributed: 0 },
    { fields: ['path', 'path'], attributed: 0 },
    { fields: ['unknown'], attributed: 0 },
    { fields: [], clientIp: 'invalid', attributed: 0 },
    { fields: [], extra: true, attributed: 0 },
    { fields: ['path'], attributed: 1 },
    { legacy: true, attributed: 1 },
  ])('matches fail-closed legacy privacy for backfill: %#', async (input) => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `DROP TRIGGER consumer_usage_inserted ON ${schema}.request_logs`,
    );
    await insert(schema, [
      {
        id: randomUUID(),
        consumerId: consumer,
        timestamp: new Date().toISOString(),
        statusCode: 200,
        responseTimeMs: 1,
      },
    ]);
    const policy = input.legacy
      ? {}
      : {
          clientIp: input.clientIp ?? 'omit',
          userAgent: 'omit',
          redactedFields: input.fields,
          ...(input.extra ? { extra: true } : {}),
        };
    await db.query(
      'UPDATE public.tenants SET "logPrivacy"=$2::jsonb WHERE id=$1',
      [tenant, JSON.stringify(policy)],
    );
    const worker = new ConsumerRollupService(db);
    await worker.sweep();
    await worker.onModuleDestroy();
    expect((await state(schema)).processed_records).toBe('1');
    expect((await state(schema)).attributed_records).toBe(
      String(input.attributed),
    );
    expect((await state(schema)).cells).toBe(input.attributed);
    expect(
      await db.query(
        `SELECT processed_records,attributed_records,cells FROM ${schema}.consumer_path_rollup_state`,
      ),
    ).toEqual([
      {
        processed_records: '1',
        attributed_records: String(input.attributed),
        cells: input.attributed,
      },
    ]);
  });

  it('expires rollups by database receipt while retaining late requests, with no shrink/increase resurrection', async () => {
    const { id: tenant, schema, consumer } = await workspace();
    await db.query(
      `UPDATE public.tenants SET "logRetentionDays"=90,"logRetentionFloor"=clock_timestamp()-INTERVAL '90 days' WHERE id=$1`,
      [tenant],
    );
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"receivedAt") VALUES
      (gen_random_uuid(),$1,clock_timestamp()-INTERVAL '40 days',clock_timestamp()-INTERVAL '35 days'),
      (gen_random_uuid(),$1,clock_timestamp()-INTERVAL '40 days',clock_timestamp())`,
      [consumer],
    );
    expect((await state(schema)).cells).toBe(2);
    const retention = new LogRetentionService(db);
    const before = await retention.get(tenant);
    const shorter = await retention.save(tenant, {
      expectedRevision: before.revision,
      days: 1,
    });
    await retention.prune();
    const [rollup] = await db.query(
      `SELECT requests,late_records FROM ${schema}.consumer_usage_rollups`,
    );
    expect(rollup).toEqual({ requests: '1', late_records: '1' });
    expect((await state(schema)).cells).toBe(1);
    expect(
      await db.query(`SELECT requests FROM ${schema}.consumer_path_rollups`),
    ).toEqual([{ requests: '1' }]);
    expect(
      await db.query(`SELECT cells FROM ${schema}.consumer_path_rollup_state`),
    ).toEqual([{ cells: 1 }]);
    await retention.save(tenant, {
      expectedRevision: shorter.revision,
      days: 90,
    });
    const worker = new ConsumerRollupService(db);
    await worker.sweep();
    expect(
      await db.query(`SELECT requests FROM ${schema}.consumer_usage_rollups`),
    ).toEqual([{ requests: '1' }]);
    expect(
      await db.query(`SELECT requests FROM ${schema}.consumer_path_rollups`),
    ).toEqual([{ requests: '1' }]);
    await worker.onModuleDestroy();
    await retention.onModuleDestroy();
  });
});
