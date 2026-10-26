import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { RetentionCaseWork } from '../retention-case-work.fixture';

const tracked = process.env.RETENTION_CASE_TRACKED === 'true';
const owner = new RetentionCaseWork();
const schema = 'retention_timeout_' + randomUUID().replace(/-/g, '');
const db = new DataSource({
  type: 'postgres',
  url: process.env.TEST_DATABASE_URL,
});
const run = (work: () => Promise<void>) => (tracked ? owner.run(work) : work());
beforeAll(async () => {
  await db.initialize();
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`CREATE TABLE ${schema}.events(name text NOT NULL)`);
});
afterEach(async () => {
  const cleanup = async () => {
    await db.query(`TRUNCATE ${schema}.events`);
  };
  if (tracked) await owner.finish(cleanup);
  else await cleanup();
});
afterAll(async () => {
  try {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await db.destroy();
  }
});

it(
  'keeps writing after Jest stops observing the timed-out body',
  () =>
    run(async () => {
      await db.query('SELECT pg_sleep(0.6)');
      await db.query(
        `INSERT INTO ${schema}.events VALUES ('late-previous-case')`,
      );
    }),
  100,
);

it('starts the next case only after previous writes and cleanup finish', () =>
  run(async () => {
    await db.query(`INSERT INTO ${schema}.events VALUES ('current-case')`);
    await db.query('SELECT pg_sleep(0.8)');
    expect(
      await db.query(`SELECT name FROM ${schema}.events ORDER BY name`),
    ).toEqual([{ name: 'current-case' }]);
  }));
