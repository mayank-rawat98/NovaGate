# Log export destinations

Private RustFS manual and scheduled archives and external provider delivery have
independent credentials and configuration. Saving an S3-compatible, NDJSON webhook
or Datadog connection creates an inactive **draft**. Settings → Delivery & history
requires an explicit revision-aware save to enable receipt scheduling. Destination
state is `draft`, `enabled` or `paused`; enabled is a configuration state, not proof
of provider health or indexing. `deliveryAvailable` reports installation capability.
Issue #95's local continuation supplies the bounded transports, durable worker,
receipt scheduler and authenticated controls below. Actual-provider acceptance and
formal release acceptance remain separate from controlled local checks.

## Settings editor

Settings → External export destinations exposes safe summaries and masked entry
for all three providers. A saved destination can be renamed without changing its
credentials, replaced using a complete connection of the same provider, re-encrypted
under the installation's current key or removed with confirmation. Revision reload
keeps unsaved input for review; failed writes do not discard it. Missing/retired keys
can be repaired with complete replacement. Disabled installation configuration
still allows metadata-only edits and removal. Close/workspace changes discard local
credential state and abort browser requests; an already admitted server transaction
may still commit, so cancellation is not a rollback guarantee. Credential saves
never enable a draft. Delivery controls select cadence, filters and a stricter
payload policy; history contains metadata and exact workspace compaction counts.

## Encryption configuration

Inject `LOG_EXPORT_DESTINATION_KEYS` as a JSON object mapping up to four key IDs
(1–32 ASCII letters, digits, underscore or hyphen) to canonical base64-encoded
32-byte random keys. Set `LOG_EXPORT_DESTINATION_ACTIVE_KEY` to one of those IDs.
Compose passes both values to admin-api. Omitted/empty pairs disable credential
creation/replacement/rotation; malformed or partial configuration fails startup.
Keys are independent of alert, JWT and platform archive credentials. No fallback
exists. Do not put real keys in source control or request/log output.

All connection details are encrypted using AES-256-GCM with a random 12-byte nonce
and 16-byte authentication tag. Associated data binds the envelope version,
namespace, canonical tenant UUID, destination UUID, provider type and key ID.
Cross-tenant, cross-destination, cross-provider and alert-envelope substitution
fails authentication. Public reads project only name/type/HTTPS origin or Datadog
site; URL paths, queries, keys, session tokens and envelopes are never returned.
`credentialStatus: available` means the stored credential can be decrypted and
parsed with retained keys; it does not mean the provider has accepted it.

## Tenant API

All routes require the existing signed tenant session; a session for another
workspace is rejected before reaching storage. Responses are `no-store`.

Base: `/api/tenants/:tenantId/log-export-destinations`

| Method | Suffix            | Input                                                              |
| ------ | ----------------- | ------------------------------------------------------------------ |
| GET    | (base)            | Lists at most ten saved destinations and installation availability |
| POST   | (base)            | `{ name, credentials }`                                            |
| PUT    | `/:id`            | `{ name, expectedRevision, credentials? }`                         |
| POST   | `/:id/rotate-key` | `{ expectedRevision }`                                             |
| DELETE | `/:id`            | `{ expectedRevision }`; returns 204                                |

Credentials use the shared `LogExportDestinationCredentials` discriminated union.
Replacement is complete and retains the provider type. Omit credentials for a
metadata-only update; a corrupt/missing-key draft can be renamed or removed even
if encryption is disabled. Stale revisions return 409. Destination IDs belonging
to a different tenant return 404. Removal clears the live encrypted credential
field and retains a nonsecret identity tombstone for future delivery history.
Backup/WAL retention and restore behavior remain operational recovery work.

### Delivery controls

These routes share the same tenant session boundary and `no-store` responses.
No public route accepts arbitrary records, source IDs, raw payloads or a receipt
cursor. Credentials remain write-only through the destination editor.

