import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

/** Fixture-only keys; no provider receives any request from draft configuration. */
export function exportDestinationFixture() {
  const activeKey = 'container-fixture';
  return {
    environment: [
      `LOG_EXPORT_DESTINATION_KEYS=${JSON.stringify({ [activeKey]: randomBytes(32).toString('base64') })}`,
      `LOG_EXPORT_DESTINATION_ACTIVE_KEY=${activeKey}`,
    ],
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
      assert.equal(state.deliveryAvailable, false);
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
      const rotated = await fetch(`${base}/${first.id}/rotate-key`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: first.revision }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(rotated.status, 200);
      const next = await rotated.json();
      assert.notEqual(next.revision, first.revision);
      const stale = await fetch(`${base}/${first.id}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: first.revision }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(stale.status, 409);
      const removed = await fetch(`${base}/${first.id}`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: next.revision }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(removed.status, 204);
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
        deliveryAvailable: false,
      };
    },
  };
}
