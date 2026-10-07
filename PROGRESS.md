# NovaGate progress and remaining work

Updated: **7 October 2026** (Asia/Calcutta).

This report distinguishes merged development work, the alerting foundation checkpoint,
and formal acceptance. The detailed roadmap is [implementation.md](implementation.md).
No whole phase or production release is declared complete by this report.

## Current checkpoint

- Latest verified development work: [PR #87](https://github.com/mayank-rawat98/NovaGate/pull/87), linked to [issue #85](https://github.com/mayank-rawat98/NovaGate/issues/85), fixes non-rejecting storage timeouts and shutdown/resource cleanup. Its branch starts from `dev` at **2affcb71** / merged [PR #86](https://github.com/mayank-rawat98/NovaGate/pull/86), which implements six-field stored-metadata privacy. The final affected-project run passes 567 admin tests, including eleven actual stalled-network checks and a real multipart RustFS round trip; backend static/build gates and fresh packaged OrbStack/RustFS/metrics/alerts/privacy/retention verification pass. The unchanged gateway/collector/dashboard retain issue #84's 1,263-test and 42-plus-seven-load browser checkpoint. Formal phase acceptance remains pending.
- Alerting development checkpoint: [PR #68](https://github.com/mayank-rawat98/NovaGate/pull/68), linked to [issue #65](https://github.com/mayank-rawat98/NovaGate/issues/65), adds durable delivery and the Alerts dashboard.
- Its issue-linked branch `65-feat-alert-delivery-and-dashboard` was created from `dev` at **653d7a00** / [PR #67](https://github.com/mayank-rawat98/NovaGate/pull/67), which merged the storage/evaluation foundations and roadmap documents. Foundation [issue #66](https://github.com/mayank-rawat98/NovaGate/issues/66) is closed.
- **AppModule imports AlertsModule**. Authenticated endpoints and workers start after migration; missing dedicated encryption keys disable channel creation/delivery.
- [Issue #69](https://github.com/mayank-rawat98/NovaGate/issues/69) tracks one intermittent dashboard hydration recovery. Expanded subsequent browser checks pass, but a root cause/fix has not been established. It remains part of the remaining work and formal release acceptance.
- Work and verification use OrbStack. Nothing here authorizes or represents a main deployment.

## Implemented and merged into dev

### Baseline, isolation and configuration

- Audited the original phase plan and recorded verification gaps (#25).
- Bound tenant REST access to authenticated session subjects, removed fallback signing
  secrets/public provisioning, redacted private tenant responses and repaired groups (#27).
- Replaced pooled search-path assumptions with tenant-qualified ingestion queries;
  disabled destructive control-plane entity synchronization (#27).
- Persisted configuration before publication, used database-backed versions, replayed
  pending updates until ACK, rejected revoked gateway keys and recovered cached identity (#27).
- Preserved legacy CORS/IP/body-limit settings while migrating them to plugins;
  made repeated upgrades idempotent and repaired update/clear/not-found semantics (#33).
- Removed the dormant local admin registry and PostgreSQL dependency from the customer
  gateway; administration stays in the authenticated SaaS admin API (#44).

### Routing and plugin foundations — phases 0–1

- Weighted routing, bounded binary/chunked body handling, safe HTTP retry termination,
  actual browser preflight behavior and opt-in trusted-proxy/IP handling (#29).
- Configurable HTTP/native gRPC health checks, non-overlapping probes, target eviction,
  lifecycle bounds and explicit all-down behavior (#39/#41).
- Thirteen first-party plugins registered through the actual Nest aggregate factory,
  ordered execution and fail-closed unknown plugin resolution (#27).
- First-party size, CORS, IP, rate-limit, request/response transform, Basic, OIDC,
  client-credentials, HMAC, ACL, mTLS and GraphQL policies with dashboard configuration.
- Verified least-connections selection, deterministic accounting, strict target validation,
  health/retry/protocol compatibility and dashboard load-balancing controls (#57).

### Authentication — phase 2

- Bounded, isolated OIDC/JWKS and OAuth client-credentials provider verification,
  including cache/provider isolation, cancellation and key rotation checks (#47).
- ACL groups separated from external identity-provider subjects.
- Verified TLS client possession for native/proxy mTLS and live trust rotation (#49).
- Bounded signed-body preparation, replay limits and Stripe/GitHub webhook HMAC formats (#51).
- Actual external Auth0 deployment acceptance and complete phase acceptance remain open.

### Protocols — phase 3

- Native streaming gRPC listener with frame/message limits, JWT/consumer authentication,
  compatible plugins, quotas, metadata/trailers, deadlines, cancellation and shutdown (#41).
- Real native gRPC Health/Check semantics, TLS checks, grpcurl verification, peer capacity
  negotiation and large-stream backpressure checks (#41).
- Authenticated native HTTP/HTTPS WebSocket upgrades, quotas, explicit plugin compatibility,
  private query-token handling, byte/connection/deadline limits and revocation (#43).
- WebSocket TLS, compression/subprotocols, bidirectional/control traffic, paused-receiver
  backpressure, idle expiry and shutdown coverage (#43).
- Bounded HTTP/2 pools, health-compatible fallback and protocol lifecycle cleanup (#55).
- Bounded AST-based GraphQL depth/complexity/introspection policies across supported
  request formats, with fail-closed validation and dashboard controls (#53).

### Observability and private storage — phase 4

- Accurate final HTTP finish/close accounting, monotonic durations, incomplete-response
  classification and lifecycle cleanup (#59).
- OpenTelemetry request/attempt spans for HTTP, native gRPC and WebSocket lifecycles;
  bounded W3C propagation, parent sampling, retry/fallback children and log correlation (#61).
- Bounded authenticated trace ingestion, tenant storage, retention and queries;
  dashboard search, timing waterfall, span attributes, pagination and log links (#61).
- Live completed-HTTP metrics through gateway → committed control-plane storage → Redis
  → authenticated admin SSE → dashboard, with bounded history and stream resources (#63).
- Dashboard live/reconnecting/stale states, manual retry, workspace cancellation,
  reconnect recovery and retained history (#63).
- Private manual RustFS NDJSON archive jobs and authorized streaming downloads;
  fenced replica workers, bounded snapshot/keyset reads, multipart handling, three
  attempts and object/job expiry cleanup (#37).
- RustFS is pinned by digest; production storage is opt-in/private with separate
  credentials. Receipt-based scheduling is implemented in issue #72; external export destinations remain unfinished.

### Dashboard and release workflow

- Responsive grouped navigation, ivory/mint/indigo colors, CSS clay illustrations,
  native accessible dialogs and useful loading/empty/error/retry feedback (#35).
- Mobile/desktop, keyboard focus/Escape/restoration, session hydration, one-time
  consumer keys and axe accessibility checks; later trace/live-metrics UX regressions.
- Deterministic Node 24/npm-ci images, immutable revision releases, release concurrency,
  reusable verification and read-only staged-formatting safeguards (#31).
- CI now has only `workflow_call`; deployment triggers only on **push to main**.
  Every image build requires verification, and deployment requires verification plus
  all four image builds. PR/dev/tag/manual events do not trigger CI or deployment.
- Personal GitHub SSH identity: `github-personal` / `mayank-rawat98`.
- Reviewed Mailtr dev/reference safeguards and cached Medhank code in `examinator`;
  adapted relevant workflow/cache/runtime principles without copying credentials.

## Issue #65: alert delivery and dashboard checkpoint

Storage/CRUD/evaluation foundations were merged in PR #67. Transport, delivery and
the Alerts dashboard are enabled in the PR #68 checkpoint and verified locally.
Formal provider/inbox and all-phase production acceptance remain separate.

| Component            | What exists now                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared contracts     | Four metrics/comparisons, request minimums, revisions, evaluations, channels, events and redacted delivery summaries. Backend workspace dependencies are declared through npm. |
| Metric evidence      | Validated reporting duration, request/error/downstream-timeout counts and fixed histogram bins. Scalars must match counts/histograms; final timeout attribution is recorded.   |
| Compatible storage   | Nullable admin-owned aggregate metadata migrations preserve legacy rows. Control-plane writes evidence while keeping public live snapshots unchanged.                          |
| Aggregation          | Merge histogram bins for p95 and weight rates by counts/duration. Coverage, freshness and minimum-request gates return no-data for incomplete/stale/ambiguous evidence.        |
| Schema               | Tenant-local rules/channels/references/events/deliveries and public due queues with paired lease token/expiry constraints.                                                     |
| Credentials          | Dedicated rotatable AES-256-GCM keys authenticated to tenant/channel identity; explicit credential replacement; origin/recipient-only reads. No JWT-key fallback.              |
| CRUD                 | Authenticated tenant HTTP endpoints, strict validation, atomic configuration/reference/schedule writes, capacity limits and revision conflicts.                                |
| Cancellation/history | Edits/deletes cancel obsolete due delivery work; deleted references preserve event/channel names. Channel deletion advances affected rule revisions.                           |
| Evaluator            | Bootstrap-after-migration timer, durable SKIP LOCKED claims, token fencing, shared tenant admission, bounded concurrency, atomic events/jobs/cooldowns and lease recovery.     |
| States/cooldowns     | Five-minute firing cooldown; verified healthy recovery creates resolution; missing reports preserve the last notified state. Empty channel selection means history only.       |
| Retention/lifecycle  | 30-day/1,000-event limit, matching due-work cleanup, delivery cascades, bounded idle sweeps, non-overlapping timers and actual-work shutdown draining.                         |

Delivery implementation (6 October):

- Signed webhook payloads with stable delivery IDs and documented HMAC headers;
  Slack plain-text blocks and Mailtr API email with HTML escaping.
- Public HTTPS egress by default, all-answer A/AAAA validation, pinned connections,
  certificate checks, exact trusted origins, no redirects, finite byte/admission limits,
  five-second total deadlines and actual DNS/socket cancellation.
- Durable delivery claims, one start per lease token, three-attempt hard limit,
  5/20-second retry delays, static safe errors and atomic history/schedule finalization.
- Configuration/lease checks during active requests, expired-event rejection,
  crash recovery, shutdown draining and bounded production database pool admission.
- Real local receiver/replica/rollback/cancellation/timeout/pool-saturation regression
  fixtures. These do not use real Slack/email destinations or production secrets.

The new ivory/mint/indigo Alerts workspace includes CSS clay art, searchable rule
cards, percent/ms/RPS thresholds, minimum requests, channel selection and history-only
rules. Channel forms mask write-only credentials, preserve input on failed saves,
require explicit same-type credential replacement and clear unsaved data on workspace
changes. Revision-aware deletion preserves history. Coverage, no-data, stale/paused
evaluation, actual cooldown deadlines and delivery availability have distinct feedback.
Recent activity exposes queued/sending/accepted/failed/cancelled states and finite attempts.
The API returns display-safe notification capabilities and persisted last-notified/cooldown
state; email API acceptance is distinguished from inbox receipt.

Key implementation files are under [apps/admin-api/src/alerts](apps/admin-api/src/alerts)
and [libs/shared-types/src/lib/alerts.ts](libs/shared-types/src/lib/alerts.ts).
Admin schema migration must run before deploying the updated control plane.

## Verification evidence and limits

**Merged metrics checkpoint (#63):** 830 tests across gateway/admin/control-plane/dashboard,
all five projects' lint/typecheck/build gates, real PostgreSQL/Redis/RustFS fixtures,
production dashboard desktop/mobile/accessibility checks, packaged HTTP/gRPC/WebSocket/TLS
regressions and a three-service metrics pipeline/shutdown check. All three services
exited normally within Docker's ten-second shutdown grace in that fixture.

**Foundation checkpoint (#66):** the combined Nx regression run passes **1,027 tests**
(559 gateway, 367 admin, 91 control-plane and 10 dashboard), using OrbStack verification
services. All five projects pass lint and typecheck; all four application builds pass. Nx reused matching local
cache results for one test task and some static/build tasks. This is regression
verification, not the formal all-phase acceptance campaign.

**Current alert branch (6 October):** the combined Nx regression run passes
**1,093 tests** (559 gateway, 433 admin, 91 control-plane and 10 dashboard). All five
projects pass lint/typecheck and all four application builds pass. Real local HTTP
tests cover the three delivery formats, HMAC/redaction, DNS pinning, private/redirect/
TLS denial, finite budgets, replica/crash recovery, live cancellation, transaction
rollback, pool saturation and shutdown. Real PostgreSQL checks also verify public
channel availability and exact persisted cooldown deadlines.

Fresh OrbStack production images pass the complete gateway → control plane → PostgreSQL
→ admin evaluator → local notification receiver chain. A firing notification is accepted
in **59.166 seconds** after measured traffic begins; the webhook's first 503 retries
after five seconds with the same delivery ID and exact signed body. All three channel
formats receive both firing and healthy-recovery notifications (six accepted deliveries).
Revision conflicts, redacted reads, encrypted storage, retained deletion history and
empty due queues are verified through the actual HTTP/database interfaces. All three
services exit **0** within the ten-second shutdown grace. The retained packaged
HTTP/gRPC/WebSocket TLS/auth/config/streaming verifier also passes.

Production dashboard browser checks cover the new forms, revision conflicts,
secret replacement, missing delivery capability, stale/no-data/cooldown states,
workspace changes, capacity limits, mobile layouts, keyboard navigation and axe WCAG
A/AA checks alongside existing pages. One interim run reported React hydration
recovery; URL/stack diagnostics and additional cold-load coverage were added for
final verification. The follow-up cold-load and sixfold CPU-throttled runs pass;
[issue #69](https://github.com/mayank-rawat98/NovaGate/issues/69) retains the unresolved
root-cause investigation rather than treating green reruns as a fix.

Current tests cover authenticated HTTP routes, credential redaction/encryption/tampering/
rotation, tenant isolation, concurrent capacity/revision races, atomic rollback under a
forced database failure, stale/expired leases, cooldown/resolution/no-data and idle cleanup.

Local evidence lives in ignored `.local-work` artifacts, including:

- `issue65-ui-all-tests.log` — 1,093 regression tests.
- `issue65-ui-all-static.log`, `issue65-ui-builds.log` — all-project static/application gates.
- `issue65-ui-smoke-final-gate.log`, `issue65-ui-smoke-hydration.log`, `issue65-ui-smoke-slow-cpu.log` — browser/accessibility, cold-load and slow-device checks.
- `metrics-container-evidence.json`, `issue65-alerts-container-smoke.log` — fresh image IDs, actual alert timings and production lifecycle.
- `issue65-ui-transport-container.log` — retained packaged transport/authentication checks.
- `issue65-delivery-all-tests-final.log` — earlier 1,092-test transport checkpoint.
- `issue65-delivery-all-gates.log`, `issue65-delivery-gates-final.log` — application/static gates.
- `checkpoint-tests.log`, `checkpoint-static.log`, `checkpoint-build.log` — combined checkpoint gates.
- `issue65-aggregation-tests-recheck.log` — gateway interval foundations.
- `issue65-storage-final-tests.log` — control-plane interval persistence.
- `issue65-evaluator-timer-recheck.log` — 367 admin tests.
- `issue65-evaluator-timer-gates.log` — final admin lint/typecheck/build.
- `issue63-pipeline-shutdown-verified.log` — merged packaged metrics pipeline/shutdown.

Current checks use disposable local receivers for webhook, Slack-format and Mailtr-format
requests. Real provider deduplication and final inbox acceptance remain pending;
ambiguous retries are at least once. They are part of later formal/provider acceptance.
Formal phase exit criteria, comparative Kong benchmarks and production acceptance
remain unverified. Include sanitized reproducible evidence in each eventual PR.

## Hydration diagnostics checkpoint — issue #70

The browser verifier records Playwright traces with screenshots, DOM snapshots and
source on both success and failure. A validated 1–20 pass setting controls cold loads
of seven workspace pages under sixfold CPU throttling; normal verification remains
one pass plus the existing complete forms/live-metric/privacy/accessibility suite.
Run metadata records actual completed cold loads, errors and accessibility findings.
The existing deployment-only CI artifact step also retains the trace archive.

The production six-pass sweep passes 42 cold loads and full feature flows. Its trace
contains 59 navigations and 1,354 DOM snapshots (25.2 MB). A development-mode complete
run also passes. Default tracing and intentional fixture-failure cleanup are checked
separately. Asynchronous fixture exceptions remain visible to the strict error gate
instead of terminating Node before trace finalization. The deliberate missing-workspace
and unexpected-API-path fixtures both exit nonzero while retaining traces/error metadata.
A deliberate invalid-auth request to the owned SSE fixture also fails the strict
gate after all functional flows pass, preserving trace/error metadata.
Evidence is in `.local-work/issue69-production-traced-browser.log` and
`.local-work/issue70-default-evidence/` / `issue70-expected-failure-evidence/`.
No hydration root cause/fix is claimed; issue #69 remains open. The diagnostics
checkpoint supports continued roadmap work and later formal release acceptance.

## Scheduled RustFS archives — issue #72

Issue #72 extends the manual archive foundation with every-minute and hourly UTC
schedules, tenant-scoped revision-aware APIs and accessible Settings controls. New
schedules start at database receipt time. Late gateway requests enter their receipt
window while NDJSON preserves their original request timestamps. Pausing retains
waiting windows; resume catches up, updates preserve the cursor and queued filters,
and deletion preserves archive history. Failed, unexpired jobs can be explicitly
retried with their original window/filter; requested retry count survives restart.

Window claims use short PostgreSQL transactions, with no external I/O. A shared
tenant receipt lock coordinates ingestion, and cursor/job insertion commit together.
Fair sweeps admit at most 16 windows per two-second tick; pending job admission is
shared across manual/automatic/retry requests and capped at 20 per tenant. Empty
windows create no files and queue saturation retains the cursor. Log ingestion has
finite batch/byte/admission/deadline/pool bounds and drains actual writes on shutdown.

Admin upgrades normalize legacy naive log times as UTC and add database-owned receipt
metadata/indexes. JSON record ingestion explicitly stamps receipt after lock waits,
ignores caller receipt values, and still supports legacy optional columns. Public
logs/NDJSON exclude this metadata. Manual/automatic keysets and exported timestamps
are explicitly UTC with microsecond precision under non-UTC database sessions.

Customer UX exposes active/paused/catching-up states, pending/backlog/failure counts,
minute/hour cadence, status/literal-prefix/consumer filters, revision/save recovery,
removal confirmation and retained downloads. Native dialogs retain keyboard focus,
Escape and restoration. Verification passes 1,134 retained tests (559 gateway, 466 admin API, 99 control plane,
10 dashboard), all five projects' lint/typecheck gates and all four application
builds. Archive tests include non-UTC sessions, first-window microseconds, 1,201-row
RustFS pagination, legacy upgrades, replica/revision/pause races, cursor/job rollback,
full-queue recovery, receipt/status-read lock deadlines, exhausted-run retry and shutdown drain.

Fresh production images on OrbStack produce three private scheduled archives with 94
unique records from 20 initial HTTP completions, 73 alert recovery requests and one
separately authenticated late log. The forged receipt is ignored, the original year
2000 request time survives NDJSON, exported IDs match persisted records, anonymous
object access is denied and pause works. Retained metrics and firing/retry/recovery
also pass: local firing acceptance takes 59.111 seconds and all three service exits
are 0 without SIGKILL. The fixture removes its own containers/network afterward.

Evidence: `.local-work/issue72-all-tests.log`, `issue72-final-admin-tests.log`,
`issue72-final-archive-tests.log`, `issue72-final-static.log`,
`issue72-final-admin-static-build.log`, `issue72-backend-builds.log`,
`issue72-runtime-final.log` and `metrics-container-evidence.json`. Production browser
checks pass 42 cold loads under sixfold CPU throttling, followed by a final seven-load
run, with zero runtime errors or accessibility findings. They cover archive form
recovery, retry, pause/removal, keyboard/mobile behavior and workspace switching.
Evidence is retained in `issue72-final-browser.log`, `issue72-default-final-browser.log`,
`issue72-six-pass-browser/` and `dashboard-verification/` (run metadata, screenshots
and traces). Alert fixture teardown now unmounts its page before removing mock routes,
preventing background polling from reaching the next fixture. The strict runtime
gate remains enforced; this does not establish a fix for issue #69. External
destinations, privacy controls and formal acceptance stay pending.

## Per-consumer usage — issue #74

Issue #74 adds tenant-scoped consumer usage APIs and a modern Consumers → Usage
panel. It reports exact persisted-log request/server-error counts, window-average
RPS, interpolated latency percentiles, gap-filled trends and ten method/path groups.
Hour/day/week presets use half-open UTC request-time windows. Negative or missing
latency is excluded from samples; empty intervals keep zero rates and null latency.
Query strings are removed and long path labels are grouped by their 512-character
prefix. Unknown/foreign consumers remain scoped, revoked history stays queryable,
and hashes/credentials never appear in stats. Existing logs/metric history support
consumer filters without changing unfiltered live metrics.

Each query uses a repeatable snapshot and an admin-owned consumer/time/id index.
Eight actual queries per admin process/two per tenant, three-second statements,
one-second lock waits and bounded pool admission constrain work. The exact window
limit is 100,000 logs; excess windows fail with recovery guidance instead of partial
totals. At most 168 series buckets and ten paths bound responses. Shutdown rejects
new work and drains admitted queries. High-volume rollups/backfill/coverage remain
required; recorded logs do not establish billing or complete telemetry accounting.

The accessible ivory/mint/indigo panel provides status/rate/latency cards, request
trend, keyboard interval inspection, top paths, period selection, manual refresh,
loading/empty/stale/retry feedback and workspace-safe selection. Native dialogs
retain keyboard containment, Escape and focus restoration; list refresh stays at
30 seconds and one-time key/CRUD workflows remain covered.

Development verification: 1,157 retained tests (559 gateway, 489 admin API,
99 control plane, 10 dashboard). Real PostgreSQL cases cover non-UTC sessions,
microsecond UTC boundaries, exact percentiles/rates, tenant guards, revoked/empty
consumers, the exact 100,000-row limit and a 100,001-row rejection, top-path bounds,
actual slow-statement cancellation, lock timeouts and recovery. Admission/shutdown
unit checks cover real owned promises and slot release. All five projects' static
gates and four application builds pass. Production browser checks pass 42 cold
loads under sixfold CPU throttling, followed by a final seven-load run, with zero
runtime errors/accessibility findings. They cover desktop/mobile usage, exact
keyboard interval inspection, failed/empty/stale recovery, tiny nonzero rates,
workspace changes and retained key/CRUD flows. The first expanded fixture run
failed on its tenant-ID bookkeeping assertion (zero runtime errors); the fixture
now extracts the UUID from the tenant path segment correctly. Failure diagnostics
remain in `.local-work/issue74-first-browser-failure/`; the runtime gate stays strict.

Evidence: `.local-work/issue74-regression-tests.log`, `issue74-final-admin-tests.log`,
`issue74-final-static.log`, `issue74-final-admin-ui-static.log`,
`issue74-backend-builds.log`, `issue74-final-admin-build.log`,
`issue74-final-browser.log`, `issue74-final-default-browser.log`,
`issue74-final-copy-browser.log`,
`issue74-six-pass-browser/` and `dashboard-verification/` (metadata, screenshots
and traces). `.local-work/issue74-runtime.log` and
`issue74-runtime-evidence.json` verify the packaged admin image on OrbStack: a real
consumer key produces exactly 20 attributed requests, ten server errors, 60 buckets
and P95 15.3 ms matching persisted durations. Session/workspace guards and filtered
metric history pass. Retained live metrics and three-format alert firing/retry/
recovery pass (local firing acceptance 60.103 seconds); two private automatic
RustFS archives contain all 95 records, including the late log. All three services
exit 0 within their shutdown grace, and only fixture-owned infrastructure is removed.
Issue #69 remains open; successful browser reruns do not establish its root cause.

## Consumer attribution correction — issue #76

A regression reproduces arbitrary signed JWT subjects being copied into the UUID
consumer column: gateway logging incorrectly emits the principal as `consumerId`,
and actual PostgreSQL rejects the entire mixed batch. The red evidence is retained
in `.local-work/issue76-attribution-red-gateway.log` and
`issue76-attribution-red-ingestion.log`.

The correction preserves authentication identity and captures separate registered
consumer attribution at authentication time, for configured consumer keys and
signed subjects matching a configured consumer. Unknown principals remain under
the existing authentication policy without consumer attribution. Captured IDs
remain stable through configuration replacement and are canonicalized before
logging. Control-plane ingestion also normalizes legacy malformed attribution to
unassigned records, preserving the batch and database-owned receipt behavior.

Targeted green checks pass 16 gateway tests and 66 ingestion/control-plane tests,
including actual modern/legacy PostgreSQL schemas. All five projects' lint/typecheck
checks pass. The full regression run passes 1,163 tests (564 gateway, 489 admin,
100 control plane, 10 dashboard), and all three backend applications build. The
gateway/control-plane production images have been rebuilt on OrbStack. The packaged
runtime passes mapped JWTs, unrelated signed principals and an authenticated legacy
frame containing malformed consumer attribution. Consumer usage reports exactly
21 requests (20 actual keys plus one mapped JWT), ten server errors and P95 12 ms
matching PostgreSQL. The unrelated principal stays authenticated with an unassigned
log; the legacy frame is retained and its forged receipt remains ignored.

Retained metrics, three-format alerts and RustFS automation pass: local firing
acceptance takes 59.771 seconds and two private archives contain all 97 persisted
records. All services exit 0 within their shutdown grace; fixture resources are
removed. Evidence: `issue76-attribution-green-gateway.log`,
`issue76-attribution-green-ingestion.log`, `issue76-static.log`,
`issue76-regression-tests.log`, `issue76-backend-builds.log`, `issue76-runtime.log`
and the preserved `issue76-runtime-evidence.json` in `.local-work/`. No UI behavior
changes; issue #74 browser evidence remains applicable. High-volume rollups/privacy
and the full formal campaign remain pending.

## Tenant request-log privacy — issue #78

Delivered through [PR #79](https://github.com/mayank-rawat98/NovaGate/pull/79).
Issue-linked branch `78-tenant-log-privacy` starts from merged `dev` at **65a6b7c8**.
This checkpoint adds conservative tenant IP/user-agent defaults, explicit retention,
gateway observation-only redaction, collector enforcement for older frames and current
historical read projection. Request security inputs and consumer/trace correlation remain
intact. Shared contracts feed typed API-client methods and a mint/ivory Settings panel.

Authenticated saves require the current UUID revision. Policy changes, durable config
version/outbox, archive revocation and historical erasure scheduling commit atomically.
Bounded outbox retries recover a committed update without another edit/reconnect; gateway
ACK remains the completion signal. Saves survive a failed initial publication without
misleading failure feedback. Invalid payloads and stale writes are rejected.

Historical cleanup uses persisted 500-row cursors, revision/receipt locks, fair bounded
sweeps and explicit pending/retrying/complete status. A restarted worker resumes progress;
a failed tenant does not block healthy cleanup. Retaining an omitted field is blocked until
erasure completes, and erased values cannot be restored. New manual/scheduled archives
snapshot privacy, changed policies revoke old leases/jobs and existing private cleanup
removes their objects. Active downloads have finite admission/deadlines and recheck
eligibility; disconnect/shutdown cancel owned streams. Old copies cannot be recalled.

Raw-log age retention is now implemented in issue #80. Broader sensitive-field rules, external destination credentials and
providers, storage encryption/restore drills and formal acceptance remain outstanding.
Updated gateway binaries are required for local-output enforcement. Admin migrations must
precede the new collector; storage outages defer physical removal while download revocation
remains effective.

Verification: **1,183 tests** (gateway 573, admin 499, control plane 101, dashboard 10),
all five projects' lint/typecheck gates and all four application builds pass. A real
PostgreSQL race first reproduces a privacy-save timeout against archive admission;
`FOR NO KEY UPDATE` fixes it while preserving tenant serialization and expiring the
admitted archive. The privacy tests also cover 1,201-row historical/NDJSON paging,
revision/no-op behavior, stalled-download revocation/admission, fair retry and restart.
A real Redis retry recovers a committed config without another edit/reconnect.

Production browser verification passes **42 cold loads under sixfold CPU throttling**,
44,587 ms, with zero runtime errors/accessibility findings. It includes failed reads,
saves/revisions, retained selections, focus/Tab/Escape, workspace resets and privacy
controls when archive storage is disabled. Issue #69 remains open.

Fresh packaged OrbStack gateway/admin/control-plane images verify explicit retain→omit
policy updates and gateway ACK, two real consumer-authenticated privacy requests,
historical erasure and blocked old downloads. Retained metrics reach SSE within two
seconds; local alert firing acceptance takes **59.191 seconds**, retry/recovery pass,
and two private scheduled archives contain **96 records** including the older frame.
Consumer usage reports 21 requests/ten server errors with P95 matching PostgreSQL.
All three services exit 0 within the shutdown grace; fixture containers/network are
removed and persistent verification infrastructure is preserved.

Evidence in `.local-work/`: `issue78-ready-static.log`, `issue78-ready-admin-tests.log`,
`issue78-final-regression.log`, `issue78-ready-builds.log`, `issue78-admission-red.log`,
`issue78-admission-green.log`, `issue78-expanded-browser.log`, `issue78-browser-run.json`,
`issue78-final-runtime.log` and the preserved `issue78-runtime-evidence.json`.
An unchanged alert test hit its five-second Jest limit during simultaneous image builds;
the final full suite passes without increasing it. Packaged fixture diagnostics also
retain the intentional gateway-replacement/ephemeral-port failures; the verifier now
restores its own gateway connection and refreshes the published port before live policy
checks. Production connection-admission rules are preserved.

## Tenant raw-log retention — issue #80

[PR #81](https://github.com/mayank-rawat98/NovaGate/pull/81) delivers
`80-tenant-log-retention`, linked to
[issue #80](https://github.com/mayank-rawat98/NovaGate/issues/80), from dev **c40a7692**.
It merged into `dev` as **ccb91854**; issue #80 is closed.
The default database request-log lifetime is 30 days, tenant-selectable from 1–90.
Trusted database receipt and fixed 24-hour days determine age independently of session
time zones and daylight-saving transitions; original request timestamps and security/
consumer/trace correlation remain intact. Current reads, consumer usage and archive
sources exclude expired receipts immediately, even before deletion finishes.

Revision-aware settings persist an irreversible cutoff floor. Shrinking and increasing
the lifetime cannot resurrect expired records, and no-op saves preserve revisions/jobs.
Changes revoke existing archive leases/downloads and use the existing private RustFS
cleanup. Queued jobs record the actual processing cutoff; completed archives retain a
separate download lifetime. Schedules fast-forward fully expired backlog in one bounded
write, preserve partial windows and report windows outside retained coverage.

Cleanup uses fair 500-row transactions, at most eight per two-second sweep, durable
pending/retry/check state, replica coordination, receipt locks and SQL/lock deadlines.
Tests prove restart progress beyond 4,000 rows, failure isolation, blocked-row retry
without false completion and archive foreign-key admission compatibility. Unknown
legacy archive coverage is revoked once; repeated upgrades preserve proven new jobs.

The ivory/indigo Settings panel exposes the lifetime, earliest retained receipt,
irreversible removal, cleanup status and separate archive TTL. Failed writes and
revision reload preserve selections; native dialogs retain focus/Escape/Tab behavior,
workspace changes clear unsaved state and requests cancel on close. Raw-log settings
remain available without object storage. Logs, usage and archives explain retained
coverage; broader field redaction and external destinations remain separate work.

Current verification passes **1,207 tests** (gateway 573, admin 523, control plane 101,
dashboard 10): the full unchanged-project regression plus a final admin suite after blocked-row, upgrade and daylight-saving
retention cases. All five static gates and four application builds pass.
The production browser run passes 42 cold loads with sixfold CPU throttling in 45,301 ms
with zero runtime or accessibility findings. Its additional retention checks cover
read/save/revision recovery, input preservation, focus/Tab/Escape, workspace reset and
disabled storage. Fresh packaged OrbStack verification also passes: immediate filtering,
shrink/increase non-resurrection, private archive revocation, fresh receipt preservation
for late request timestamps and durable removal of two expired receipts. Cleanup returns
healthy. Retained consumer usage matches 21 requests, ten server errors and P95 11 ms;
two private scheduled archives contain 96 rows including a late request. Local alert
firing acceptance takes 59.603 seconds, and all three services shut down with exit 0.

Verified packaged images: gateway `d41f3815614a`, admin `abda96f1876e`,
control plane `ee34c2bc7cdc`; full hashes and measurements remain in the runtime artifact.

Ignored evidence: `issue80-expanded-tests.log`, `issue80-regression.log`,
`issue80-utc-tests.log`, `issue80-precision-final-tests.log`, `issue80-final-static.log`,
`issue80-ready-admin-gates.log`, `issue80-all-builds.log`, `issue80-browser-second.log`,
`issue80-browser-run.json`, `issue80-runtime-final.log` and
`issue80-runtime-evidence.json`. The first browser run preserves an outdated schedule
wording assertion; the corrected verifier checks retained-coverage warnings without
relaxing its gates. Issue #69 remains open, and no formal phase acceptance is claimed.

## Elapsed-day telemetry lifetimes — issue #82

[PR #83](https://github.com/mayank-rawat98/NovaGate/pull/83) delivers
[issue #82](https://github.com/mayank-rawat98/NovaGate/issues/82) on the linked
`82-elapsed-utc-retention` branch, from merged dev **ccb91854**. PostgreSQL calendar-day
intervals previously shifted trace/metric retention, alert history/delivery cutoffs
and archive lifetimes by an hour at daylight-saving transitions. Their SQL now uses
fixed elapsed 24-hour days, matching JavaScript validation and raw-log retention.
Trace/metric ingestion and idle deletion, trace detail, alert read/delivery/history
cleanup and manual/scheduled archive expiry/history cleanup follow this rule.
Independent configured lifetimes and existing persisted archive expiry timestamps
are preserved. No new migration, public API or dashboard interaction is required.

New real-PostgreSQL service regressions substitute only the database clock and run
unchanged production predicates/locks/transactions in UTC, America/New_York and
Asia/Kolkata at both spring/autumn transitions. The 42 tests prove inclusive
microsecond boundaries, idle and active deletion, expired-delivery cancellation
before transport, queue/history cleanup and exact seven-day archive lifetimes.
Captured pre-fix evidence has **14 daylight-saving failures** and 28 passes; the
fixed feature suite passes all 42. Full regression passes **1,249 tests** (gateway
573, admin 553, control plane 113, dashboard 10). Affected admin/control-plane
lint/typecheck/build gates pass. Fresh packaged OrbStack verification also passes:
real gateway completions, PostgreSQL persistence, tenant authorization, Redis/SSE
delivery/reconnect, local alert retry/recovery, scheduled private RustFS exports,
consumer attribution, privacy policy ACK/erasure/revocation and irreversible raw-log
expiry/cleanup. Two private automatic archives contain 96 rows including a late
request; usage matches PostgreSQL at 21 requests, ten server errors and P95 22 ms.
Local alert firing acceptance takes 59.419 seconds. All three services stop with
exit 0 and disposable runtime resources are removed. Packaged images: gateway
`d41f3815614a`, admin `13a3ec346ba5`, control plane `7bb64fc085fd`; full hashes
and measurements remain in the runtime artifact.

The initial extra affected-project run passed all assertions but exceeded the new
fixture’s five-second database-drop hook during concurrent container startup.
The failure is preserved; the separate final affected-project run passes all
666 backend tests without increasing any timeout or weakening service gates.

Ignored evidence: `issue82-dst-red.log`, `issue82-dst-green.log`,
`issue82-regression.log`, `issue82-affected-gates.log`, `issue82-affected-tests.log`,
`issue82-affected-tests-final.log`, `issue82-runtime.log` and
`issue82-runtime-evidence.json`. Formal phase acceptance
and the full remaining roadmap stay open.

## Sensitive request-log metadata — issue #84 / PR #86

[Issue #84](https://github.com/mayank-rawat98/NovaGate/issues/84) extends the existing
privacy policy to paths, service names, request IDs, consumer attribution, trace IDs
and span IDs through [PR #86](https://github.com/mayank-rawat98/NovaGate/pull/86). Its linked branch starts from `dev` at **7047b247** / merged PR #83.
Legacy two-field policies and empty selections remain compatible; strict validation
canonicalizes selections, while malformed explicit selections fail closed. Primary
log identity, receipts, method, status, timings and live security/wire inputs remain
intact. Gateway start/finish union, collector enforcement, current historical reads,
archive snapshots/revocation and bounded irreversible erasure share the policy.
JWT rejection diagnostics no longer copy raw URLs/query strings or bypass IP privacy.

Path/consumer filters and usage operate on the current privacy projection while
physical erasure is pending. Hidden paths retain totals with redacted groups; hidden
consumer IDs produce zero observed attribution, explicitly distinguished from no
traffic in the dashboard. Usage carries privacy coverage and rechecks both policy
revisions outside its bounded snapshot. Real PostgreSQL/RustFS checks exercise 601
historical rows, immediate projection, two manual and two automatic filtered archive
paths, revocation, durable erasure and non-resurrection after later relaxation.
Settings adds six labelled checkboxes with native mobile dialogs, failed-save and
revision-input preservation, workspace reset and clear consequences for correlation.

The required final affected-project verification passes **1,263 regression tests** (gateway 584, admin 555, control plane
114, dashboard 10). All five projects' lint/typecheck gates and four application
builds pass after correcting new integration response typings. Final focused real
PostgreSQL/RustFS archive checks pass **19 tests** with unchanged deadlines.
Production browser checks pass **42 cold loads at sixfold CPU throttling** in
44,905 ms, followed by a seven-load visual/functional run in 44,146 ms. Both have
zero runtime or accessibility findings; the mobile metadata dialog was inspected.
These successful sweeps do not resolve intermittent hydration issue #69.

Fresh OrbStack production images prove policy ACK, preserved wire request IDs,
metadata-minimized local JSON output, immediate persisted-record enforcement,
historical cleanup, zero consumer attribution after erasure and **104 masked NDJSON
records** in an actual private RustFS download. Existing metrics/SSE/reconnect,
JWT/legacy attribution, raw-log shrink/increase non-resurrection and alert delivery
also pass. Before metadata erasure, consumer usage matches PostgreSQL at 21 requests,
ten server errors and P95 12 ms; two automatic archives contain 97 rows including a
late request. Local alert firing acceptance takes **60.094 seconds**, with six
accepted deliveries. Gateway/admin/collector all stop with exit 0 and disposable
runtime resources are removed. Images: gateway `477927fc9327`, admin `ea9ba6b732d8`,
collector `e1451f66e048`; full hashes remain in the runtime artifact.

An extra archive run during concurrent OrbStack image import timed out in a storage
request and its cleanup hook. The installed SDK warned after its configured deadline
without rejecting the request. The failed process was explicitly stopped, its exact
fixture database removed and the verification storage confirmed empty. The separate
final archive run passes all 19 tests without increasing deadlines; Nx still reports
the prior failure as flaky. [Issue #85](https://github.com/mayank-rawat98/NovaGate/issues/85)
addresses rejecting storage deadlines and failure-path resource cleanup in the
checkpoint below. No storage reliability fix or full phase acceptance is claimed by #84.

Ignored evidence: `issue84-full-tests.log`, `issue84-affected-tests-final.log`,
`issue84-full-gates.log`,
`issue84-admin-gates-final.log`, `issue84-admin-final-static.log`,
`issue84-archive-schedule-final.log`, `issue84-archive-schedule-green.log`,
`issue84-cleanup.log`, `issue84-browser.log`, `issue84-browser-run.json`,
`issue84-browser-visual.log`, `issue84-browser-visual-run.json`,
`dashboard-verification/log-privacy-mobile.png`, `issue84-runtime.log` and
`issue84-runtime-evidence.json`. Evidence supports this issue's implementation;
external destination delivery, scalable rollups, phases 5–6 and formal acceptance
remain open below.

## Storage deadlines and shutdown — issue #85 / PR #87

[Issue #85](https://github.com/mayank-rawat98/NovaGate/issues/85) /
[PR #87](https://github.com/mayank-rawat98/NovaGate/pull/87) fixes the stalled request
observed during #84. Its linked branch starts from `dev` at **2affcb71**.
The installed SDK's configured request timeout warned without rejecting. A new real
local HTTP fixture reproduces the original defect: startup remained open after
18 seconds, and the pre-fix test fails with `still-open` rather than `rejected`.

Storage commands and download admission now have a 15-second absolute budget across
signing, connection acquisition, SDK attempts and backoff. The upload helper does not
forward its abort controller to internal sends; its single/multipart transfer,
completion and abort cleanup now also use the bounded wrapper. Best-effort abort
cleanup remains possible after caller cancellation, while application shutdown
cancels all sends. The underlying handler
also rejects transport timeouts; fast transient failures can still use three
attempts. Uploads retain the worker's existing two-minute deadline/cancellation and
rejecting per-request limits. Whole-prefix object/multipart cleanup has a two-minute
budget. Shutdown aborts storage work, destroys owned response streams and cancels
worker cleanup before waiting. Failed deletion keeps durable retry state. Fixture
teardown attempts app/client/database release after storage errors and preserves all
failures instead of skipping later cleanup.

All **567 admin tests** pass in the final required affected-project run. Preceding
backend regressions also pass. Eleven new actual HTTP/SDK checks cover the rejecting deadline,
five operation shutdown paths, actual multipart sockets without background retries,
worker and caller cleanup cancellation, owned response streams and rejection of work
after shutdown. Twenty real archive tests include an object larger than 5 MiB, exact
streamed SHA-256 integrity, no remaining multipart upload and successful deletion. The worker-coordination test
uses controlled SQL responses; real PostgreSQL/RustFS archive regressions retain
coverage of policy/ACL refusal, durable deletion retry, metadata redaction,
revocation, receipt scheduling and retention. Admin lint/typecheck/build pass.
No production timeout or existing test deadline was increased. No new environment
setting, dependency, schema or dashboard source change is needed.

Fresh OrbStack production verification with rebuilt admin image `2107e8a81633`
passes metrics/SSE/reconnect, consumer/JWT/legacy attribution, signed local alert
retry/recovery, automatic private archives, metadata privacy and irreversible raw-log
retention. Two automatic archives contain **96 rows** including a late request;
the later metadata-redacted download contains **103 records**. Before metadata
erasure, usage matches PostgreSQL at 21 requests, ten server errors and P95 16 ms.
Local alert firing acceptance takes **59.638 seconds**, with six accepted deliveries.
Gateway, collector and admin all stop with exit 0; disposable runtime resources are
removed. Unchanged gateway `477927fc9327` and collector `e1451f66e048` images retain
the #84 source checkpoint; full hashes are in the runtime artifact. Existing #84
production browser evidence remains applicable to the unchanged dashboard.

Ignored evidence: `issue85-deadline-red.log`, `issue85-storage-green.log`,
`issue85-admin-regression.log`, `issue85-affected-tests-final.log`,
`issue85-first-gates.log`, `issue85-expanded-static.log`, `issue85-final-static.log`,
`issue85-docker-admin.log`, `issue85-runtime.log` and
`issue85-runtime-evidence.json`, `issue85-multipart-green.log`,
`issue85-transfer-final-tests.log`, `issue85-transfer-final-gates.log`,
`issue85-roundtrip-green.log`, `issue85-roundtrip-final-static.log`,
`issue85-complete-affected-tests.log`, `issue85-transfer-docker-admin.log`,
`issue85-transfer-runtime.log` and `issue85-final-runtime-evidence.json`. This closes the identified storage deadline defect,
not phase 4 or full-roadmap acceptance. External destination delivery, scalable
rollups, later phases and formal acceptance remain open below.

## Remaining work

### Next: continue phase 4; retain hydration follow-up #69

- Reproduce the intermittent server/session hydration recovery, identify the DOM/state
  mismatch and fix its source. Keep strict browser error gates and record a regression
  that demonstrates the failure before the fix. Successful reruns alone do not close it.
- Continue later work through the issue → dev branch → tested PR → merge convention.
- Provider/inbox acceptance and at-least-once receiver/provider deduplication remain
  explicit formal acceptance requirements, not locally proven provider guarantees.

### Remaining phase 4 work

- Configurable external S3-compatible tenant destinations, webhook NDJSON and Datadog
  exporters, with encrypted rotatable private credentials, destination payload policies
  and delivery history. Issue #84 implements stored-metadata field selection.
- High-volume per-consumer rollups, idempotent ingestion/backfill, retention and
  explicit coverage indicators beyond the bounded persisted-log usage view.
- Formal acceptance for tracing, two-second live metrics, 90-second actual alert delivery,
  private RustFS export and consumer analytics.

### Phase 5 — developer ecosystem

- Declarative YAML import/export, validated preview/diff, atomic reconciliation and drift handling.
- `gwx` CLI using scoped authentication and the actual admin API.
- Developer portal with route catalog, scoped self-service keys and private usage views.
- Terraform provider, tests and resources inside this repository.
- Plugin SDK/third-party loading with explicit trust, compatibility and resource limits.
- External downstream instrumentation/OTLP interoperability for third-party observability.

### Phase 6 — beyond Kong roadmap

- Anomaly detection and automatic delivered alerts.
- Circuit breakers with measured opening/recovery behavior.
- Multi-region control-plane failover, durable configuration and observability attribution
  across multiple gateways/regions; current alert aggregation rejects ambiguous overlap.
- Usage quotas, billing metering and threshold UX.
- Kubernetes controller/CRD reconciliation inside this repository.
- WASM sandbox, resource limits and isolation checks.
- GraphQL federation with subgraph failure and query-budget behavior.

### Additional requirements and final acceptance

- Team RBAC, scoped automation tokens and immutable audit history.
- Configuration preview/diff/rollback, drift detection, atomic reconciliation and
  verified last-known-good routing during control-plane outages.
- Complete destination-specific payload/secret-management controls and storage
  encryption where supported, backup/restore drills and operational recovery.
  Stored request-log IP/user-agent and metadata privacy are implemented in #78/#84;
  bodies/arbitrary headers are not collected by this log product.
- AI token/cost budgets, provider fallback, sensitive-data handling and MCP policy controls.
- Continue modern accessible dashboard UX for every new capability; mobile, keyboard,
  reduced-motion, contrast and real-user usability verification.
- Recheck all phases 0–3 acceptance gaps, including external Auth0/provider behavior,
  protocol conformance and production upgrade compatibility.
- Reproducible NovaGate/Kong benchmarks, security/chaos testing and regional failover drills.
- Run the formal all-phase acceptance campaign after implementation, preserve evidence
  for every exit criterion, and use a separate release gate before any production deployment.
