import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const total = 400001;
const ordinaryRecords = 380000;
const ordinaryGroups = 19994;
const bounds = [0, ...Array.from({ length: 31 }, (_, i) => 2 ** i), 2147483647];
const empty = () => ({
  requests: 0,
  serverErrors: 0,
  latencySamples: 0,
  histogram: bounds.map(() => 0),
});
const add = (group, i) => {
  group.requests++;
  if (i % 10 === 0) group.serverErrors++;
  if (i % 20 > 1) {
    group.latencySamples++;
    group.histogram[bounds.findIndex((upper) => i % 71 <= upper)]++;
  }
};
const counts = (group) => {
  const percentile = (percent) => {
    if (!group.latencySamples) return null;
    const rank = Math.ceil((group.latencySamples * percent) / 100);
    let seen = 0;
    for (let i = 0; i < bounds.length; i++) {
      seen += group.histogram[i];
      if (seen >= rank) return bounds[i];
    }
    throw new Error('Reference histogram is incomplete');
  };
  return {
    requests: group.requests,
    serverErrors: group.serverErrors,
    latencySamples: group.latencySamples,
    errorRate: group.serverErrors / group.requests,
    rps: group.requests / 86400,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
  };
};
const ordered = (groups) =>
  [...groups].sort(
    (a, b) =>
      b.requests - a.requests ||
      Buffer.compare(Buffer.from(a.method), Buffer.from(b.method)) ||
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );

