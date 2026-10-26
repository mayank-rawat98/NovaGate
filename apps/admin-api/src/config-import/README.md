# Declarative configuration

Settings → Configuration import & export manages the complete active service,
route and consumer configuration for an authenticated workspace. This is the
phase 5.1 implementation. The pending CLI will use the same preview/apply API.
Terraform, revision history, operator rollback,
scoped automation tokens and formal release acceptance remain separate work.

## Document

```yaml
version: 1
services:
  - name: users-api
    targets:
      - url: http://users-svc:8080
        weight: 100
    healthCheckPath: /health
routes:
  - method: GET
    pathPattern: /users
    serviceId: users-api
    authRequired: true
    plugins:
      - name: rate-limit
        config:
          windowMs: 60000
          max: 200
consumers:
  - name: mobile-app
    groups: [read-only]
```

All three arrays and `version: 1` are required. An empty array removes all active
entries of that kind. Missing services/routes are soft-deleted; missing consumers
are revoked. Services and consumers use unique names; routes use method plus path.
`serviceId` references a service **name** in this document. Existing matching IDs
and consumer keys survive updates. Renaming an identity creates a new entry and
removes the old one. Reintroducing a revoked consumer creates a fresh ID/key;
revoked keys are never revived.

The document permits at most 200 total entries and 65,536 UTF-8 bytes. Targets,
health checks, retries, GraphQL and the thirteen first-party plugins reuse the
existing gateway policy validators, with strict document types and field limits.
Duplicate identities/keys, foreign service references, unknown fields/plugins,
aliases, custom YAML tags, multiple documents, reserved prototype keys, excessive
nesting and unsafe integers are refused. Parser failures do not echo source.

A service's `circuitBreaker` is explicit in documents: the object
(`enabled`, `windowSize`, `failureRatePercent`, `minimumRequests`, `openMs`,
`halfOpenSuccesses`) or `null`. Omitting it means no breaker, so re-importing an
export made before circuit breakers existed never changes traffic. Services
created through the API or dashboard get the default breaker instead.

Route array order is persisted as `configOrder`; plugin array order is preserved.
Ordinary CRUD routes without an imported order sort after ordered routes, then by
creation time and ID. Migration/provisioning own the new nullable column. The
control-plane initial snapshot also honors that order while tolerating legacy
schemas without order or creation-time columns.

## Authenticated API

The deployed prefix is `/api`:

- `GET /api/tenants/:tenantId/export` downloads `novagate-config.yaml`.
- `POST /api/tenants/:tenantId/import?dryRun=true` previews a YAML or JSON body.
  Omitting `dryRun` also previews. Send `application/yaml`, `text/yaml`,
  `application/json` or `text/plain`; send the document itself, without a wrapper.
- `POST /api/tenants/:tenantId/import?dryRun=false` applies the identical reviewed
  document with `If-Match: "<preview.revision>"`.

All calls require the existing tenant session and enforce workspace scope. Import
uses a bounded text parser before the ordinary JSON parser so duplicate JSON keys
remain detectable. Responses, downloads and authentication/parser errors use
`Cache-Control: no-store`.

Preview returns change identities, actions and changed **field names**, unchanged
count, current config version, warnings and a ten-minute revision. It writes
nothing. Its keyed signature binds the workspace, complete private current
snapshot, desired normalized document and expiry. It contains no exposed hashes
or credential values. Document edits, CRUD drift, private credential/key changes,
cross-workspace use and expiry require a new preview.

Apply locks the workspace parent and configuration tables before rereading and
checking the revision. This also fences ordinary CRUD inserts/updates that do not
take the parent lock. IDs, rows, soft deletions/revocations, configuration version
and durable outbox persist in one transaction. SQL/outbox failures roll back all
of them. Two replicas applying the same changed preview yield one success and one
conflict. An unchanged import does not increment a version, enqueue or publish.

`delivery: queued` means the transaction committed and gateway delivery is queued;
it does not claim a gateway ACK. Publication and reconnect/retry use the existing
durable delivery path. Newly created consumer keys appear only in the successful
apply response; only SHA-256 hashes persist. If the response is interrupted, check
the saved configuration and use consumer controls to replace any lost key. A
browser timeout/cancellation does not guarantee an admitted server transaction
was rolled back.

## Credential handling and refusals

Exports omit consumer hashes/keys, OAuth client secrets, HMAC secrets, Basic
credentials and added request/response headers/query parameters. An omitted
private plugin field is preserved only for the matching existing method/path and
plugin name. Explicit replacements are validated. A new authentication plugin
requires credentials, including when moving a redacted export to another
workspace. Existing private values stay in the gateway configuration/outbox;
they never appear in the preview diff.

Export refuses HTTP(S) URLs containing user information, query strings or
fragments rather than silently exporting opaque URL credentials. It also refuses
a document that exceeds the import byte/complexity limits. Use individual controls
to repair or reduce those configurations; no partial configuration is downloaded.
Ambiguous existing names, unsupported existing policies, missing referenced
services and more than 200 active entries similarly return an actionable 409.

Eight operations per process and two per workspace are admitted. Statements have
a three-second budget and lock waits one second; contention returns 503 without
committing import changes. Shutdown rejects new operations and drains the actual
admitted database work. Preview/export use repeatable-read snapshots.

## Settings and verification

The file picker/editor keeps documents in component memory. Editing invalidates
the preview; every apply requires explicit review acknowledgement. Conflicts
retain the document and require another preview. Queued delivery and one-time keys
are labelled explicitly. Closing or changing workspaces cancels browser reads,
clears document/key state and preserves native Escape, focus and Tab containment.

The HTTP/PostgreSQL integration suite checks real reconciliation, outbox rollback,
replica races, stable identity and order, credential preservation, authentication,
parser limits, drift, admission and shutdown. The production browser verifier
checks downloads, failure/retry, reviewed changes, conflict recovery, one-time keys,
file input, mobile accessibility and interrupted requests. The packaged three-app
runtime verifies actual gateway ACK/key routing, restart and idempotent export
roundtrip while retaining telemetry, archive, alert, privacy and rollup gates.

The [gwx CLI](../../../../tools/gwx/README.md) uses this same preview/revision/apply
contract for local files and supports all 400 actions in a maximum-size replacement.
