import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';

/** Fixture-only keys; no provider receives any request from draft configuration. */
export function exportDestinationFixture() {
  const activeKey = 'container-fixture';
  const key = randomBytes(32);
  const signingSecret = 'runtime-receipt-signing-secret-more-than-32-bytes';
  const received = [],
    errors = [];
  return {
    environment: [
      `LOG_EXPORT_DESTINATION_KEYS=${JSON.stringify({ [activeKey]: key.toString('base64') })}`,
      `LOG_EXPORT_DESTINATION_ACTIVE_KEY=${activeKey}`,
    ],
    handleRequest(request, response) {
      if (request.url !== '/export-receipts') return false;
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks),
            id = request.headers['x-novagate-delivery-id'];
          const timestamp = request.headers['x-novagate-timestamp'];
          assert.equal(request.method, 'POST');
          assert.ok(body.length <= 1024 * 1024);
          assert.equal(
            request.headers['x-novagate-signature'],
            `v1=${createHmac('sha256', signingSecret).update(`${timestamp}.${id}.`).update(body).digest('hex')}`,
          );
          assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30);
          const status = received.length ? 202 : 503;
          received.push({ id, body: body.toString('utf8'), status });
          response.writeHead(status);
          response.end('Controlled receipt receiver');
        } catch (error) {
          errors.push(error);
          response.writeHead(400);
          response.end('Fixture rejected payload');
        }
      });
      return true;
    },
    async verifyAutomatic({ adminUrl, tenant, headers, db, origin }) {
      const destination = randomUUID(),
        record = randomUUID();
      const schema = `tenant_${tenant.replaceAll('-', '_')}`;
      // Only the local receiver credentials use fixture-only SQL, scoped by the
      // operator trusted-origin setting. Activation uses the authenticated API,
      // and the source gets a fresh database receipt after that explicit save.
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(
        Buffer.from(
          JSON.stringify([
            'novagate-log-export-destination',
            1,
            schema,
            destination,
            'webhook',
            activeKey,
          ]),
        ),
      );
      const ciphertext = Buffer.concat([
        cipher.update(
          JSON.stringify({
            type: 'webhook',
            url: `${origin}/export-receipts`,
            signingSecret,
          }),
        ),
        cipher.final(),
      ]);
      const encrypted = {
        version: 1,
        keyId: activeKey,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
      let revision = randomUUID();
      const privacy = { clientIp: 'omit', userAgent: 'omit' };
      const deliveryUrl = `${adminUrl}/tenants/${tenant}/log-export-destinations/${destination}/delivery`;
      async function control(method = 'GET', body, suffix = '') {
        const response = await fetch(`${deliveryUrl}${suffix}`, {
          method,
          headers: { ...headers, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        assert.doesNotMatch(
          JSON.stringify(result),
          /ciphertext|signingSecret|source_ids|"payload":|private-fixture-agent|203\.0\.113/,
        );
        return result;
      }
      await db.query(
        `INSERT INTO public.log_export_destinations (id,tenant_id,name,type,revision,credentials,destination)
        VALUES ($1,$2,'Authenticated receipt runtime fixture','webhook',$3,$4::jsonb,$5)`,
        [destination, tenant, revision, JSON.stringify(encrypted), origin],
      );
      const draft = await control();
      assert.equal(draft.available, true);
      assert.equal(draft.schedule, null);
      // The configuration contains payloadPrivacy; the network-safe state above
      // excludes actual serialized payload bytes and credentials.
      const enabledResponse = await fetch(deliveryUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          cadence: 'near_real_time',
          filter: {},
          payloadPrivacy: privacy,
          expectedRevision: null,
          expectedDestinationRevision: revision,
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(enabledResponse.status, 200);
      let configured = await enabledResponse.json();
      revision = configured.destinationRevision;
      assert.equal(configured.cursor, configured.startedAt);
      assert.equal(configured.admittedRecords, 0);
      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO ${schema}.request_logs
          (id,method,path,"statusCode","responseTimeMs","requestId","clientIp","userAgent",timestamp,"receivedAt")
          VALUES ($1,'GET','/receipt-runtime',200,1,$2,'203.0.113.15','private-fixture-agent','2001-01-01T00:00:00Z',clock_timestamp())`,
          [record, randomUUID()],
        );
        // Reproduce the old admission stop at the real retained-history boundary.
        // These are explicitly synthetic terminal metadata, never fabricated payloads.
        const markerAvailable = (
          await db.query(
            "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='log_export_deliveries' AND column_name='is_scheduled') AS available",
          )
        ).rows[0].available;
        const callerPredicate = markerAvailable
          ? 'NOT is_scheduled'
          : 'schedule_id IS NULL';
        const existingManual = Number(
          (
            await db.query(
              `SELECT COUNT(*) AS count FROM public.log_export_deliveries WHERE tenant_id=$1 AND ${callerPredicate}`,
              [tenant],
            )
          ).rows[0].count,
        );
        for (const [scheduled, count] of [
          [false, 1000 - existingManual],
          [true, 1000],
        ]) {
          await db.query(
            `INSERT INTO public.log_export_deliveries
            (id,tenant_id,destination_id,destination_revision,privacy_revision,retention_revision,source_ids,payload_privacy,receipt_from,
             record_count,status,attempts,expires_at,created_at,completed_at,schedule_id${markerAvailable ? ',is_scheduled' : ''})
            SELECT gen_random_uuid(),t.id,d.id,d.revision,t."logPrivacyRevision",t."logRetentionRevision",$3::uuid[],$4::jsonb,
              clock_timestamp()-INTERVAL '3 minutes',1,'delivered',1,clock_timestamp()+INTERVAL '1 hour',
              clock_timestamp()-INTERVAL '1 hour',clock_timestamp()-INTERVAL '1 hour',CASE WHEN $5 THEN d.id ELSE NULL END${markerAvailable ? ',$5' : ''}
            FROM public.tenants t JOIN public.log_export_destinations d ON d.tenant_id=t.id
            CROSS JOIN generate_series(1,$6::integer) n WHERE t.id=$1 AND d.id=$2`,
            [
              tenant,
              destination,
              [record],
              JSON.stringify(privacy),
              scheduled,
              count,
            ],
          );
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      const deadline = Date.now() + 100000;
      const failures = [];
      let evidence;
      async function until(check, label) {
        while (Date.now() < deadline) {
          if (errors.length)
            throw new AggregateError(
              errors,
              'Receipt receiver rejected payload',
            );
          if (await check()) return;
          await new Promise((done) => setTimeout(done, 100));
        }
        const row = (
          await db.query(
            'SELECT error FROM public.log_export_delivery_schedules WHERE destination_id=$1',
            [destination],
          )
        ).rows[0];
        throw new Error(
          `Packaged receipt scheduling timed out: ${label}; producer=${row?.error ?? 'none'}`,
        );
      }
      try {
        await until(() => received.length === 1, 'first automatic attempt');
        // A retry must retain its admitted bytes even after its source changes.
        await db.query(
          `UPDATE ${schema}.request_logs SET path='/changed-after-admission' WHERE id=$1`,
          [record],
        );
        let completed;
        await until(async () => {
          completed = (
            await db.query(
              'SELECT id,status,attempts,payload,source_ids,record_count FROM public.log_export_deliveries WHERE destination_id=$1 AND id=$2',
              [destination, received[0].id],
            )
          ).rows[0];
          return completed?.status === 'delivered';
        }, 'durable acknowledgement');
        assert.equal(received.length, 2);
        assert.equal(received[0].id, received[1].id);
        assert.equal(received[0].body, received[1].body);
        assert.equal(received[0].status, 503);
        assert.equal(received[1].status, 202);
        assert.equal(completed.id, received[0].id);
        assert.equal(completed.attempts, 2);
        assert.equal(completed.record_count, 1);
        assert.equal(completed.payload, null);
        assert.deepEqual(completed.source_ids, [record]);
        const rows = received[0].body
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, record);
        assert.equal(rows[0].path, '/receipt-runtime');
        assert.equal(rows[0].timestamp, '2001-01-01T00:00:00.000000Z');
        assert.equal(rows[0].clientIp, '[redacted]');
        assert.equal(rows[0].userAgent, undefined);
        assert.equal(rows[0].receivedAt, undefined);
        const schedule = (
          await db.query(
            'SELECT admitted_records,cursor_at FROM public.log_export_delivery_schedules WHERE destination_id=$1',
            [destination],
          )
        ).rows[0];
        assert.equal(Number(schedule.admitted_records), 1);
        const retained = (
          await db.query(
            `SELECT COUNT(*) FILTER (WHERE NOT is_scheduled)::integer AS manual,
          COUNT(*) FILTER (WHERE is_scheduled AND status IN ('delivered','failed','expired'))::integer AS scheduled
          FROM public.log_export_deliveries WHERE tenant_id=$1`,
            [tenant],
          )
        ).rows[0];
        assert.equal(retained.manual, 1000);
        assert.equal(retained.scheduled, 1000);
        const pruned = (
          await db.query(
            'SELECT delivered_batches::text,delivered_records::text FROM public.log_export_delivery_history_totals WHERE tenant_id=$1',
            [tenant],
          )
        ).rows[0];
        assert.equal(pruned.delivered_batches, '1');
        assert.equal(pruned.delivered_records, '1');
        const history = await control('GET', undefined, '/history');
        assert.equal(history.coverage.readLimit, 50);
        assert.equal(history.deliveries.length, 50);
        assert.deepEqual(history.coverage.prunedScheduledBatches, {
          delivered: '1',
          failed: '0',
          expired: '0',
        });
        const acknowledged = history.deliveries.find(
          (row) => row.id === completed.id,
        );
        assert.ok(acknowledged);
        assert.equal(acknowledged.source, 'scheduled');
        assert.equal(acknowledged.status, 'delivered');
        assert.equal(acknowledged.attempts, 2);
        assert.equal(acknowledged.recordCount, 1);
        assert.ok(
          Object.keys(acknowledged).every((field) =>
            [
              'id',
              'destinationId',
              'source',
              'status',
              'attempts',
              'recordCount',
              'createdAt',
              'completedAt',
              'expiresAt',
              'nextAttemptAt',
            ].includes(field),
          ),
        );
        const activeState = await control();
        assert.equal(activeState.pendingBatches, 0);
        configured = await control('PUT', {
          enabled: false,
          cadence: configured.cadence,
          filter: configured.filter,
          payloadPrivacy: privacy,
          expectedRevision: configured.revision,
          expectedDestinationRevision: revision,
        });
        assert.equal(configured.enabled, false);
        const pausedCursor = configured.cursor;
        assert.deepEqual(
          await control('DELETE', {
            expectedRevision: configured.revision,
            expectedDestinationRevision: revision,
          }),
          { removed: true },
        );
        assert.equal((await control()).schedule, null);
        assert.equal(
          (await control('GET', undefined, '/history')).deliveries.length,
          50,
        );
        assert.ok(pausedCursor);
        evidence = {
          packagedAutomaticScheduling: true,
          trustedReceiptSource: true,
          lateRequestTimestamp: true,
          signedPrivateNdjson: true,
          stableRetryIdentityAndBytes: true,
          terminalPayloadErasure: true,
          attempts: completed.attempts,
          records: completed.record_count,
          fullCallerHistoryDoesNotStopScheduling: true,
          scheduledHistoryRollsWithCoverage: true,
          authenticatedActivation: true,
          authenticatedHistory: true,
          pauseAndRemovalRetainHistory: true,
          sourceReceiptAfterExplicitSave: true,
        };
      } catch (error) {
        failures.push(error);
      } finally {
        const cleanup = await Promise.allSettled([
          (async () => {
            const response = await fetch(
              `${adminUrl}/tenants/${tenant}/log-export-destinations/${destination}`,
              {
                method: 'DELETE',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedRevision: revision }),
                signal: AbortSignal.timeout(5000),
              },
            );
            assert.equal(response.status, 204);
          })(),
          db.query(`DELETE FROM ${schema}.request_logs WHERE id=$1`, [record]),
        ]);
        failures.push(
          ...cleanup.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          ),
        );
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(
          failures,
          'Packaged receipt fixture cleanup failed',
        );
      return evidence;
    },
    async verify({ adminUrl, tenant, headers, db }) {
      const base = `${adminUrl}/tenants/${tenant}/log-export-destinations`;
      assert.equal((await fetch(base)).status, 401);
      const created = [];
      for (const credentials of [
        {
          type: 'webhook',
          url: 'https://logs.example.com/private-path?token=private-query',
          signingSecret: 'private-signing-secret-of-at-least-32-bytes',
        },
        {
          type: 's3',
          endpoint: 'https://s3.example.com',
          bucket: 'runtime-logs',
          region: 'us-east-1',
          accessKeyId: 'private-access',
          secretAccessKey: 'private-secret',
          sessionToken: 'private-session',
          forcePathStyle: true,
        },
        { type: 'datadog', site: 'datadoghq.eu', apiKey: 'b'.repeat(32) },
      ]) {
        const response = await fetch(base, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `Runtime ${credentials.type}`,
            credentials,
          }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        assert.equal(result.state, 'draft');
        assert.equal(result.credentialStatus, 'available');
        assert.doesNotMatch(
          JSON.stringify(result),
          /private-path|private-query|private-signing|private-access|private-secret|private-session|bbbbbbbb|ciphertext/,
        );
        const stored = await db.query(
          'SELECT credentials FROM public.log_export_destinations WHERE tenant_id=$1 AND id=$2',
          [tenant, result.id],
        );
        assert.equal(stored.rows[0].credentials.keyId, activeKey);
        assert.doesNotMatch(
          JSON.stringify(stored.rows),
          /private-path|private-query|private-signing|private-access|private-secret|private-session|bbbbbbbb/,
        );
        created.push(result);
      }
      const response = await fetch(base, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const state = await response.json();
      assert.equal(response.status, 200);
      assert.equal(state.configurationAvailable, true);
      assert.equal(state.deliveryAvailable, true);
      assert.equal(state.destinations.length, 3);
      assert.equal(
        (
          await fetch(
            `${adminUrl}/tenants/${randomUUID()}/log-export-destinations`,
            { headers, signal: AbortSignal.timeout(5000) },
          )
        ).status,
        403,
      );
      const first = created[0];
      // Synthetic fixture-only rows verify packaged migration/write hooks.
      // This does not substitute for trusted source-record admission.
      async function pendingDelivery(revision, processing = false) {
        const id = randomUUID(),
          record = randomUUID();
        const privacy = { clientIp: 'omit', userAgent: 'omit' };
        const payload = {
          version: 1,
          tenantId: tenant,
          destinationId: first.id,
          deliveryId: id,
          privacy,
          payloadPrivacy: privacy,
          records: [
            {
              id: record,
              method: 'GET',
              path: '/synthetic-fixture',
              statusCode: 200,
              responseTimeMs: 1,
              requestId: randomUUID(),
              clientIp: '[redacted]',
              timestamp: new Date().toISOString(),
            },
          ],
        };
        await db.query(
          `INSERT INTO public.log_export_deliveries
          (id,tenant_id,destination_id,destination_revision,privacy_revision,retention_revision,
           source_ids,payload_privacy,receipt_from,payload,record_count,expires_at,status,lease_id,lease_until)
          SELECT $1,id,$2,$3,"logPrivacyRevision","logRetentionRevision",$4::uuid[],$5::jsonb,
            clock_timestamp(),$6::jsonb,1,clock_timestamp()+INTERVAL '1 hour',$7::varchar,$8,
            CASE WHEN $7::varchar='processing' THEN clock_timestamp()+INTERVAL '30 seconds' ELSE NULL END
          FROM public.tenants WHERE id=$9`,
          [
            id,
            first.id,
            revision,
            [record],
            JSON.stringify(privacy),
            JSON.stringify(payload),
            processing ? 'processing' : 'queued',
            processing ? randomUUID() : null,
            tenant,
          ],
        );
        return id;
      }
      async function deliveryRow(id) {
        return (
          await db.query(
            'SELECT status,payload,lease_id FROM public.log_export_deliveries WHERE id=$1 AND tenant_id=$2',
            [id, tenant],
          )
        ).rows[0];
      }
      const queued = await pendingDelivery(first.revision);
      const rotated = await fetch(`${base}/${first.id}/rotate-key`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: first.revision }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(rotated.status, 200);
      const next = await rotated.json();
      assert.notEqual(next.revision, first.revision);
      assert.deepEqual(await deliveryRow(queued), {
        status: 'expired',
        payload: null,
        lease_id: null,
      });
      const processing = await pendingDelivery(next.revision, true);
      const stale = await fetch(`${base}/${first.id}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: first.revision }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(stale.status, 409);
      const beforeRemoval = await deliveryRow(processing);
      assert.equal(beforeRemoval.status, 'processing');
      assert.ok(beforeRemoval.payload);
      assert.ok(beforeRemoval.lease_id);
      const removed = await fetch(`${base}/${first.id}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: next.revision }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(removed.status, 204);
      assert.deepEqual(await deliveryRow(processing), {
        status: 'expired',
        payload: null,
        lease_id: null,
      });
      const stored = await db.query(
        'SELECT credentials,deleted_at FROM public.log_export_destinations WHERE tenant_id=$1 AND id=$2',
        [tenant, first.id],
      );
      assert.equal(stored.rows[0].credentials, null);
      assert.ok(stored.rows[0].deleted_at);
      return {
        providers: ['webhook', 's3', 'datadog'],
        encrypted: true,
        displaySafeReads: true,
        tenantIsolation: true,
        revisionConflict: true,
        keyRewrapped: true,
        removedCredentials: true,
        deliveryAvailable: true,
        outbox: {
          packagedMigration: true,
          queuedRotationRevocation: true,
          staleWritePreservesProcessingLease: true,
          processingRemovalRevocation: true,
        },
      };
    },
  };
}