| Method | Suffix                  | Input or result                                                                                                    |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/:id/delivery`         | Schedule, revisions, credential availability, effective workspace privacy/receipt floor, pending counts and limits |
| PUT    | `/:id/delivery`         | `{ enabled, cadence, filter, payloadPrivacy, expectedRevision, expectedDestinationRevision }`                      |
| DELETE | `/:id/delivery`         | `{ expectedRevision, expectedDestinationRevision }`; returns `{ removed: true }`                                   |
| GET    | `/:id/delivery/history` | At most 50 metadata rows and cumulative workspace compaction coverage                                              |

On first save, `expectedRevision` is null; later saves and removal require the
current schedule UUID. Every write also requires the destination revision. Unknown
fields and unsupported values return 400; stale revisions return 409. Enabling
requires decryptable credentials and filters supported by workspace privacy.
Pausing or removing a schedule remains possible when its encryption key is absent,
or a preserved filter references metadata now omitted by the workspace.

The first schedule starts at database save time and never backfills older receipts.
Resume retains the cursor and catches up with retained receipts. Pause stops new
admission; already queued work can finish. Changing payload policy or destination
metadata/credentials revokes waiting bytes through destination revision fencing.
Removing automatic delivery expires only its scheduled queued/processing batches,
erases payloads and revokes leases; it preserves selected-record caller batches and
terminal history. Recreating starts at the new save time. Destination removal
revokes all its waiting deliveries, clears encrypted credentials and keeps a
tombstone; owned history remains readable by ID while delivery settings return 404.
External copies already acknowledged cannot be recalled.

History excludes credentials, payloads, source IDs, lease IDs and provider bodies.
`delivered` means provider HTTP acknowledgement. Scheduled terminal metadata targets
1,000 rows per workspace and ages out by seven elapsed days; compaction can remove
it sooner. Exact decimal-string counters report removed batch outcomes and record
occurrences across the workspace. One source exported to multiple destinations
counts multiple times. These counters do not promise complete delivery history or
unique source coverage. A removed schedule retains this history and source marker.

S3 drafts accept an HTTPS endpoint origin, ordinary bucket name, region, access
key, secret key, explicit path-style setting and optional session token. Webhooks
accept an HTTPS URL and a 32–256-byte signing secret. Datadog requires one of the
shared site identifiers and a 32-character hexadecimal API key. Validation rejects
extra fields, unsupported activation settings, plaintext/nonstandard-port URLs,
URL user info/fragments, ambiguous whitespace/backslashes and literal
private/reserved/transition addresses. This validation does not resolve DNS;
before sending, the delivery worker must validate all resolved addresses and pin
the connection to that validated destination, forbid redirects and bound all
connection/body/retry phases. These draft APIs perform no network validation.

Provider references: [S3 bucket naming](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html),
[Datadog sites](https://docs.datadoghq.com/getting_started/site/), and
[Node authenticated encryption](https://nodejs.org/docs/latest-v24.x/api/crypto.html#ciphersetaadbuffer-options).

## Key rotation

1. Deploy the old and new keys together, selecting the new active write key.
2. Fetch each tenant's current destination revisions and call `rotate-key` for
   each readable draft. Rotation decrypts privately and rewrites with the active
   key under a row lock; it changes the revision and never returns credentials.
   Retry revision conflicts after fetching current state. Replacement credentials
   can repair drafts whose old key is already lost.
3. Verify all live records use the new key before retiring the old key. Operator
   metadata-only inspection can use:

   ```sql
   SELECT credentials->>'keyId' AS key_id, COUNT(*)
   FROM public.log_export_destinations
   WHERE deleted_at IS NULL
   GROUP BY credentials->>'keyId';
   ```

4. Retain recovery key access for backups that still contain old envelopes under
   the operator's backup/retention policy. Restore drills are still pending.

There are eight admitted operations per admin instance, at most ten active
connections per tenant, three-second SQL and one-second lock budgets, plus the
existing bounded database pool. A tenant advisory transaction lock coordinates
creation across replicas; row locks and exact revisions serialize changes.
Contention returns 503 without changing saved state. Shutdown rejects new work,
drains admitted operations and disposes encryption keys.

## Verification

Run through Nx with local PostgreSQL on OrbStack:

```sh
TEST_DATABASE_URL=postgres://novagate_test:local-verification-only@127.0.0.1:15432/novagate_test \
NX_DAEMON=false NX_NO_CLOUD=true \
npm exec nx run admin-api:test -- --testPathPatterns=export-destination --maxWorkers=2
```

The real HTTP/PostgreSQL suite covers all provider draft types, encrypted storage,
no-store reads, every operation's tenant-session boundary, revision races,
replica capacity, disabled configuration, lock timeout, same-type credential
replacement, key rewrap/retirement, removal and repeated startup upgrades. Cipher
and input cases cover authentication/tampering, namespace isolation, randomized
nonces, key disposal, provider validation and global operation admission/draining.
The packaged `admin-api:runtime-smoke` runs the same draft boundary in the actual
non-root production image alongside retained metrics, alerts, RustFS archives,
privacy/retention and shutdown regressions.

## Internal provider transports — issue #95

`ExportTransportService.deliver(credentials, batch, signal)` sends one bounded batch
and returns only after a successful provider HTTP response has been consumed and its
request has closed. It has no public delivery endpoint or automatic timer. Constructing
it at application startup validates its dedicated egress configuration but sends nothing.
The scheduler activates only after the separate authenticated delivery write;
credential creation still returns `state: draft`.

Shared `LogExportDeliveryBatch` requires version 1, canonicalizable tenant/destination/
delivery UUIDs, 1–256 records and a valid tenant privacy policy. A destination payload
policy may further omit fields; it cannot undo tenant omissions. Only the documented
request-log fields are copied, validated and serialized. Database receipt metadata,
credentials, arbitrary columns and arbitrary request bodies/headers are excluded. Source
records are unchanged. Maximum serialized record size is 16 KiB and the final provider
body is limited to 1 MiB, including Datadog's JSON envelope. Invalid fields or oversized
batches fail before DNS; a worker must page/split records before admitting immutable
batches rather than silently dropping them.

Each call has a 15-second absolute deadline covering validation, projection, signing,
DNS and networking, four admitted operations per admin instance, 16 combined DNS answers,
8 KiB header bounds and a 16 KiB response bound. Both A and AAAA queries must settle;
every returned address is checked before one is pinned to the actual socket lookup.
TLS retains the destination hostname and certificate verification. Redirects are refused,
requests use no shared connection pool, and errors contain only fixed codes/messages.
Cancellation cancels the dedicated resolver and destroys the request. Capacity remains
held until the resolver/request actually settles. Shutdown rejects new admission,
cancels all work and waits for real settlement. These limits belong to the transport;
queue capacity and admission transactions belong to the internal delivery store below.

By default destinations require public HTTPS on port 443. `LOG_EXPORT_HTTP_TRUSTED_ORIGINS`
is an optional operator-owned JSON array of at most 16 exact HTTP/HTTPS origins for
controlled private fixtures or explicitly trusted internal receivers. Omitted means `[]`;
malformed settings fail application startup. It never inherits `ALERT_HTTP_TRUSTED_ORIGINS`
or platform RustFS credentials. Matching is exact, including the port. A virtual bucket
host needs its own exact origin if it is private. TLS verification remains enabled for
trusted origins. The existing draft HTTP API keeps public-only syntactic validation;
this operator setting is a transport allowance, not tenant-controlled credential input.

### Signed NDJSON webhooks

POST `application/x-ndjson`, one record per line with a final newline. The stable
`X-NovaGate-Delivery-Id` is the lowercase batch UUID. `X-NovaGate-Timestamp` is the
canonical Unix time in seconds. `X-NovaGate-Signature` is `v1=<lowercase hex HMAC-SHA256>`
using the destination signing secret over the exact bytes:

```text
timestamp + "." + deliveryId + "." + NDJSON body
```

The delivery identity is signed along with freshness and the body so an intermediary
cannot substitute a new deduplication identity. Receivers should compare the signature
in constant time, enforce their freshness window and atomically deduplicate delivery
IDs within that destination. A retry uses the same ID/body but a fresh timestamp/signature.
A 2xx acknowledges the HTTP request; it cannot prove downstream processing or inbox delivery.

### S3-compatible buckets

Use the existing official `S3Client`/`PutObjectCommand` SigV4 pipeline with complete
static or temporary credentials and `maxAttempts: 1`. The custom request handler routes
the signed PUT through the same pinned HTTP boundary. It refuses redirects and performs
no provider region retry or multipart upload. It never creates a bucket, changes ACLs
or publishes an object. Path addressing and virtual bucket addressing are verified;
ordinary dotted buckets retain the SDK's TLS-safe path addressing behavior.

The stable private object key is:

```text
novagate/<tenantId>/<destinationId>/<deliveryId>.ndjson
```

The object content type is `application/x-ndjson` and metadata includes
`novagate-delivery-id`. Retries overwrite the same key, assuming the worker retains the
same destination credentials and immutable batch. Bucket versioning may retain older
versions; lifecycle, encryption, backup and operator access policy remain the bucket
owner's responsibility. This adapter's PUT acknowledgement does not prove retention or
an at-most-once provider guarantee.

### Datadog

POST `application/json` to the fixed regional endpoint
`https://http-intake.logs.<supported-site>/api/v2/logs` with `DD-API-KEY` in headers only.
Each array element has `ddsource: novagate`, `service: novagate-gateway`, a JSON-string
`message` containing the projected record, and `novagate` correlation metadata with
version, tenant/destination/delivery IDs and record ID. All nine configured regional
sites are verified against controlled TLS receivers. The 256-record/1-MiB local limits
are below Datadog's documented 1,000-item/5-MB intake limits. API acknowledgement is not
proof of indexing, ingest latency, exactly-once delivery or provider deduplication.
See the [official Logs intake API](https://docs.datadoghq.com/api/latest/logs/send-logs/)
and [official S3 SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/).

### Verification and next boundary

Controlled HTTP/TLS tests verify wire bytes, independently recomputed S3 signatures,
session tokens, path/virtual keys, all Datadog sites, webhook signatures/privacy,
DNS/SSRF/redirect/response limits, absolute streaming deadlines, retained admission
while cancellation settles, and shutdown. A real pinned RustFS round trip verifies
stored bytes/metadata, retry key reuse and strict object/bucket cleanup.

```sh
TEST_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:19000 \
NX_DAEMON=false NX_NO_CLOUD=true \
npm exec nx run admin-api:test -- --testPathPatterns=export-transport --maxWorkers=2

# Build docker/Dockerfile.admin-api as novagate-admin:verification first.
NX_DAEMON=false NX_NO_CLOUD=true npm exec nx run admin-api:export-transport-smoke
```

The dedicated smoke target bundles only the verification entry and runs it with the
actual non-root production image's pruned dependencies on an isolated loopback network.
Controlled fixture TLS routing retains Host/SNI and certificate verification; it is
not a real-provider acceptance test. It checks webhook, temporary S3 path, S3 virtual
TLS and Datadog TLS formats, privacy and shutdown. No fixture endpoint is exposed in
the admin API. Formal credentials/provider/restore acceptance remains outstanding.

The internal store/worker now has a durable receipt cursor with provider-aware batch
splitting, fair replica scheduling and explicit source/retention coverage. Before public
activation, add authenticated history and destination payload/activation controls and
verify sustained capacity/throughput for the selected cadence. Preserve
the existing fencing, encrypted credentials and bounded retries. Already sent external bytes cannot be
recalled by subsequent privacy changes. Do not activate drafts until that complete
path is verified. Issue #90's legacy RustFS orphan/reserved-delete state stays open;
a passing fresh bucket does not prove repair of the historical state.

## Internal durable delivery store and worker

`ExportDeliveryStoreService.admit(tenant, destination, deliveryId, recordIds, policy)`
accepts only 1–256 distinct log UUIDs. It reads records and precise UTC receipt times
from that tenant's PostgreSQL table under the receipt lock, applies the union of
current tenant and optional destination omissions, and saves one immutable batch.
Request timestamps do not determine age eligibility. A late historical request with
a fresh trusted receipt is eligible. Missing, foreign or expired records reject the
whole admission; no caller can supply receipt times or raw payload data.

The automatic producer commits its cursor and batch admission together; direct `admit`
is an internal entry point independent of that cursor. Duplicate
admission with the same UUID, source set and policy returns the existing metadata.
Different source/policy/tenant reuse conflicts. Retries and lease recovery use the
saved body even if source rows subsequently change. Selected-record caller identities
remain until 168 elapsed hours after terminal completion. Scheduled terminal metadata
can roll off earlier; its committed receipt cursor prevents source replay after removal.
Queued and processing identities remain intact through retries and lease recovery.
A provider acknowledgement can be lost before persistence, so receiver deduplication
remains necessary.

Admission is atomic across replicas: at most 20 pending batches per destination,
1,000 selected-record rows per tenant and 1,200 scheduled rows per tenant. The automatic
budget allows 1,000 terminal metadata rows plus 200 pending slots across the ten permitted
destinations. Both kinds share the destination pending limit. Selected-record admission
rejects a full caller history rather than evicting young caller identities. The producer
and final acknowledgement compact excess scheduled terminal rows in pages of at most
500 under the tenant admission lock. They never compact queued/processing rows or
selected-record identities. Concurrent cleanup owns its locked rows until it settles;
the producer reports `history_busy` at the hard automatic limit instead of growing
past it. Legacy excess history drains in bounded pages before further admission.
Each service owns eight SQL operations, three-second
statement and one-second lock deadlines, and drains its owned transactions before
destroying its credential keys. Locks consistently follow tenant → destination → batch.
Pending payload expiry is the earlier of 24 hours after admission and the oldest
source receipt's remaining tenant lifetime. Terminal states erase `payload` immediately.
Cleanup revokes at most 500 expired payloads and removes at most 500 terminal rows
older than 168 elapsed hours per invocation. The internal scheduler runs cleanup before
each discovery sweep when dedicated encryption keys are configured.

`claim` uses row locks with `SKIP LOCKED`, a random 30-second lease, and a maximum of
six charged attempts, including failed credential reads and interrupted lease recovery.
Retryable errors back off 5, 30, 120, 600 and 1,800 seconds. Permanent errors and the
sixth failure terminate without retained payload. Stored error codes are fixed strings;
remote bodies and exception messages never enter history. `history` returns at most
50 explicitly projected tenant/destination metadata entries, including their source kind.
`historyState` returns those entries and workspace-wide coverage from one statement
snapshot. One fixed summary row per workspace counts removed scheduled delivered,
failed and expired batches and record occurrences; repeated exports to different
destinations count separately. Counts are exact decimal strings from PostgreSQL BIGINT,
and deletion/counter increments commit atomically. Coverage states its workspace scope,
168-hour maximum age, 1,000 scheduled terminal target, 50-entry read limit and last
prune time. Age cleanup also counts scheduled removals; caller removals do not change
these totals. Reads contain neither source IDs nor payloads. The scheduled source marker
survives removal/recreation of a schedule. Neither read has an HTTP endpoint yet.

`ExportDeliveryWorkerService.deliverNext` owns one claimed provider attempt. It has
four admissions, checks lease/destination/privacy/retention eligibility before network
work, and rechecks every second with no overlapping SQL polls. A failed check cancels
the actual transport. The poll can itself take up to its SQL deadline; already sent
bytes and external copies cannot be recalled. Shutdown cancels and drains actual
requests and polls. An acknowledgement/backoff update must still own the unexpired
lease and current revisions. A lost/stale lease cannot report success or retry.

Privacy/retention saves and destination edits, re-encryption or removal revoke queued
and processing leases and erase their payloads in the same write transaction. The
worker notices in-flight revocation and closes its socket. Delivered external data
remains outside that erasure boundary. An interrupted final acknowledgement can leave
a recoverable processing lease, whose next attempt retains its delivery identity.

The store and worker are dependency-injected internal providers. The separate scheduler
owns bootstrap and shutdown; public activation configures receipt scheduling and
does not expose arbitrary enqueue. PostgreSQL integration covers real receiver failure/retry, reconstructed
workers, immutable bytes, duplicate/capacity races, lease fencing, six attempts,
microsecond receipt floors, immediate revision revocation and actual socket shutdown.

## Automatic receipt scheduling

`saveSchedule` uses both destination and schedule revisions, validates the filter and
payload policy, and verifies encrypted credentials. First configuration begins at the
database save receipt under the ingestion lock; existing logs are not automatically
backfilled. It retains microseconds and a receipt/UUID keyset cursor. Minute/hour UTC
windows settle for 15 seconds before reading; request timestamps never select a window.

Each producer reads at most 257 bounded source rows, processes at most 256 and admits
one batch. Source selection, privacy projection, exact provider envelope sizing and
cursor/counter updates run in one transaction without network work. Oversized legacy
text is bounded in SQL before validation. NDJSON newlines and Datadog envelope/escaping
bytes count against the 1 MiB body budget. A partial window retains the last processed
receipt and UUID; empty settled windows advance without skipping retained receipts.
Invalid and filtered records increment separate counters. A hidden stored filter field
stops source inspection with `filter_unavailable`.

Pause stops source admission while queued batches remain eligible for delivery.
Cadence/filter edits preserve the cursor and admitted bytes. Changing the payload policy
advances the destination revision and revokes queued/processing bytes immediately.
Retention can advance a stalled cursor to the inclusive floor; coverage reports skipped
elapsed seconds rather than claiming a known count of deleted records. Pending queue
pressure reports `queue_full`; automatic row ownership pressure reports `history_busy`.
Both retry after five seconds and preserve unprocessed source receipts, except for
required retention-floor advancement. Completed history rolls off with explicit coverage
so continuously nonempty minute windows can continue beyond 1,000 deliveries. Sustained
timer throughput and backlog under slow providers have controlled runtime checks;
larger workload/replica and actual-provider acceptance remain separate gates.

`ExportDeliverySchedulerService` owns a non-overlapping two-second discovery timer.
Each sweep reserves at most four due producers fairly across replicas. It dispatches
only into the worker's currently free slots, with at most four owned attempts and one
in-flight attempt per destination per instance. Slow provider requests do not hold the
source/discovery sweep; other destinations can use free slots on subsequent ticks.
Discovery excludes destinations already owned by that instance and reserves only as
many targets as there are free slots. Pending admission includes claim, actual socket
settlement, eligibility polling and final acknowledgement. When all four slots are
occupied, source work can continue within the existing queue limit; dispatch waits
for actual settlement rather than creating an unbounded promise queue.
Producer reservations recover after two
seconds if a replica exits; leased delivery recovery retains the worker's existing
30-second fencing. One failed source/destination does not stop the remaining bounded
targets. Automatic dispatch explicitly claims only jobs marked scheduled and still
bound to that destination's schedule. Caller batches and jobs whose schedule was
removed are not implicitly delivered even when the same destination has active
scheduled work. Explicit internal worker calls retain their existing claim behavior.
Shutdown seals admission, aborts actual provider requests and drains both the source
sweep and all independently owned attempts.

Real PostgreSQL checks cover non-UTC sessions, precise boundaries, partial/provider-sized
batches, replicas, rollback, capacity, retention, pause/resume, cadence changes and real
socket shutdown. The packaged runtime fixture seeds only an operator-trusted encrypted
connection and synthetic full caller/scheduled terminal history. It activates through
the authenticated API, inserts a fresh database-receipted source, exercises the actual
application timer against a controlled receiver, and reads history, pauses and removes
the schedule through that API. `npm exec nx run admin-api:export-capacity-smoke`
adds a separate non-root production dependency fixture with 1,101 actual PostgreSQL
receipt windows and signed HTTP deliveries, an independently full 1,000-row caller
history, store/worker reconstruction, no source replay and exact compaction coverage.
Its direct producer/worker loop is a capacity regression, not a timer throughput or
comparative performance benchmark. These controlled fixtures do not establish
external-provider acceptance.

`npm exec nx run admin-api:export-scheduler-smoke` exercises the actual bootstrap timer
with no manual ticks across two workspaces and seven destinations. A controlled stalled
receiver shares the worker with six healthy destinations. A real prefilled 20-batch queue
proves saturation without cursor advancement; pause retains dispatch of queued work,
reconstruction preserves persisted identities, and resume admits the remaining source
windows. The fixture verifies signed/private bytes, tenant/filter source isolation,
unchanged bytes for legitimate retries, no source replay under a new delivery ID,
bounded SQL processing/socket ownership and terminal payload erasure. It records its
timings and limits in `.local-work/export-scheduler-evidence.json`. This controlled
backlog check does not establish production scale, actual-provider indexing or
comparative Kong performance; larger workload/replica acceptance remains open.
