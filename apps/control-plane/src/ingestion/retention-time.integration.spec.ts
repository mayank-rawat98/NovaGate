import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { LogIngestionService } from './log-ingestion.service';
import { TraceIngestionService } from './trace-ingestion.service';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const cases = ['UTC', 'America/New_York', 'Asia/Kolkata'].flatMap((zone) =>
  ['2026-03-09T12:00:00Z', '2026-11-02T12:00:00Z'].map((now) => ({
    zone,
    now,
  })),
);
integration('Elapsed-day ingestion and idle retention on PostgreSQL', () => {
  const database = 'novagate_ingestion_time_' + randomUUID().replace(/-/g, '');
  const tenant = randomUUID();
  const schema = 'tenant_' + tenant.replace(/-/g, '_');
  const traceId = '0123456789abcdef0123456789abcdef';
  let root: DataSource, db: DataSource;
  let zone: string, now: string;
  let traces: TraceIngestionService, logs: LogIngestionService;
  const fixedClock = (sql: string) =>
    sql.replace(/\bNOW\(\)/gi, `'${now}'::timestamptz`);

  beforeAll(async () => {
    root = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    });
    await root.initialize();
    await root.query('CREATE DATABASE ' + database);
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = '/' + database;
    db = new DataSource({ type: 'postgres', url: url.toString() });
    await db.initialize();
    await db.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.trace_spans (
        "traceId" varchar(32), "spanId" varchar(16), "parentSpanId" varchar(16),
        name varchar(128), kind varchar, timestamp timestamptz,
        "durationMs" double precision, status varchar, attributes jsonb,
        PRIMARY KEY ("traceId", "spanId")
      );
      CREATE TABLE ${schema}.metrics_snapshots (
        id serial PRIMARY KEY, rps double precision, "p50Ms" integer,
        "p95Ms" integer, "p99Ms" integer, "errorRate" double precision,
        timestamp timestamptz, "aggregateWindow" jsonb
      )`);
  }, 30000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (root?.isInitialized) {
      await root.query('DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)');
      await root.destroy();
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await traces?.onModuleDestroy();
    await logs?.onModuleDestroy();
  });

  async function prepare(input: (typeof cases)[number]) {
    ({ zone, now } = input);
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    // Only the clock is substituted. Production services execute their real SQL,
    // deadlines, locks and transactions against PostgreSQL at both DST transitions.
    const source = {
      transaction: (fn: (manager: EntityManager) => Promise<unknown>) =>
        db.transaction(async (manager) => {
          await manager.query("SELECT set_config('TimeZone',$1,true)", [zone]);
          return fn({
            query: (sql: string, params?: unknown[]) =>
              manager.query(fixedClock(sql), params),
          } as EntityManager);
        }),
    } as DataSource;
    const config = new ConfigService({
      traceIngestion: { retentionDays: 2 },
      metricIngestion: { retentionDays: 2 },
    });
    traces = new TraceIngestionService(source, config);
    logs = new LogIngestionService(source, config);
    await db.query(
      `TRUNCATE ${schema}.trace_spans, ${schema}.metrics_snapshots`,
    );
    for (const [index, offset] of [-1, 0, 1].entries()) {
      await db.query(
        `INSERT INTO ${schema}.trace_spans
        ("traceId","spanId",name,kind,timestamp,"durationMs",status,attributes)
        VALUES ($1,$2,'Boundary','server',$3::timestamptz-INTERVAL '48 hours'+$4*INTERVAL '1 microsecond',1,'ok','{}')`,
        [traceId, index.toString(16).padStart(16, '1'), now, offset],
      );
      await db.query(
        `INSERT INTO ${schema}.metrics_snapshots (rps,timestamp)
        VALUES ($1,$2::timestamptz-INTERVAL '48 hours'+$3*INTERVAL '1 microsecond')`,
        [index + 1, now, offset],
      );
    }
  }
  async function assertBoundary() {
    const [traceRows, metricRows] = await Promise.all([
      db.query(
        `SELECT "spanId" FROM ${schema}.trace_spans WHERE "traceId"=$1 ORDER BY timestamp`,
        [traceId],
      ),
      db.query(
        `SELECT rps FROM ${schema}.metrics_snapshots WHERE rps<=3 ORDER BY timestamp`,
      ),
    ]);
    expect(traceRows.map((r: { spanId: string }) => r.spanId)).toEqual([
      '1111111111111111',
      '1111111111111112',
    ]);
    expect(metricRows.map((r: { rps: number }) => r.rps)).toEqual([2, 3]);
  }
  it.each(cases)(
    'keeps the inclusive microsecond boundary during ingestion: $zone $now',
    async (input) => {
      await prepare(input);
      await traces.ingest(tenant, [
        {
          traceId: '1123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          name: 'Fresh',
          kind: 'server',
          timestamp: now,
          durationMs: 1,
          status: 'ok',
          attributes: {},
        },
      ]);
      expect(
        await logs.ingestMetrics(tenant, {
          rps: 10,
          p50: 1,
          p95: 2,
          p99: 3,
          errorRate: 0,
        }),
      ).toMatchObject({ rps: 10, timestamp: new Date(now).toISOString() });
      await assertBoundary();
    },
  );
  it.each(cases)(
    'keeps the same boundary for tenants without new traffic: $zone $now',
    async (input) => {
      await prepare(input);
      await traces.cleanupExpired();
      await logs.cleanupExpired();
      await assertBoundary();
    },
  );
});
