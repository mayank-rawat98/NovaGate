# Tenant alerting — issue #65

Implementation is in progress on the issue-linked branch. Do not register an
unfinished alert feature in AppModule or describe it as delivered.

Change shared contracts first. Alert rules and channel CRUD must use the existing
bearer-session workspace guard and canonical tenant schemas. Reject unknown input,
non-finite values, invalid metric/operator/window combinations, duplicate channel
IDs, oversized configuration and cross-tenant references before persistence. Rule
updates need a revision check; channel reads must redact secret URLs and signing
credentials. Keep operator encryption keys separate from JWT signing keys.

Use gateway interval request/error/timeout counts and fixed histogram buckets for
rolling rates and percentile estimates. Never average percentile values or invent
zero traffic/healthy windows when reports are missing. Legacy snapshots stay
readable but cannot claim the richer aggregate evidence needed by alerts.

Evaluation and delivery require finite query/admission/queue/lease/deadline/retry
limits and transactionally persisted events/cooldowns. Coordinate replicas with
row locks and fencing. Restrict tenant-selected destinations, pin validated DNS,
block private/metadata egress by default and refuse redirects. Production Slack
webhooks and email addresses are never test fixtures. Clear timers, cancel actual
work and finish lifecycle cleanup on shutdown.

Use meaningful validation, real database/replica/delivery, production container
and dashboard browser/accessibility checks before the dev PR. Update the roadmap
with verified evidence; formal all-phase acceptance remains separate.

The current aggregation helper selects whole intervals by server receipt time.
Coverage is the union of estimated interval spans, clipped at the lookback
boundary; counts and histogram bins are never prorated. At least 80% coverage,
a report within 15 seconds, and the configured minimum request count are required.
Legacy rows have null metadata and contribute no coverage. Verified idle windows
can evaluate RPS; count-based rates and latency require requests. Heavy overlap
or corrupt evidence produces no-data rather than an ambiguous multi-gateway result.
Queries must return at most 5,001 rows: the extra row detects the 5,000-sample
admission limit instead of silently evaluating truncated evidence.

Admin provisioning and startup migration own the nullable aggregateWindow JSONB
column. Deploy the admin schema migration before the updated control plane; the
control plane never changes tenant schema and refuses writes if the schema is
not ready. Its live publication still contains only the canonical summary fields.

Alert schema foundations include per-tenant channel/rule/reference/event/delivery
tables and public due queues containing only tenant IDs, work IDs and lease times.
Future CRUD and retention must update public queues and tenant rows in the same
transaction; cross-schema work IDs intentionally have no foreign key. Queue claims
must use SKIP LOCKED and fresh lease tokens, and completion must compare the token.
Events retain names after rule/channel deletion; secrets belong only in encrypted
channel credentials and never in events, deliveries or public queues. The schema
alone does not enable workers or channels.

Channel storage now validates complete writes before database admission, encrypts
credentials using AES-256-GCM, and returns only display-safe origin/recipient fields.
Tenant/channel IDs, envelope version and key ID are authenticated as associated data.
Metadata edits preserve encrypted values; replacement credentials require a complete
explicit write of the same channel type. Revisions prevent lost edits. Any channel
edit/delete cancels queued/processing delivery rows and their public due work inside
the same transaction; previous delivered history remains. Actual already-started
network delivery still requires worker fencing and cancellation in the next steps.

Operator settings (never tenant fields): ALERT_CHANNEL_KEYS is a JSON object mapping
up to four key IDs to canonical base64-encoded 32-byte keys. ALERT_CHANNEL_ACTIVE_KEY
chooses one explicit write key; retain older keys until their channel values have
been rewritten. Both absent/empty disables channel creation and delivery without
using the JWT signing secret. Partial/invalid configuration fails validation.
ALERT_HTTP_TRUSTED_ORIGINS is an optional JSON array of at most 16 exact HTTP/HTTPS
origins for deliberately trusted internal destinations. Default destinations require
public HTTPS on port 443; webhook signing secrets require 32–256 bytes. Slack writes
must use an incoming webhook URL. Secret paths and query strings are encrypted and
never returned. Delivery still must validate all DNS answers, pin the connection,
refuse redirects and apply finite deadlines; URL validation alone does not prove
safe transport.

The conservative address policy follows IANA special-purpose registries, denying
private, metadata, reserved, documentation and transition ranges by default:
https://www.iana.org/assignments/iana-ipv4-special-registry/
https://www.iana.org/assignments/iana-ipv6-special-registry/

Rule persistence now saves validated configuration, tenant-local channel references
and public due scheduling atomically. Updates reset evaluation/cooldown state,
invalidate claimed evaluation work and cancel pending delivery work. Disabled rules
have no due row. Delete preserves event names and values through nullable references.
Channel deletion also advances affected rule revisions, so an older UI cannot
silently overwrite a changed channel selection. Empty channel selection explicitly
means dashboard history only. Disabled channels can stay selected and produce no
external delivery until re-enabled.

CRUD and future evaluator/retention transactions acquire the tenant advisory lock
before queue row locks. A worker's initial SKIP LOCKED lease claim must commit before
it acquires the tenant lock, then verify its token and read the current locked rule inside
the tenant transaction. Rule configuration updates invalidate the queue token. Avoid holding a queue row lock while waiting for a tenant
lock: that reverses CRUD lock order and can deadlock.

