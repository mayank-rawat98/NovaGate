import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Disposable PostgreSQL bulk import, production provisioning/REST and actual timers.
// This verifies persisted observations; it is not a live-traffic throughput benchmark.
export async function verifyConsumerRollupReader({ adminUrl, db }) {
  const tenant = randomUUID();
  const schema = `tenant_${tenant.replaceAll('-', '_')}`;
  const verification = randomUUID();
  const started = performance.now();
  const deadline = AbortSignal.timeout(180000);
  const request = async (path, options = {}) => {
    deadline.throwIfAborted();
    return fetch(`${adminUrl}${path}`, {
      ...options,
      signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
  };
  const wait = async (check, label, budget = 150000) => {
    const until = performance.now() + budget;
    while (performance.now() < until) {
      deadline.throwIfAborted();
      if (await check()) return;
      await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error(`Timed out: ${label}`);
  };
  // Seed only a disposable signup token; the authenticated production flow owns
  // schema creation, rollup hooks and gateway-key provisioning. No email is sent.
  await db.query(
    `INSERT INTO public.tenants (id,name,email,"planId","verifyToken","verifyExpires")
     VALUES ($1,'Rollup runtime',$2,'free',$3,clock_timestamp()+INTERVAL '10 minutes')`,
    [tenant, `${tenant}@example.test`, verification],
  );
  const verified = await request('/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verification }),
  });
  assert.equal(verified.status, 200);
  const session = await verified.json();
  assert.equal(session.tenantId, tenant);
  const headers = {
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'application/json',
  };
  const created = await request(`/tenants/${tenant}/consumers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Rollup runtime consumer' }),
  });
  assert.equal(created.status, 201);
  const consumer = (await created.json()).id;
  assert.match(consumer, /^[a-f\d-]{36}$/);

  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL statement_timeout='15s'");
    await db.query(
      `INSERT INTO ${schema}.request_logs (id,"consumerId",timestamp,"statusCode","responseTimeMs",method,path)
       SELECT gen_random_uuid(),$1,date_trunc('minute',statement_timestamp())-INTERVAL '2 hours',
         CASE WHEN i%10=0 THEN 503 ELSE 200 END,
         CASE WHEN i%20=0 THEN NULL WHEN i%20=1 THEN -1 ELSE 3 END,
         'GET','/runtime-import?secret=never-return'
       FROM generate_series(1,200001) i`,
      [consumer],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  const statsPath = `/tenants/${tenant}/consumers/${consumer}/stats?period=24h`;
  const [initial] = (
    await db.query(
      `SELECT COUNT(*) FILTER (WHERE "usageRollupVersion" IS NULL)::integer AS pending FROM ${schema}.request_logs`,
    )
  ).rows;
  assert(
    initial.pending > 100000,
    'The actual worker must have a real backlog',
  );
  const incomplete = await request(statsPath, { headers });
  assert.equal(
    incomplete.status,
    503,
    'Oversized pending input cannot return partial totals',
  );
  assert.match(
    (await incomplete.json()).message,
    /shorter period|temporarily unavailable/,
  );

  let lastReported = 0;
  await wait(async () => {
    const [state] = (
      await db.query(
        `SELECT s.backfill_complete,s.processed_records::text AS processed,
          p.backfill_complete AS paths_complete,p.processed_records::text AS paths_processed,
          t."consumerRollupPending" AS pending,t."consumerRollupError" AS error,
          EXTRACT(EPOCH FROM clock_timestamp()-t."consumerRollupCheckedAt") AS checked_age_seconds
         FROM ${schema}.consumer_usage_rollup_state s CROSS JOIN ${schema}.consumer_path_rollup_state p CROSS JOIN public.tenants t WHERE t.id=$1`,
        [tenant],
      )
    ).rows;
    if (performance.now() - lastReported >= 10000) {
      lastReported = performance.now();
      console.log(
        'Consumer rollup timer progress:',
        JSON.stringify({
          elapsedMs: Math.round(performance.now() - started),
          ...state,
        }),
      );
    }
    return (
      state.backfill_complete &&
      state.processed === '200001' &&
      state.paths_complete &&
      state.paths_processed === '200001'
    );
  }, 'Automatic rollup worker completes the real 200,001-record backlog');
  const materializationMs = performance.now() - started;
  const queryStarted = performance.now();
  const response = await request(statsPath, { headers });
  const usage = await response.json();
  const queryMs = performance.now() - queryStarted;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(usage.source, 'consumer_rollups');
  assert.equal(usage.requests, 200001);
  assert.equal(usage.serverErrors, 20000);
  assert.equal(usage.latencySamples, 180000);
  assert.equal(usage.p95Ms, 4);
  assert.equal(usage.rollup.counts, 'complete_for_retained_records');
  assert.equal(usage.rollup.materialization, 'complete');
  assert.equal(usage.rollup.latencyMethod, 'histogram_bucket_upper_bound');
  assert.equal(usage.rollup.paths, 'complete_for_retained_records');
  assert.equal(usage.rollup.pathAggregation.groups, 1);
  assert.equal(usage.rollup.pathAggregation.pendingRecords, 0);
  assert.equal(usage.rollup.pathAggregation.materialization, 'complete');
  assert.equal(usage.rollup.pendingRecords, 0);
  assert.equal(usage.rollup.rawRecords, 0);
  assert.equal(usage.rollup.lateRecords, 200001);
  assert.equal(
    usage.series.reduce((sum, bucket) => sum + bucket.requests, 0),
    200001,
  );
  assert(
    Math.abs(
      usage.series.reduce((sum, bucket) => sum + bucket.observedSeconds, 0) -
        86400,
    ) < 0.00001,
  );
  assert.deepEqual(usage.topPaths, [
    {
      method: 'GET',
      path: '/runtime-import',
      requests: 200001,
      serverErrors: 20000,
      errorRate: 20000 / 200001,
      rps: 200001 / 86400,
      latencySamples: 180000,
      p50Ms: 4,
      p95Ms: 4,
      p99Ms: 4,
    },
  ]);
  const pathGroups = (
    await db.query(
      `SELECT path,SUM(requests)::text AS requests,SUM(server_errors)::text AS errors,SUM(latency_samples)::text AS samples FROM ${schema}.consumer_path_rollups GROUP BY path`,
    )
  ).rows;
  assert.deepEqual(pathGroups, [
    {
      path: '/runtime-import',
      requests: '200001',
      errors: '20000',
      samples: '180000',
    },
  ]);
  assert(
    !/never-return|usageRollupVersion|pathRollupVersion|histogram"|keyHash/.test(
      JSON.stringify(usage),
    ),
  );
  const metricsResponse = await request(
    `/tenants/${tenant}/metrics?period=24h&consumerId=${consumer}`,
    { headers },
  );
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  const active = metrics.find((bucket) => bucket.rps > 0);
  assert.equal(active.p95Ms, 4);
  assert.equal(
    active.consumerUsage.rollup.latencyMethod,
    'histogram_bucket_upper_bound',
  );
  assert.equal(active.consumerUsage.latencySamples, 180000);
  assert.equal(active.consumerUsage.observedSeconds, 900);
  assert.equal(
    active.consumerUsage.rollup.paths,
    'complete_for_retained_records',
  );
  assert.equal(active.consumerUsage.rollup.pathAggregation.groups, 1);
  assert.equal((await request(statsPath)).status, 401);

  const currentResponse = await request(`/tenants/${tenant}/log-privacy`, {
    headers,
  });
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  const saved = await request(`/tenants/${tenant}/log-privacy`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      expectedRevision: current.revision,
      policy: {
        clientIp: 'omit',
        userAgent: 'omit',
        redactedFields: ['consumerId'],
      },
    }),
  });
  assert.equal(saved.status, 200);
  const hiddenResponse = await request(statsPath, { headers });
  assert.equal(hiddenResponse.status, 200);
  const hidden = await hiddenResponse.json();
  assert.equal(hidden.requests, 0);
  assert.equal(hidden.p95Ms, null);
  assert.deepEqual(hidden.privacy.redactedFields, ['consumerId']);
  await wait(
    async () =>
      (
        await db.query(
          `SELECT c.cells+p.cells AS cells FROM ${schema}.consumer_usage_rollup_state c CROSS JOIN ${schema}.consumer_path_rollup_state p`,
        )
      ).rows[0].cells === 0,
    'Automatic privacy cleanup erases rollup identities',
    10000,
  );
  return {
    persistedRecords: usage.requests,
    serverErrors: usage.serverErrors,
    latencySamples: usage.latencySamples,
    p95UpperBoundMs: usage.p95Ms,
    cells: usage.rollup.rollupCells,
    automaticMaterializationMs: materializationMs,
    authenticatedQueryMs: queryMs,
    manualWorkerTicks: 0,
    oversizedPendingRejected: true,
    filteredMetricsPreserveEstimateMetadata: true,
    publicPaths: {
      requests: 200001,
      groups: 1,
      exactRetainedCounts: true,
      queryStringsExcluded: true,
      estimatedPercentiles: true,
      filteredMetricCoverage: true,
    },
    privacyImmediateSuppression: true,
    automaticPrivacyErasure: true,
    pathStorage: {
      requests: 200001,
      queryStringsExcluded: true,
      automaticMaterialization: true,
      privacyErasure: true,
    },
    workload: 'disposable-persisted-log-bulk-import',
  };
}
