import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';

// Authenticated disposable gateway/tenant fixture. No real storage credentials.
export async function configureArchiveFixture({ adminUrl, tenant, headers }) {
  const scheduleUrl = `${adminUrl}/tenants/${tenant}/log-exports/schedule`;
  assert.equal((await fetch(scheduleUrl)).status, 401);
  const response = await fetch(scheduleUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      cadence: 'near_real_time',
      filter: { pathPrefix: '/traffic' },
      expectedRevision: null,
    }),
  });
  assert.equal(response.status, 200);
  const configuration = await response.json();
  assert.equal(configuration.available, true);
  assert.equal(configuration.settlementSeconds, 15);
  assert.equal(configuration.schedule.cadence, 'near_real_time');
  return {
    async lateLog(planeUrl, apiKey) {
      const ws = new WebSocket(planeUrl);
      try {
        await once(ws, 'open');
        const authentication = once(ws, 'message');
        ws.send(JSON.stringify({ type: 'auth', payload: { apiKey } }));
        assert.equal(
          JSON.parse((await authentication)[0].toString()).type,
          'auth_ok',
        );
        ws.send(
          JSON.stringify({
            type: 'logs',
            payload: [
              {
                id: randomUUID(),
                method: 'GET',
                path: '/traffic',
                statusCode: 200,
                responseTimeMs: 1,
                requestId: 'receipt-runtime-late',
                consumerId: 'legacy-principal-fixture',
                clientIp: '',
                timestamp: '2000-01-01T00:00:00Z',
                receivedAt: '1999-01-01T00:00:00Z',
              },
            ],
          }),
        );
        // Allow dispatch before closing; the database poll below proves storage.
        await new Promise((done) => setTimeout(done, 250));
      } finally {
        ws.close();
      }
    },
    async verify({
      db,
      schema,
      until,
      storageUrl,
      bucket,
      trafficRequests = 20,
    }) {
      const expected = trafficRequests + 1;
      await until(
        async () =>
          Number(
            (
              await db.query(
                `SELECT COUNT(*) FROM ${schema}.request_logs WHERE path='/traffic'`,
              )
            ).rows[0].count,
          ) === expected,
        'Production receipt ingestion',
      );
      const late = (
        await db.query(
          `SELECT timestamp,"receivedAt","consumerId" FROM ${schema}.request_logs WHERE "requestId"='receipt-runtime-late'`,
        )
      ).rows[0];
      assert.equal(late.timestamp.toISOString(), '2000-01-01T00:00:00.000Z');
      assert.equal(
        late.consumerId,
        null,
        'Legacy unrelated principals must not reject receipt ingestion',
      );
      assert.ok(late.receivedAt.getTime() > Date.now() - 150000);
      let jobs;
      await until(
        async () => {
          const response = await fetch(
            `${adminUrl}/tenants/${tenant}/log-exports`,
            { headers },
          );
          assert.equal(response.status, 200);
          jobs = (await response.json()).jobs.filter(
            (job) => job.kind === 'scheduled',
          );
          return (
            jobs
              .filter((job) => job.status === 'completed')
              .reduce((sum, job) => sum + job.rowCount, 0) === expected
          );
        },
        'Automatic scheduled RustFS archives',
        150000,
      );
      assert.ok(jobs.length > 0 && jobs.length <= 4);
      assert.equal(
        new Set(jobs.map((job) => `${job.filter.from}/${job.filter.to}`)).size,
        jobs.length,
      );
      const rows = [];
      for (const job of jobs) {
        assert.equal(job.timeBasis, 'receipt');
        assert.equal(job.status, 'completed');
        const response = await fetch(
          `${adminUrl}/tenants/${tenant}/log-exports/${job.id}/download`,
          { headers },
        );
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get('content-type'),
          /application\/x-ndjson/,
        );
        rows.push(
          ...(await response.text())
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        );
      }
      assert.equal(rows.length, expected);
      assert.equal(new Set(rows.map((row) => row.id)).size, expected);
      const persistedIds = (
        await db.query(
          `SELECT id FROM ${schema}.request_logs WHERE path='/traffic'`,
        )
      ).rows
        .map((row) => row.id)
        .sort();
      assert.deepEqual(rows.map((row) => row.id).sort(), persistedIds);
      assert.ok(!JSON.stringify(rows).includes('fixture-should-not-export'));
      assert.ok(!JSON.stringify(rows).includes('private=fixture'));
      assert.equal(
        rows.find((row) => row.requestId === 'receipt-runtime-late').timestamp,
        '2000-01-01T00:00:00.000000Z',
      );
      assert.ok(
        rows.every(
          (row) =>
            row.path === '/traffic' &&
            !('receivedAt' in row) &&
            !('export_cursor' in row),
        ),
      );
      const privateObjects = (
        await db.query(
          `SELECT object_key FROM public.log_export_jobs WHERE tenant_id=$1 AND kind='scheduled'`,
          [tenant],
        )
      ).rows;
      for (const { object_key: key } of privateObjects)
        assert.equal(
          (await fetch(`${storageUrl}/${bucket}/${key}`)).status,
          403,
        );
      const current = await (await fetch(scheduleUrl, { headers })).json();
      const paused = await fetch(scheduleUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          cadence: current.schedule.cadence,
          filter: current.schedule.filter,
          expectedRevision: current.schedule.revision,
        }),
      });
      assert.equal(paused.status, 200);
      assert.equal((await paused.json()).schedule.enabled, false);
      return {
        jobs: jobs.length,
        exportedRows: rows.length,
        lateRequestIncluded: true,
        privateObjects: privateObjects.length,
        paused: true,
      };
    },
  };
}