The generated AlertsController is attached only to AlertsModule; AppModule still
omits the unfinished feature. Its real HTTP fixture installs the existing global
TenantAuthGuard and verifies every route rejects missing/foreign sessions. DELETE
requests require a JSON body containing only the current numeric revision. History
returns at most 100 events from 30 days with at most 500 delivery summaries, excluding
credentials and internal event linkage. Stored event retention and durable delivery now have implementation below;
read-time filtering alone is not a storage retention policy.

The evaluator now starts on application bootstrap, after schema migrations, with
one unreferenced, non-overlapping one-second timer. Each batch leases at most 16 due
rules for 30 seconds and evaluates at most four concurrently through shared tenant
storage admission. Successful work schedules the next evaluation after 15 seconds.
Claim transactions commit before tenant locking; tenant work verifies and locks the
lease before reading the current rule. Crashed/failed claims recover after expiry;
configuration changes invalidate tokens and obsolete claims do no work.

Evaluation, event creation, eligible channel delivery rows, public due jobs and
cooldown state commit together. Firing events occur at most once per five-minute
cooldown. Verified recovery produces a resolved event promptly and preserves the
last firing cooldown; missing reports never invent resolution. All values and
latency estimates come from validated interval aggregation. Events with no selected
enabled channels remain available in dashboard history without external delivery.

Each evaluation prunes expired/over-limit events and matching public delivery jobs
in the same transaction. Idle cleanup also visits at most 64 public tenant IDs per
minute using a UUID cursor; it shares storage admission, validates schemas, prevents
overlap and continues after a tenant failure. Keep 30 days and at most 1,000 events
per tenant, with delivery rows cascading away. Shutdown stops the timer and awaits
actual evaluation and retention work. None of this enables the incomplete module in
AppModule or proves the pending network delivery/UX/packaged acceptance checks.

## Secure delivery implementation — 6 October 2026 (not enabled in AppModule)

`AlertTransportService` now sends signed JSON webhook POSTs, plain-text Slack blocks
and Mailtr API email requests. The local Mailtr dev contract was reviewed at
`819117fb14846216bff6084a7ebbd0f1cdf5dfa0`; the email endpoint accepts from/to/subject/
html/text and reports API acceptance, not final inbox receipt. No production Slack
URL, email address or API credential is a test fixture.

Default egress is public HTTPS/443. A dedicated cancellable resolver checks both
A and AAAA results, admits at most 16 addresses, and refuses any non-public answer.
The request lookup pins the selected address while retaining the hostname and TLS
certificate verification. Trusted exact origins explicitly allow private/HTTP
receivers but never disable TLS certificate checks. No redirects or reused pooled
connections. The whole DNS/connect/upload/response attempt has a five-second deadline;
request/response bodies are at most 16 KiB and response headers at most 8 KiB.
At most eight transport operations are admitted. Abort and shutdown cancel actual
DNS/socket work and await settlement. Errors contain only static safe descriptions.
Node API references: https://nodejs.org/api/dns.html#class-dnspromisesresolver and
https://nodejs.org/api/https.html#httpsrequestoptions-callback.

Webhook headers are X-NovaGate-Delivery-Id, X-NovaGate-Timestamp (Unix seconds), and
X-NovaGate-Signature (`v1=` followed by a hex HMAC-SHA256 of timestamp + `.` + the exact
UTF-8 body, keyed by the channel signing secret). The versioned body contains deliveryId,
tenantId and documented event fields only. Receivers should verify signatures in
constant time, apply a timestamp tolerance and deduplicate deliveryId. Credentials
never appear in the payload. Mailtr requests also carry an Idempotency-Key header;
provider-side deduplication must be verified separately, and Slack offers no equivalent
exactly-once guarantee. Delivery is at least once after crashes/ambiguous acceptance.

`AlertDeliveryService` commits SKIP LOCKED claims before tenant locking. Batches claim
at most 16 jobs for 30 seconds and process at most four concurrently. A persisted
leaseStarted guard permits one start per token even when two replicas are handed the
same lease. Each attempt increments durably before networking; transient failures
retry after 5 then 20 seconds, with a hard limit of three total attempts (including
crash-recovered starts). Permanent policy/validation/HTTP failures stop immediately.
Missing keys, invalid ciphertext and obsolete references produce safe history.

Before networking and every 250 ms while it is pending, a non-overlapping bounded
query checks the current lease, channel revision and enabled state. Losing ownership
or changing/deleting the channel/rule cancels actual pending work; sent bytes or a
receiver's accepted side effect cannot be undone. Completion/retry compares the current
token and attempt inside the tenant transaction, and history/public scheduling commit
atomically. Failed finalization leaves a recoverable lease and the same stable delivery
ID. SQL statements are bounded to three seconds, locks to one second; production admin
pool admission is also bounded to three seconds with at most 20 connections.

The bootstrap timer does not overlap batches. Shutdown stops admission/timers, aborts
live requests and drains actual batch/watch work. The feature remains omitted from
AppModule until dashboard, packaged-service acceptance and final issue #65 verification
are complete. Migration runs before control-plane/worker deployment, including the
idempotent addition of leaseStarted to existing delivery schedules.
