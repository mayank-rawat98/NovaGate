# Authenticated request-log stream

`GET /api/tenants/:tenantId/logs/stream` serves request-log observations as SSE.
Use the existing tenant session JWT in `Authorization: Bearer ...`; a query token
is not accepted. Tenant access checks happen before admission/SQL. Tenant API
responses, including authentication failures, use `Cache-Control: no-store`.

## Protocol and coverage

A new stream starts with the newest **50 retained receipts**, returned in ascending
receipt/UUID order. It then reads up to 50 newer rows every two seconds. Receipt
order includes late request timestamps; this feed is not a historical archive,
billing ledger or proof of complete traffic coverage. An empty workspace emits
an empty initial `logs` batch with a resume cursor and waits for new receipts.

```text
id: v1.ENCRYPTED-CURSOR
event: logs
data: [{"id":"...","method":"GET","path":"/users","statusCode":200}]

: heartbeat

```

Reconnect with `Last-Event-ID`. The cursor includes the exact six-digit PostgreSQL
receipt timestamp and UUID tie breaker. AES-256-GCM encrypts/authenticates its
workspace, position and 24-hour expiry using a domain-separated key derived from
the platform JWT secret. It is not an authorization credential. Invalid, expired,
tampered and foreign-workspace cursors return 400. JWT-secret rotation invalidates
existing cursors. Restarting the service preserves cursors if the secret and
underlying receipt data remain available. Resume can replay a batch interrupted
while printing; consumers should deduplicate by public log `id`.

Only public request-log fields are projected. The feed excludes receipt timestamps,
consumer/path materialization markers, arbitrary future columns, API keys, hashes,
bodies and headers. Each read obtains the current privacy policy and retention
cutoff, then redacts those public fields. The receipt advisory fence coordinates
reads with ingestion and policy saves; bounded synchronous publication happens
before releasing that fence. Existing retention floors prevent old rows from
resurfacing after a longer retention setting is saved.

A resume position older than the current cutoff emits one `gap` event per
connection with `{"reason":"receipt_retention"}`, followed by retained rows only.
There is no catch-up of the expired part. Read failures send an `error` event with
fixed reason `read_failed` and end the stream. Oversized legacy fields/batches or
the output buffer limit send `output_limit` when the bounded buffer permits it,
then end. Responses never reflect SQL errors or private field values in errors.
Before stream headers, missing workspaces return 404 and bounded database failures
return 503.

## Resource and lifecycle bounds

- At most **16 connections per process**, **2 per workspace**, and **4 pending
  database reads per process**. Admission failures return 503.
- No overlapping reads on a connection; a saturated read pool produces heartbeats.
- Transactions use a **3-second statement timeout** and **1-second lock timeout**.
  At most 50 projected records, each at most 128 KiB of serialized SQL JSON, leave
  PostgreSQL. An oversized record produces a protocol error.
- Published frames are at most **128 KiB**; the application checks a **256 KiB**
  writable-buffer bound and closes on backpressure. It does not wait for a remote
  reader while holding a database transaction.
- Connections last at most **5 minutes** and close earlier at the authenticated
  session's expiry. A normal close permits a fresh authenticated reconnect.
- Disconnect clears polling/expiry timers and releases connection admission.
  Graceful close retains admission until the HTTP response closes; a stalled
  response is destroyed after one second. Shutdown refuses new connections and
  drains both actual responses and in-flight transactions, including blocked reads.

These limits apply per admin process, not across replicas. Replicas can decrypt
resume cursors using the same configured JWT secret. The consumer-facing CLI
checks headers/frame sizes, waits at most 20 seconds without a heartbeat and keeps
its completed cursor in memory only. See [gwx](../../../../tools/gwx/README.md).

## Verification

`log-stream.integration.spec.ts` provisions disposable databases with canonical
migrations and tenant schemas, starts actual Nest HTTP with the global auth guard,
and consumes real SSE sockets. It covers current policy saves, raw legacy records,
receipt/UUID ordering, late request timestamps, empty/live feeds, resume scope and
expiry, actual retention shrink/growth, admission recovery, session expiry,
blocked/read-failed PostgreSQL, delayed HTTP close, shutdown drain and oversized
output. Case teardown
retains ownership until work and connections drain; it does not increase test or
SQL deadlines to obtain a pass.