/** Finite persisted-log workload with real production timers and two admin replicas. */
export async function verifyConsumerRollupReplicas({
  adminUrls,
  db,
  databaseUrl,
  restartReplica,
}) {
  assert.equal(adminUrls.length, 2);
  const deadline = AbortSignal.timeout(480000);
  const request = (replica, path, options = {}) =>
    fetch(`${adminUrls[replica]}${path}`, {
      ...options,
      signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
  const wait = async (check, label, budget) => {
    const until = performance.now() + budget;
    while (performance.now() < until) {
      deadline.throwIfAborted();
      if (await check()) return;
      await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const workspace = async (replica, name) => {
    const tenant = randomUUID(),
      token = randomUUID();
    await db.query(
      `INSERT INTO public.tenants(id,name,email,"planId","verifyToken","verifyExpires")
      VALUES($1,$2,$3,'free',$4,clock_timestamp()+INTERVAL '10 minutes')`,
      [tenant, name, `${tenant}@example.test`, token],
    );
    const verified = await request(replica, '/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(verified.status, 200);
    const session = await verified.json();
    assert.equal(session.tenantId, tenant);
    const headers = {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    };
    const created = await request(replica, `/tenants/${tenant}/consumers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
    });
    assert.equal(created.status, 201);
    return {
      tenant,
      schema: `tenant_${tenant.replaceAll('-', '_')}`,
      consumer: (await created.json()).id,
      headers,
    };
  };
  const main = await workspace(0, 'High cardinality'),
    small = await workspace(1, 'Fairness');
  const statsPath = (space, period = '24h') =>
    `/tenants/${space.tenant}/consumers/${space.consumer}/stats?period=${period}`;
  const stats = async (replica, space, period = '24h') => {
    const started = performance.now();
    const response = await request(replica, statsPath(space, period), {
      headers: space.headers,
    });
    const body = await response.json();
    return {
      status: response.status,
      body,
      elapsedMs: performance.now() - started,
    };
  };
  const state = async (space) =>
    (
      await db.query(`SELECT c.processed_records::text AS counts,
    p.processed_records::text AS paths,c.backfill_complete AND p.backfill_complete AS complete,
    c.cells AS count_cells,p.cells AS path_cells FROM ${space.schema}.consumer_usage_rollup_state c
    CROSS JOIN ${space.schema}.consumer_path_rollup_state p`)
    ).rows[0];
  const groups = new Map(),
    aggregate = empty();
  for (let i = 1; i <= total; i++) {
    const g = (i - 1) % ordinaryGroups;
    const method = i <= ordinaryRecords && g % 2 ? 'POST' : 'GET';
    const path =
      i <= ordinaryRecords
        ? `/高容量/${String(g).padStart(5, '0')}`
        : '/winner';
    const key = `${method} ${path}`;
    if (!groups.has(key)) groups.set(key, { ...empty(), method, path });
    add(groups.get(key), i);
    add(aggregate, i);
  }
  const expectedTop = ordered(groups.values())
    .slice(0, 10)
    .map((group) => ({
      ...counts(group),
      method: group.method,
      path: group.path,
    }));
  const verify = (body, redacted = false) => {
    for (const [key, value] of Object.entries(counts(aggregate)))
      assert.equal(body[key], value, `Exact ${key}`);
    assert.equal(body.source, 'consumer_rollups');
    assert.equal(body.rollup.paths, 'complete_for_retained_records');
    assert.equal(
      body.rollup.pathAggregation.groups,
      redacted ? 2 : groups.size,
    );
    assert.equal(body.rollup.pathAggregation.pendingRecords, 0);
    if (!redacted) assert.deepEqual(body.topPaths, expectedTop);
    else {
      const methods = new Map();
      for (const group of groups.values()) {
        if (!methods.has(group.method))
          methods.set(group.method, {
            ...empty(),
            method: group.method,
            path: '[redacted]',
          });
        const target = methods.get(group.method);
        for (const key of ['requests', 'serverErrors', 'latencySamples'])
          target[key] += group[key];
        group.histogram.forEach((count, i) => (target.histogram[i] += count));
      }
      assert.deepEqual(
        body.topPaths,
        ordered(methods.values()).map((group) => ({
          ...counts(group),
          method: group.method,
          path: group.path,
        })),
      );
    }
    assert.equal(
      body.series.reduce((sum, bucket) => sum + bucket.requests, 0),
      total,
    );
    assert.doesNotMatch(
      JSON.stringify(body),
      /never-return|histogram"|RollupVersion/,
    );
    if (redacted) assert.doesNotMatch(JSON.stringify(body), /高容量|\/winner/);
  };
  const started = performance.now();
  await db.query(
    `INSERT INTO ${main.schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"statusCode","responseTimeMs")
    SELECT md5($1::text||':'||i)::uuid,$2,
      date_trunc('minute',statement_timestamp())-INTERVAL '2 hours'+make_interval(secs=>
        CASE WHEN i<=${ordinaryRecords} THEN (((i-1)%${ordinaryGroups})/3333)*60 ELSE ((i-${ordinaryRecords + 1})%6)*60 END),
      statement_timestamp(),CASE WHEN i<=${ordinaryRecords} AND ((i-1)%${ordinaryGroups})%2=1 THEN 'POST' ELSE 'GET' END,
      CASE WHEN i<=${ordinaryRecords} THEN '/高容量/'||lpad(((i-1)%${ordinaryGroups})::text,5,'0') ELSE '/winner' END||'?secret=never-return',
      CASE WHEN i%10=0 THEN 503 ELSE 200 END,CASE WHEN i%20=0 THEN NULL WHEN i%20=1 THEN -1 ELSE i%71 END
    FROM generate_series(1,${total}) i`,
    [main.tenant, main.consumer],
  );
  const before = await state(main);
  assert(
    BigInt(before.counts) < 100000n,
    'The workload must start with a real backlog',
  );
  const pending = await stats(0, main);
  assert.equal(pending.status, 503);
  assert(
    !('requests' in pending.body),
    'Oversized pending work cannot publish partial counts',
  );
  await db.query(
    `INSERT INTO ${small.schema}.request_logs(id,"consumerId",timestamp,method,path,"responseTimeMs")
    SELECT gen_random_uuid(),$1,statement_timestamp()-INTERVAL '30 minutes','GET','/small',3 FROM generate_series(1,1001)`,
    [small.consumer],
  );
  const smallStarted = performance.now();
  let lastSmallReport = 0;
  await wait(
    async () => {
      const current = await state(small);
      if (performance.now() - lastSmallReport >= 5000) {
        lastSmallReport = performance.now();
        console.log('Small workspace progress:', JSON.stringify(current));
      }
      return current.complete;
    },
    'Small workspace progresses during the large backlog',
    20000,
  );
  const fairnessMs = performance.now() - smallStarted;
  assert(BigInt((await state(main)).counts) < BigInt(total));
  assert.equal((await stats(1, small)).body.requests, 1001);
  const replays = [
    new pg.Client({
      connectionString: databaseUrl,
      options: '-c statement_timeout=15000 -c lock_timeout=3000',
    }),
    new pg.Client({
      connectionString: databaseUrl,
      options: '-c statement_timeout=15000 -c lock_timeout=3000',
    }),
  ];
  let replayFailure;
  const replayCleanupFailures = [];
  try {
    for (const client of replays) {
      client.on('error', (error) => {
        replayFailure ??= error;
      });
      await client.connect();
    }
    const outcomes = await Promise.allSettled(
      replays.map((client, index) =>
        client.query(
          `
      INSERT INTO ${main.schema}.request_logs(id,"consumerId",timestamp,method,path)
      SELECT md5($1::text||':'||i)::uuid,$2,statement_timestamp(),'GET','/replay-never-return'
      FROM generate_series($3::integer,$3::integer+999) i ON CONFLICT(id) DO NOTHING`,
          [main.tenant, main.consumer, index * 1000 + 1],
        ),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') throw outcome.reason;
      assert.equal(outcome.value.rowCount, 0);
    }
  } catch (error) {
    replayFailure ??= error;
  } finally {
    const closed = await Promise.allSettled(
      replays.map((client) => client.end()),
    );
    for (const result of closed)
      if (result.status === 'rejected')
        replayCleanupFailures.push(result.reason);
  }
  if (replayFailure || replayCleanupFailures.length)
    throw new AggregateError(
      [...(replayFailure ? [replayFailure] : []), ...replayCleanupFailures],
      'Concurrent replay or connection cleanup failed',
    );
  await wait(
    async () => BigInt((await state(main)).counts) >= 20000n,
    'Actual timer progress before restart',
    20000,
  );
  const beforeRestart = await state(main);
  assert(BigInt(beforeRestart.counts) < BigInt(total));
  const restart = await restartReplica(0);
  let lastReport = 0;
  await wait(
    async () => {
      const current = await state(main);
      if (performance.now() - lastReport > 10000) {
        lastReport = performance.now();
        console.log(
          'Replica workload progress:',
          JSON.stringify({
            elapsedMs: performance.now() - started,
            ...current,
          }),
        );
      }
      return (
        current.complete &&
        current.counts === String(total) &&
        current.paths === String(total)
      );
    },
    'Both replicas finish exactly once after restart',
    180000 - (performance.now() - started),
  );
  const materializationMs = performance.now() - started;
  const complete = await state(main);
  assert.equal(complete.path_cells, 20000);
  assert.equal(complete.count_cells, 6);
  assert.deepEqual(
    (
      await db.query(`SELECT COUNT(*)::integer AS records,
    COUNT(*) FILTER(WHERE "usageRollupVersion" IS NULL OR "pathRollupVersion" IS NULL)::integer AS pending,
    COUNT(*) FILTER(WHERE path='/replay-never-return')::integer AS replayed FROM ${main.schema}.request_logs`)
    ).rows[0],
    { records: total, pending: 0, replayed: 0 },
  );
  const baseline = [];
  for (let replica = 0; replica < 2; replica++) {
    const result = await stats(replica, main);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    verify(result.body);
    assert.equal(result.body.rollup.pathAggregation.rollupCells, 20000);
    baseline.push(result.elapsedMs);
  }
  const pressured = await Promise.all(
    Array.from({ length: 8 }, (_, i) => stats(i % 2, main)),
  );
  const accepted = pressured.filter((result) => result.status === 200);
  const rejected = pressured.filter((result) => result.status === 503);
  assert.equal(accepted.length, 4, 'Two admitted reads per tenant per replica');
  assert.equal(rejected.length, 4);
  for (const result of accepted) verify(result.body);
  for (const result of rejected) {
    assert.match(result.body.message, /busy|too many|retry/i);
    assert(!('requests' in result.body));
  }
  const recovered = await stats(0, main);
  assert.equal(recovered.status, 200);
  verify(recovered.body);
  const isolated = await request(1, statsPath(main), {
    headers: small.headers,
  });
  assert.equal(isolated.status, 403);

  // One old-receipt observation creates the 20,001st path cell. A shorter
  // window remains readable; real receipt-retention then frees that query space.
  await db.query(
    `INSERT INTO ${main.schema}.request_logs(id,"consumerId",timestamp,"receivedAt",method,path,"responseTimeMs")
    VALUES(gen_random_uuid(),$1,date_trunc('minute',statement_timestamp())-INTERVAL '30 minutes',statement_timestamp()-INTERVAL '2 days','GET','/overflow?secret=never-return',9)`,
    [main.consumer],
  );
  const excess = await stats(0, main);
  assert.equal(excess.status, 503);
  assert.match(excess.body.message, /path or boundary limit/);
  assert(!('requests' in excess.body));
  const short = await stats(1, main, '1h');
  assert.equal(short.status, 200);
  assert.equal(short.body.requests, 1);
  const retentionPath = `/tenants/${main.tenant}/log-retention`;
  let retention = await (
    await request(0, retentionPath, { headers: main.headers })
  ).json();
  for (const days of [1, 90]) {
    const saved = await request(0, retentionPath, {
      method: 'PUT',
      headers: main.headers,
      body: JSON.stringify({ days, expectedRevision: retention.revision }),
    });
    assert.equal(saved.status, 200);
    retention = await saved.json();
    const visible = await stats(1, main);
    assert.equal(visible.status, 200);
    verify(visible.body);
  }
  await wait(
    async () => (await state(main)).path_cells === 20000,
    'Automatic receipt cleanup frees the excess cell',
    20000,
  );
  const privacyPath = `/tenants/${main.tenant}/log-privacy`;
  let privacy = await (
    await request(0, privacyPath, { headers: main.headers })
  ).json();
  const savePrivacy = (replica, fields) =>
    request(replica, privacyPath, {
      method: 'PUT',
      headers: main.headers,
      body: JSON.stringify({
        expectedRevision: privacy.revision,
        policy: { clientIp: 'omit', userAgent: 'omit', redactedFields: fields },
      }),
    });
  const cleanupStarted = performance.now();
  const omitted = await savePrivacy(0, ['path']);
  assert.equal(omitted.status, 200);
  privacy = await omitted.json();
  const privateRead = await stats(1, main);
  assert.equal(privateRead.status, 200);
  verify(privateRead.body, true);
  assert.equal(
    (await savePrivacy(1, [])).status,
    409,
    'Restore waits for historical erasure',
  );
  let lastPrivacyReport = 0;
  await wait(
    async () => {
      const response = await request(1, privacyPath, { headers: main.headers });
      assert.equal(response.status, 200);
      privacy = await response.json();
      if (performance.now() - lastPrivacyReport >= 10000) {
        lastPrivacyReport = performance.now();
        console.log(
          'Replica privacy cleanup:',
          JSON.stringify({
            elapsedMs: performance.now() - cleanupStarted,
            state: privacy.historicalCleanup,
          }),
        );
      }
      return privacy.historicalCleanup === 'complete';
    },
    'Automatic replica privacy cleanup of the complete source and path stores',
    180000,
  );
  const privacyCleanupMs = performance.now() - cleanupStarted;
  assert.deepEqual(
    (
      await db.query(
        `SELECT COUNT(*)::integer AS private_cells FROM ${main.schema}.consumer_path_rollups WHERE path<>'[redacted]'`,
      )
    ).rows[0],
    { private_cells: 0 },
  );
  assert.deepEqual(
    (
      await db.query(
        `SELECT COUNT(*)::integer AS private_records FROM ${main.schema}.request_logs WHERE path<>'[redacted]'`,
      )
    ).rows[0],
    { private_records: 0 },
  );
  const restored = await savePrivacy(1, []);
  assert.equal(restored.status, 200);
  for (let replica = 0; replica < 2; replica++) {
    const result = await stats(replica, main);
    assert.equal(result.status, 200);
    verify(result.body, true);
  }
  assert.equal((await state(main)).counts, String(total + 1));
  assert.equal((await state(main)).paths, String(total + 1));
  return {
    workload: 'disposable-persisted-log-bulk-import',
    replicas: 2,
    persistedRecords: total,
    pathCellsAtQueryLimit: 20000,
    normalizedGroups: groups.size,
    automaticMaterializationMs: materializationMs,
    authenticatedQueryMs: baseline,
    smallWorkspaceProgressMs: fairnessMs,
    replayedSourceIds: 2000,
    restart,
    concurrentReads: {
      accepted: accepted.length,
      rejected: rejected.length,
      maxAcceptedMs: Math.max(...accepted.map((result) => result.elapsedMs)),
      recovered: true,
    },
    excessCellRefusedWithoutPartialCounts: true,
    shorterWindowRecovery: true,
    receiptRetentionRecovery: true,
    immediatePrivacyProjection: true,
    automaticPrivacyCleanupMs: privacyCleanupMs,
    historicalRestoreDoesNotResurrect: true,
    exactReferenceCountsAndTopPaths: true,
    manualWorkerTicks: 0,
  };
}
