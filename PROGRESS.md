# NovaGate progress and remaining work

Updated: **25 October 2026** (Asia/Calcutta).

This report distinguishes merged development work, the alerting foundation checkpoint,
and formal acceptance. The detailed roadmap is [implementation.md](implementation.md).
No whole phase or production release is declared complete by this report.

## Current checkpoint

- [Issue #113](https://github.com/mayank-rawat98/NovaGate/issues/113) adds phase 5.5: operator-pinned third-party plugins loaded from npm packages, `libs/plugin-sdk`, a workspace kill switch, gateway status reports through the control plane, and dashboard/route-editor support. A real-process run installs packed tarballs with npm. It checks that hooks fire on live traffic and that an uninstalled package fails closed. Timer and unhandled-rejection crashes quarantine the plugin while the gateway keeps serving, and the kill switch reaches the gateway. Verified on Node 26.11.1 with local PostgreSQL 16 and Redis 7: **878 admin tests** (21 RustFS-dependent skipped; no container runtime), **132 control-plane**, **598/599 gateway** (the remaining test needs IPv6, which this container lacks), 4 SDK, 10 dashboard, 5 portal and 35 CLI tests. Lint/typecheck pass, as do both production browser smokes with zero WCAG/runtime findings and the portal → gateway end-to-end run. See the section below.
- [Issue #111](https://github.com/mayank-rawat98/NovaGate/issues/111) adds the phase 5.4 Terraform provider: `novagate_service`, `novagate_route`, `novagate_consumer` and `novagate_alert_rule`, with import support, plus `novagate_tenant` and `novagate_consumer` data sources. Acceptance runs the real Terraform 1.16.7 CLI against the real admin API on PostgreSQL. It covers create, in-place update, clearing, import of every resource, scope denial and destroy, and SQL confirms the soft deletes. See the section below.

- [Issue #109](https://github.com/mayank-rawat98/NovaGate/issues/109) implements the phase 5.3 developer portal: a separate Next.js app, public catalog/developer APIs, self-service keys and usage, workspace Settings and route-editor publication. A real-process end-to-end run (admin API, control plane, gateway and portal on local PostgreSQL/Redis, driven by Chromium) registers a developer, confirms the email, creates a key, makes five gateway calls, sees those five recorded requests in the portal and revokes the key, after which the gateway refuses it. It also fixes the gateway rate-limit plugin ignoring its configured window. See the section below.

- [Issue #107](https://github.com/mayank-rawat98/NovaGate/issues/107) adds scoped, expiring, revocable automation tokens for the CLI, Terraform and CI. Only SHA-256 digests are stored; secrets are shown once. Endpoints accept tokens only when they declare a scope (default deny), and token management stays session-only. Verified on Node 26.11.1 with local PostgreSQL 16: **857 admin tests** pass (28 RustFS/S3-dependent tests skipped because this environment has no container runtime), **35 built CLI tests**, 10 dashboard tests, lint/typecheck for the four touched projects, and the full production browser smoke including the new panel, with zero runtime/WCAG findings. Packaged images were not rebuilt in this environment. See the section below.

- [Issue #105](https://github.com/mayank-rawat98/NovaGate/issues/105) / [PR #106](https://github.com/mayank-rawat98/NovaGate/pull/106) finishes the preserved private `gwx` CLI and authenticated live request logs. Current checks pass **862 admin tests / 48 suites**, including 15 real HTTP/PostgreSQL stream cases, and **27 built CLI tests on both Node 26 and Node 24**, with no failures or skips. Six-project static checks, five production builds, real POSIX terminal checks and four rebuilt guarded non-root images pass. The cleanup disposition covers all 85 original source paths: 19 already merged, four stale/unnecessary changes omitted and 62 useful changes reconciled through PRs #104 and #106. Scoped/revocable automation, public CLI distribution and formal phase acceptance remain open. Main remains reserved for final acceptance.

- [Issue #103](https://github.com/mayank-rawat98/NovaGate/issues/103) / [PR #104](https://github.com/mayank-rawat98/NovaGate/pull/104) adds reviewed complete YAML/JSON import/export and Settings controls with atomic durable reconciliation. Current Node 26.11.1 validation passes **1,558 tests with no failures or skips**, five-project static checks, four app builds, four fresh guarded non-root images and **42 production browser cold loads at sixfold CPU throttling** with zero runtime/accessibility findings. The packaged pipeline proves actual gateway ACK, key routing, restart and idempotent export roundtrip while preserving telemetry/archives/alerts/privacy/rollups; all three services exit 0. The original pending files are preserved; issue #105 / PR #106 records the CLI/log-stream reconciliation and final cleanup disposition. Main remains reserved for final acceptance.

- [Issue #99](https://github.com/mayank-rawat98/NovaGate/issues/99) / [PR #100](https://github.com/mayank-rawat98/NovaGate/pull/100) implements bounded count/latency/path rollups for larger consumer usage windows. Exact retained counts, global top-path ranking, histogram upper estimates and materialization coverage preserve current privacy/receipt retention. The isolated Node 26.11.1 branch passes **1,535 tests with no failures or skips**, all five projects' lint/typecheck/build checks, **42 production browser cold loads at sixfold CPU throttling plus seven final loads**, and four fresh non-root images. Automatic production timers materialize **200,001 records in 108.629 seconds**; two replicas materialize **400,001 observations / 20,000 path cells in 111.202 seconds**, with exact reference results, replay/restart/admission recovery and automatic privacy cleanup in **101.230 seconds**. Retained traffic, metrics, private archives, alerts and export scheduler/capacity checks pass with clean shutdown. Broader workload/traffic/provider, comparative and formal phase/release acceptance remain open. A recurring dependency extraction failure is tracked separately in [issue #101](https://github.com/mayank-rawat98/NovaGate/issues/101). This PR targets dev; main remains reserved for the completed roadmap and final acceptance.

- [Issue #95](https://github.com/mayank-rawat98/NovaGate/issues/95) / [PR #96](https://github.com/mayank-rawat98/NovaGate/pull/96) is merged into dev at `e8886267`, integrating dev `219f2a28` after the runtime correction in PR #98. The combined Node 26.11.1 checkout passes **1,492 tests** (782 admin / 42 suites, 586 gateway / 38 suites, 114 collector / 7 suites, 10 dashboard / 3 suites), with zero skipped tests and no intermediate-mTLS failure. Five projects' lint/typecheck/build checks and **42 production browser cold loads under sixfold CPU throttling** pass with zero runtime/accessibility findings. Fresh admin/dashboard images run as UID 1000; dashboard login and all 16 referenced assets return HTTP 200 with clean shutdown. Gateway and collector reuse PR #98's verified images: both compiled production bundles match byte-for-byte and their production dependency manifests are unchanged. Node 26 packaged transports pass all provider formats and shutdown. Automatic timers deliver 73 batches across two tenants/seven destinations with no manual ticks (2.102 seconds to the first healthy pass, maximum four processing and twenty pending batches). The 1,101-window capacity run retains 1,000 caller and 1,000 scheduled identities, records exactly 101 compacted scheduled batches/records and keeps no terminal payloads; it completes in 22.905 seconds. The full service pipeline passes real traffic, metrics/SSE/history, private archives, alerts, privacy/retention, authenticated delivery activation/history, immutable signed retries and revocation; all three services exit 0. Alert firing acceptance takes 56.410 seconds. Formal actual-provider/inbox, workload/replica, comparative and release acceptance remain open. Consumer rollups are implemented and verified separately in issue #99; declarative configuration and the CLI remain separate local work. This change targets dev; main stays reserved until everything is implemented and accepted.

- Runtime compatibility [issue #97](https://github.com/mayank-rawat98/NovaGate/issues/97) / [PR #98](https://github.com/mayank-rawat98/NovaGate/pull/98) pins Node **26.11.1** for local/CI checks and all four application images. Node 24.21.0 reproduces the native intermediate-client chain failure plus two real TLS regressions (583/586 gateway tests pass); the unchanged mTLS plugin passes all 586 on Node 26.11.1. A separate checkout from dev `b182b882` passes **1,361 tests** (651 admin, 586 gateway, 114 collector, 10 dashboard), five projects' lint/typecheck/build gates and 42 production browser cold loads under sixfold CPU throttling, with zero runtime/accessibility findings. The non-root gateway passes 41 packaged HTTP/gRPC/WSS/auth/TLS/config/trace/metrics checks, including intermediate chains and live trust revocation. The verifier now generates explicit CA constraints and confines LibreSSL/OpenSSL serial files to the disposable directory; its initial CA:FALSE startup failure is preserved. Three rebuilt backend images pass actual traffic, metrics/SSE/history, private RustFS archives, alerts, privacy/retention and encrypted export drafts; all three services exit 0. Alert firing acceptance takes 59.050 seconds. All four fresh images run Node 26.11.1 as UID 1000; the dashboard serves login and all 16 referenced assets with HTTP 200 and exits 0. The first dashboard image build retained npm filesystem extraction errors and a zero-byte Next.js module in its cached dependency layer; a fresh install and image build pass without those extraction errors. Node 26.11.1 is **Current, not LTS**; runtime support, provider/comparative acceptance and production release acceptance remain separate. PR #98 is merged into dev at `219f2a28`; main deployment is reserved for the final release.

- Pre-runtime **#95 export delivery** was separated into backend and UI commits
  (`9012b6d`, `798bc53`) with an isolated-source verification record. **782 admin
  tests / 42 suites**, **114 collector tests**, **10 dashboard tests**, five-project
  static/build gates, four production images and **42 browser cold loads** pass.
  Packaged transport, automatic receipt delivery, private archives, alerts,
  privacy/retention and the 1,101-window capacity checks pass with clean shutdowns.
  The retained gateway still has its one native intermediate-mTLS failure; there
  is no full-workspace or formal acceptance claim. Export work is committed;
  review/merge remain pending. Consumer rollups, declarative configuration and
  the CLI remain separate local changes in the shared checkout.

- Pre-merge local issue #95 continuation adds authenticated external delivery activation, payload-policy and metadata-only history controls in Settings. It passes **781 admin tests / 42 suites**, all five projects' lint/typecheck gates, four application builds and **42 cold browser loads under sixfold CPU throttling** with zero runtime/accessibility findings. Browser checks cover explicit activation, stopping without keys, revision/input preservation and cancellation of held reads/writes. Credential saves remain inactive drafts. Scheduled terminal history rolls off with exact workspace coverage while preserving caller identities and active retries. Discovery continues independently of provider latency and claims only scheduled work. Packaged authenticated activation/history, real-timer backlog across two workspaces/seven destinations, and **1,101 real receipt windows** pass alongside provider transport and existing metrics/alerts/RustFS/privacy/retention checks. Larger workload/replica acceptance, actual-provider acceptance and the remaining beyond-Kong roadmap remain open. Work is local and unmerged; the unchanged Node intermediate-mTLS gate prevents claiming full workspace verification.

- Initial local issue #95 checkpoint (subsequent store/worker, receipt-scheduling and capacity checkpoints are recorded below): its existing development branch implements internal bounded S3, signed NDJSON webhook and Datadog transports. The post-reset workspace is restored with Node 24.21.0/npm 11.19.0 and local OrbStack PostgreSQL/Redis/pinned RustFS. All **695 admin tests** pass with real infrastructure, including 43 new controlled-receiver cases and one real S3 round trip. The dedicated non-root production image smoke passes all provider formats, privacy and shutdown. Five-project static/four-app build gates pass, and final admin/shared static checks include the verification fixture. This is unmerged local work, not phase acceptance. The unchanged gateway mTLS intermediate-chain test fails on this runtime and blocks a claim of full workspace verification; native diagnostics independently reproduce a verified socket lacking detailed issuer metadata. At this initial checkpoint, drafts remained inactive and durable workers/history/activation and the original beyond-Kong roadmap were pending.

- Current [issue #92](https://github.com/mayank-rawat98/NovaGate/issues/92) fixes retention integration case ownership from merged `dev` **a3597969** / PR #93. An actual child Jest/PostgreSQL regression proves a timed-out body contaminates the following case without draining; with ownership tracking, the intentional timeout still fails while the next case passes. The 30 exact elapsed-time boundary cases retain their five-second budgets and assertions. All **1,359 tests** pass (651 admin, 584 gateway, 114 control-plane, 10 dashboard), all five static gates pass, and the admin build matches the prior production compilation. The final committed-source affected run passes all 651 admin tests; [PR #94](https://github.com/mayank-rawat98/NovaGate/pull/94) closes #92. Formal acceptance remains separate.

- Previous verified development checkpoint: [issue #91](https://github.com/mayank-rawat98/NovaGate/issues/91) adds modern Settings controls for encrypted export destination drafts from `dev` at **c4c03406** / merged PR #89. Production browser verification passes 42 cold loads under sixfold CPU throttling, all provider form/revision/availability/capacity flows and interrupted-save/workspace-reset checks, with zero runtime or WCAG A/AA findings. A first run caught failed focus restoration after a saved re-encryption; the source was fixed and the strict assertion remains. Five projects’ lint/typecheck, four application builds, 650 admin tests in a quiescent rerun and the retained 584 gateway/114 control-plane/10 dashboard regressions pass. The final committed-source affected run passes all 660 admin/dashboard tests; [PR #93](https://github.com/mayank-rawat98/NovaGate/pull/93) records the checkpoint and closes #91. Drafts do not deliver logs; #69 hydration, #90 RustFS cleanup and #92 retention fixture deadline/contamination remain open.

- Previous verified development checkpoint: [PR #89](https://github.com/mayank-rawat98/NovaGate/pull/89), linked to [issue #88](https://github.com/mayank-rawat98/NovaGate/issues/88), adds secure external destination draft configuration from `dev` at **0c1f6dce** / merged PR #87. All 1,358 workspace tests pass (650 admin, 584 gateway, 114 control-plane, 10 dashboard), alongside five projects' lint/typecheck and four app builds. The final focused suite passes 82 checks, including real HTTP/PostgreSQL key retirement, contended updates and capacity across two independent service instances. The final committed-head affected run and packaged OrbStack verification pass. The packaged image proves encrypted draft storage/reads, tenant isolation, revisions, key rewrap/removal and retained metrics/alerts/RustFS/privacy/retention; all three app services exit 0. An earlier RustFS fixture teardown failure is preserved and tracked separately in issue #90. At that checkpoint, provider delivery and Settings controls remained pending; issue #91 implements the editor. Drafts remain explicitly inactive.

- Previous verified development checkpoint: [PR #87](https://github.com/mayank-rawat98/NovaGate/pull/87), linked to [issue #85](https://github.com/mayank-rawat98/NovaGate/issues/85), fixes non-rejecting storage timeouts and shutdown/resource cleanup. Its branch starts from `dev` at **2affcb71** / merged [PR #86](https://github.com/mayank-rawat98/NovaGate/pull/86), which implements six-field stored-metadata privacy. The final affected-project run passes 568 admin tests, including twelve actual stalled-network checks and a real multipart RustFS round trip; backend static/build gates and fresh packaged OrbStack/RustFS/metrics/alerts/privacy/retention verification pass. The unchanged gateway/collector/dashboard retain issue #84's 1,263-test and 42-plus-seven-load browser checkpoint. Formal phase acceptance remains pending.
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

All **568 admin tests** pass in the final required affected-project run. Preceding
backend regressions also pass. Twelve new actual HTTP/SDK checks cover rejecting deadlines before headers and during metadata body decoding,
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
`issue85-transfer-runtime.log`, `issue85-final-runtime-evidence.json`,
`issue85-response-body-green.log`, `issue85-body-final-static.log` and
`issue85-body-complete-affected.log`. This closes the identified storage deadline defect,
not phase 4 or full-roadmap acceptance. External destination delivery, scalable
rollups, later phases and formal acceptance remain open below.

## Issue #88 — secure external destination configuration

- Added shared contracts for write-only S3-compatible credentials (including session
  tokens), signed NDJSON webhooks and the explicit Datadog site list. Reads return
  only name/type/origin or site, revision/timestamps and credential readability.
- Dedicated four-key AES-256-GCM keyring uses one active write key. Tenant,
  destination, provider type, key identifier and namespace authenticate ciphertext;
  neither alert envelopes nor another tenant/destination/provider can substitute it.
  Credentials never appear in API reads or safe validation errors.
- Tenant-session no-store CRUD and explicit key rewrap enforce exact revisions and
  complete same-provider replacements. Lost/retired keys mark drafts unavailable;
  replacement/removal remains possible. Metadata edits preserve the envelope.
- Ten live drafts per tenant; database advisory admission works across independent
  admin instances. Eight admitted operations per instance, three-second SQL and
  one-second lock budgets bound work. Contention returns 503 without mutation.
  Shutdown drains admitted work and disposes keys. Deletion clears the live
  encrypted credential field while preserving a nonsecret identity tombstone.
- Startup schema creation is idempotent and preserves rotated records. Compose
  forwards the two dedicated encryption settings, with credential writes disabled
  until both are supplied. Added the operator API/rotation guide under log-export.
- Full workspace verification: **1,358 tests**, all five lint/typecheck targets and
  four app builds; final focused checks: **82 tests**. Evidence lives in ignored
  `.local-work/issue88-all-tests.log`, `issue88-all-static.log`,
  `issue88-all-builds.log` and `issue88-focused-final.log`.
- The final committed-head affected run at **444d27f21fb2bd512539d9022721a72479023fa3**
  passes all **1,358 tests** with every suite green. The earlier same-head run passed
  every test case but failed existing archive fixture teardown; its failure is retained
  in `issue88-affected-final.log`. `issue88-affected-quiescent.log` records the passing
  run after image build completion. No production/test deadlines were increased.
- Fresh packaged verification passes in `issue88-runtime.log` and
  `issue88-runtime-evidence.json`, using admin image
  `sha256:8aae883031f28abf0833f8c1f93710ee4d1328168bc808c8296d5b05532d02b4`.
  Actual production HTTP/PG checks prove encrypted S3/webhook/Datadog drafts, safe
  reads, isolation, key rewrap, stale revision rejection and credential removal.
  Retained checks prove two private scheduled archives with 96 records including a
  late log, 21 attributed consumer requests/10 errors/P95 19 ms, six locally accepted
  notifications with firing acceptance at 59.339 seconds, all-six-field privacy ACK,
  preserved wire request ID, a 103-record redacted private archive and raw-log
  expiry/non-resurrection. Gateway/control-plane/admin all exit 0, and disposable
  runtime resources are removed.
- [Issue #90](https://github.com/mayank-rawat98/NovaGate/issues/90) retains the unresolved
  RustFS empty-fixture-bucket inconsistency. Eight owned leftover objects were removed;
  object/version/multipart listings are empty, but DeleteBucket still returns 409.
  Read-only inspection finds orphaned physical files/reserve-delete metadata in that
  exclusive fixture bucket. No storage filesystem deletion or broad prune was used;
  the empty fixture bucket remains for investigation. Passing reruns do not close it.
- External connections are **drafts**, `deliveryAvailable: false`; storing them is not proof of provider
  delivery, a modern Settings editor or phase acceptance.

## Issue #91 — destination Settings editor

- Added typed tenant API helpers and Settings → External export destinations with
  mint/ivory/indigo surfaces, safe summary cards, explicit **Draft · not sending**
  status and independent private archive/schedule controls.
- Native workspace dialogs prepare S3-compatible (including temporary credentials
  and path-style addresses), signed NDJSON webhooks and Datadog site/API-key drafts.
  Access keys, signing/API/session secrets and private webhook URLs are masked;
  saved secrets are never prefilled, cached in SWR summaries or browser persistence.
- Metadata-only rename preserves saved connection details. Credential replacement
  is explicit, complete and same-provider. Key re-encryption/removal require clear
  confirmation. Errors and revision reload preserve typed input for review.
- Missing-key drafts support repair; disabled operator configuration still allows
  rename/removal. Capacity and stale-read/revision failures show recovery controls.
  Reads have a ten-second deadline; writes have a fifteen-second deadline, with
  browser transport cancellation on close/switch. Cancellation does not guarantee
  rollback of a server transaction that has already been admitted.
- Workspace remount clears unsaved credentials. Native Escape/Tab controls and
  explicit focus restoration cover successful edits/rotation and logical focus
  after removal. A first production-browser run failed the post-save focus assertion;
  the UI now restores the initiating control after its cache update, before background
  refresh. The unchanged assertion passes; no runtime/accessibility gates were relaxed.
- Production browser evidence: **42 cold loads**, **sixfold CPU throttling**, six
  hydration passes, **45,402 ms**, zero runtime errors and zero WCAG A/AA findings.
  All provider forms, failed saves/reads, key availability/configuration, metadata
  edits, complete replacement, concurrent revision reload, re-encryption/removal,
  capacity, mobile/desktop and in-flight close/workspace transport cancellation pass.
  Inspected desktop cards and mobile dialogs; the footer remains visible and
  secret inputs are masked. Evidence: `.local-work/issue91-browser-first.log`
  (failing focus check), `issue91-browser-focus.log` (fix),
  `issue91-browser-final.log` and `issue91-browser-final-run.json` (42-load run).
- Final browser evidence with explicit provider/cancellation/focus records passes seven
  more cold loads under sixfold CPU throttling in **47,595 ms**; 11 accepted fixture
  writes exercise all three providers, revision reload, secret-safe reads and two
  interrupted writes. Runtime and WCAG A/AA arrays remain empty. Evidence:
  `.local-work/issue91-browser-evidence.log` and `issue91-browser-evidence-run.json`.
- All five projects’ lint/typecheck and four app builds pass. The complete admin suite
  passes **650 tests** in the quiescent rerun; the retained full run passes **584 gateway,
  114 control-plane and 10 dashboard tests**. Source and test budgets are unchanged.
  Evidence: `.local-work/issue91-all-static.log`, `issue91-all-builds.log`,
  `issue91-retention-quiescent.log` and `issue91-all-tests-restored.log`.
- Preserved failed runs: the first had unavailable PostgreSQL because OrbStack was
  stopped; the verification services were restored and checked healthy. The next
  overlapped builds/browser work and hit the existing five-second retention-boundary
  timeout, followed by extra event IDs in the next case. [Issue #92](https://github.com/mayank-rawat98/NovaGate/issues/92)
  tracks reproduction and fixture/production ownership investigation. A quiescent
  pass does not establish its cause or close it. No assertion/deadline was relaxed.
- [PR #93](https://github.com/mayank-rawat98/NovaGate/pull/93) closes #91. The final affected
  run on source commit **3c6bd0356d7d862cae7c3e6a9c9b8bad2bcf8147** passes all
  **660 admin/dashboard tests** with real PostgreSQL/Redis/RustFS available; the
  unchanged gateway/control-plane retain the 584/114-test full-run checkpoint.
  Evidence: `.local-work/issue91-affected-final.log`. All final commands exit 0.
  The configured administrator exception permits exact-head merging despite the
  one-review ruleset; no ruleset or PR/dev CI trigger is changed.
- External provider delivery, payload policy/history/retention, high-volume rollups,
  later phases and full formal all-phase acceptance remain required. #69/#90/#92
  stay open; passing runs do not close their independent investigations.

## Issue #92 — drain timed-out retention fixtures before reuse

- The original #91 failure is retained: a five-second retention cutoff timeout
  followed by unexpected previous-case event IDs while builds/browser work overlapped.
  A later quiescent pass alone did not prove a fix.
- Installed Jest's runner stops observing a returned promise at its deadline and
  starts `afterEach` without cancelling the underlying body. The prior fixture
  destroyed services and let the next `prepare()` truncate/reuse the same database
  and mutable clock while the old body could still issue SQL.
- A fixture-only owner now tracks every elapsed-time case body. Teardown awaits
  actual completion before releasing all five services; a following case cannot
  start while work or teardown is owned. Cleanup failures remain reported, and
  failed service release keeps admission sealed. Final teardown attempts owned
  service/database/root cleanup and preserves errors rather than skipping later releases.
- Each database transaction freezes its case's zone and clock instead of consulting
  mutable next-case values. Production retention predicates, query limits and the
  original thirty UTC/New York/Kolkata microsecond-boundary assertions/budgets are unchanged.
- The regression runs real child Jest processes and PostgreSQL `pg_sleep`, using a
  deliberate 100 ms child-test deadline. Without ownership, the timeout and following
  case both fail with `late-previous-case`; with ownership, the timeout still fails
  and the following case passes. The parent requires those precise outcomes and
  rejects unexpected child exit codes/errors. No intentional child failure is
  counted as a passing production test. Evidence:
  `.local-work/issue92-timeout-regression.json` and `issue92-focused.log` (**31 checks**).
- Keep `.fixture.ts` helpers in the test TypeScript project and out of the application
  project. The first static run caught this ownership configuration error; corrected
  project inclusion/exclusion makes all five projects' lint/typecheck pass.
- Complete workspace regression: **1,359 tests**, 651 admin + 584 gateway + 114
  control-plane + 10 dashboard, with real OrbStack PostgreSQL/Redis/RustFS available.
  Admin compilation passes with the same webpack content hash **24559a4cafcb40bc**
  as #91. Unchanged applications retain #91's full builds and 42-plus-seven-load
  production browser checkpoint. Evidence: `.local-work/issue92-all-tests.log`,
  `issue92-static-final.log` and `issue92-build.log`.
- [PR #94](https://github.com/mayank-rawat98/NovaGate/pull/94) closes #92. The final
  affected run on source commit **6dcf97db8525d7976457fb43afd26a0f08f348a8** passes
  all **651 admin tests** in **48.961 seconds**, including the actual child-Jest
  regression and thirty retention-boundary cases. Evidence:
  `.local-work/issue92-affected-final.log`. All final gates exit 0.
  The configured administrator exception permits exact-head merging without
  changing the review ruleset or CI triggers. This fixes demonstrated deadline contamination; it does not promise that every test finishes
  within budget on an overloaded host. Resource-pressure timeouts remain failures.
  #69 hydration, #90 RustFS cleanup and the full remaining roadmap stay open.

## Issue #95 — external provider transport development

The existing remote issue/branch provided the recoverable handoff after the machine
reset. Work starts from merged `dev` **b182b88**. No earlier conversation transcript is
present locally. This section records current local implementation, not a merged PR.

- Shared `LogExportDeliveryBatch` precedes sender changes. Copy only documented log
  fields, validate bounded identities/times/outcomes and use the union of tenant and
  optional destination omissions. No raw row serialization, receipt fields, arbitrary
  bodies/headers or credentials. Bound 256 records, 16-KiB records and a final 1-MiB
  provider body, including Datadog's envelope overhead.
- Extract alert egress into a shared helper while retaining alert error/wire contracts,
  origin isolation, all-answer public A/AAAA checks, 16-answer DNS admission, pinned
  verified TLS, redirect refusal, 8-KiB header bounds and bounded response consumption.
  Export allowance uses only `LOG_EXPORT_HTTP_TRUSTED_ORIGINS`; default remains public
  HTTPS. The service's 15-second absolute budget covers projection/signing/DNS/network,
  four admissions remain held through actual cancellation, and shutdown drains work.
- Official S3 SigV4 signs one bounded `PutObjectCommand` with no SDK retry/region
  redirect. Static/temporary credentials, stable private keys, content type, metadata,
  payload hashes and path/virtual addressing are independently checked on real sockets.
  Webhook signatures cover timestamp, delivery ID and exact NDJSON bytes. Datadog uses
  all nine fixed regional endpoints, header-only API keys and explicit intake records.
  Errors never contain remote bodies, paths or provider credential material.
- `ExportTransportService` is constructed by `LogExportModule` but has no public send
  endpoint, scheduler or activation. Draft CRUD/Settings continues to report inactive
  connections. Durable receipt/batch admission, privacy/retention/destination fences,
  worker retries/history and destination controls remain the next implementation.

Verification evidence:

- All **695 admin tests / 40 suites** pass in the final quiescent PostgreSQL/Redis/
  RustFS run (42.270 seconds), retaining the original 651 tests and adding 43 controlled
  provider/lifecycle cases plus one actual RustFS PUT/read/retry/delete check.
- Earlier shared-boundary focus passes 181 tests; subsequent new TLS rejection and S3
  cancellation cases are included in the final full admin run. The first new RustFS
  test failed because its own SDK client decorated a reused credential object with an
  internal extra field. The fixture now explicitly copies only credentials; strict
  credential validation was preserved. A real isolated rerun and full admin run pass.
- Five projects' lint/typecheck and four application builds pass. The final verification
  fixture is included in the passing final admin/shared lint/typecheck gate; no frontend
  source/UI behavior changed.
- `admin-api:export-transport-smoke` passes in the actual non-root admin production image
  (UID 1000), using its pruned dependencies and controlled loopback HTTP/TLS receivers.
  It verifies signed NDJSON, temporary S3 path addressing, S3 virtual TLS, Datadog EU TLS,
  private payloads and actual shutdown. This is packaged dependency/wire evidence,
  not real Datadog indexing or third-party S3 operational acceptance.
- Rebuilt gateway, control-plane and admin production images also pass the retained
  `admin-api:runtime-smoke` OrbStack campaign: authenticated metrics/SSE/reconnect,
  actual alert firing/retry/recovery, two private RustFS archives containing 97 rows,
  consumer attribution, privacy ACK/erasure/revocation, irreversible receipt retention
  and encrypted revision-aware destination drafts. Draft delivery remains unavailable.
  All three services shut down with exit 0. Evidence is retained in
  `.local-work/metrics-container-evidence.json` and `.local-work/issue95/runtime-smoke.log`.
- The initial full workspace run also exposes the **unchanged** gateway intermediate
  mTLS case: expected 200, observed 403; its isolated 15-case suite retains 14 passes and
  that failure. Node 24.21.0/OpenSSL 3.5.8 native reproduction outside Jest shows
  `authorized: true`, the expected intermediate-client leaf and no `issuerCertificate`
  from `getPeerCertificate(true)`. Adding explicit fixture SKI/AKI did not repair it;
  diagnostic edits were removed. Do not weaken tenant anchoring or claim all 1,403
  workspace checks pass. The retained control-plane and dashboard suites pass.
- Issue #90 remains open. Fresh successful object/bucket cleanup is not evidence of
  repairing its historically retained orphan/reserved-delete state or provider restore.
  Issue #69 and formal provider/inbox/phase acceptance also remain open.

Local logs and generated fixtures live under `.local-work/issue95/` and
`.local-work/export-transport-runtime/`; provider credentials are disposable fixtures.
No production deployment, `main` change or external provider delivery is represented.

## Durable delivery store/worker — local continuation

The post-reset continuation adds internal durable admission and leased provider attempts
alongside issue #95's transports. This remains unmerged local work. It does not enable
drafts or complete phase 4.4.

- Shared `LogExportDelivery` precedes storage/worker changes. History explicitly exposes
  metadata only. Admission accepts source UUIDs, reads trusted tenant database records
  under the receipt lock, preserves microseconds, applies tenant/destination omissions
  and saves one immutable projected batch. Duplicate IDs with matching source/policy
  reuse that snapshot; changed source/policy/tenant reuse conflicts.
- New startup migration creates the independent outbox with indexed due/history/expiry
  queries. Cross-replica admission enforces 20 pending batches per destination and 1,000
  retained rows per tenant. SQL operations have eight admissions, three-second statement
  and one-second lock limits. Payload expiry is the earlier of 24 hours and the oldest
  receipt's remaining tenant lifetime. Terminal states erase payload immediately.
- Row claims use random 30-second leases and `SKIP LOCKED`. Six charged attempts include
  failed credential access and recovered leases; retry delays are 5/30/120/600/1,800
  seconds. Stale leases cannot acknowledge or retry. Errors are fixed codes. Bounded
  cleanup revokes/removes at most 500 rows per stage; history survives 168 elapsed hours
  after completion, with capacity rejection rather than eviction of young identities.
- Actual privacy/retention writes and destination edit/re-encryption/removal revoke
  queued/processing leases and erase payloads in the same transaction. Worker attempts
  check all revisions, live receipt eligibility and lease ownership before sending and
  once per second without overlapping SQL polls. Revocation and shutdown close actual
  sockets and drain owned work. External bytes/copies cannot be recalled.
- The internal worker has four admissions and no bootstrap timer. The producer's cursor
  must commit atomically with admission before activation: provider-aware batch splitting,
  fair replica discovery, skipped coverage, public history, payload controls and activation
  remain required. Existing destination API/Settings still reports inactive drafts.
- Final full admin regression passes **726 tests / 41 suites** (81.945 seconds) with real
  PostgreSQL/Redis/pinned RustFS, adding 31 real database/receiver/lifecycle checks to the
  prior 695 checkpoint. Tests cover immutable retry bytes after worker reconstruction,
  duplicate/capacity races, exact receipt floors, six attempts, lease recovery, real
  revision saves, socket cancellation, worker shutdown and four owned admissions.
  Affected admin/shared lint/typecheck and production build gates pass. Evidence:
  `.local-work/issue95/delivery-admin-final.log` and
  `.local-work/issue95/delivery-worker-gates-final.log`.
- Rebuilt final admin image passes the retained three-image `admin-api:runtime-smoke`
  campaign. Synthetic fixture-only queued/processing outbox rows prove packaged
  migration, atomic payload/lease revocation through actual key rotation/removal, and
  stale-write conflict preserving its lease. This supplements real source admission
  and actual worker/socket integration tests; it does not prove automatic production
  scheduling. Metrics/alerts/private archives/consumer attribution/privacy/retention
  remain green and gateway/control-plane/admin each exit 0. Evidence:
  `.local-work/issue95/delivery-runtime-smoke-final.log` and
  `.local-work/metrics-container-evidence.json`. The first packaged attempt exposed
  conflicting text/varchar inference in the new synthetic fixture's status parameter;
  explicit casts fixed only the fixture. Its failure is preserved in
  `.local-work/issue95/delivery-runtime-smoke.log`; production SQL was unchanged.

The unchanged mTLS failure now has an upstream diagnosis: Node.js
[issue #65579](https://github.com/nodejs/node/issues/65579) describes the same consumed
peer-chain behavior and [PR #65602](https://github.com/nodejs/node/pull/65602) fixes it.
The local Node 24.21.0 native implementation still calls `getPeerX509Certificate()`
during server authorization, matching that failure mechanism. The fetched official
release index lists 24.21.0 as the latest Node 24 release. Select and verify a runtime
containing the fix before claiming full workspace/native intermediate-mTLS acceptance;
do not weaken tenant anchoring or skip the strict test. No runtime upgrade is claimed.

## Automatic external receipt producer/scheduler — local continuation

The next issue #95 continuation adds the internal source-to-delivery scheduling path.
This remains unmerged local work; authenticated draft APIs/Settings still report
`deliveryAvailable: false`. This checkpoint supersedes the earlier store/worker note
that the producer and bootstrap timer were pending.

- Shared schedule/filter/payload-policy contracts precede implementation. Startup
  migration adds independent receipt schedules, due/dispatch indexes, schedule-linked
  batches and composite tenant/destination ownership constraints. Repeated migration
  remains idempotent. First internal configuration starts at the database save receipt
  under the ingestion lock and excludes existing logs; revision-aware saves preserve
  the precise receipt/UUID cursor and refuse unreadable credentials/hidden filters.
- UTC minute/hour windows settle for 15 seconds. Source selection, provider-envelope
  byte sizing, immutable admission and cursor/counter updates commit together without
  network work. SQL bounds legacy text before loading and reads at most 257 source rows;
  processing admits at most 256 records/one 1 MiB final body. Datadog envelope/escaping
  overhead and NDJSON newlines count. Partial batches retain microseconds/UUID position;
  empty windows advance only before the next retained receipt. Request timestamps
  never determine source windows or retention.
- Admission, filtered and invalid records have separate counters. Retention advances
  an expired source cursor to its inclusive floor and reports skipped elapsed seconds
  without inventing deleted-row counts. Full queue/history preserves unprocessed
  receipts. Hidden stored filter fields stop source inspection. Pause stops source
  admission while queued attempts remain eligible; cadence/filter edits retain cursor
  and queued bytes. Payload-policy changes fence/revoke previous destination bytes.
- The scheduler owns a non-overlapping two-second timer, bounded cleanup and at most
  four fair source reservations/four dispatch targets per sweep. Source reservations
  recover after two seconds; delivery retains 30-second leases and six charged attempts.
  Actual transaction failure for one destination does not block a healthy destination.
  Standalone manually admitted draft batches without a schedule ID are not dispatched.
  Shutdown closes real requests and drains the owned sweep. Dedicated encryption keys
  are required before bootstrap; no public activation endpoint is introduced.
- The first real-PostgreSQL run passed 21/25 scheduler checks and exposed a discovery
  bug: TypeORM's `UPDATE ... RETURNING` result includes an affected-row tuple. Returning
  a final `SELECT` from a modifying CTE restores the target array. Controlled-clock
  dispatch also needed admission timestamps to use the same explicit database clock
  as expiry; creation/next-attempt timestamps now do so. Initial test type errors were
  corrected without weakening boundaries/timeouts. Failure logs are retained in
  `receipt-tests-initial.log`, `receipt-tests-discovery-fix.log` and initial static logs
  under `.local-work/issue95/`.
- Full admin regression passes **753 tests / 42 suites** in **80.012 seconds**, adding
  27 scheduler checks to the prior 726 checkpoint. PostgreSQL/Redis/pinned RustFS are
  real. Coverage includes microsecond/UUID ties, settlement boundaries, partial/provider
  batches, producer replicas, rollback, capacity, retention, malformed legacy rows,
  pause/resume, minute-to-hour changes, healthy-destination isolation, strict config,
  no-key bootstrap and actual HTTP shutdown. The earlier combined four-suite transport/
  store/scheduler run passed all 100 checks before the final two added scheduler cases.
  All five projects' lint/typecheck gates and four application builds pass. Evidence:
  `.local-work/issue95/receipt-admin-final.log`, `receipt-focused.log` and
  `receipt-workspace-gates.log`; final cleanup/static logs are retained alongside them.
  After strengthening teardown to attempt every owned resource and preserve failures,
  all 27 scheduler checks and affected lint/typecheck gates pass again; final fixture
  lint and packaged runtime also pass without disabling unsafe-finally checks.
- The rebuilt admin image `sha256:ee4baddb57cfad974d25d3e62c6af006127a50ddaa335a8dcb6cdd1c63b1c8fc`
  passes the retained three-image OrbStack campaign. A fixture-only internally seeded
  schedule, encrypted controlled endpoint and actual database source row exercise the
  production application's bootstrap timer. Signed private NDJSON accepts a 2001
  request timestamp by recent receipt; controlled 503→202 delivery retains the same
  ID/bytes after source mutation and erases terminal payload. Two attempts/one record
  are persisted. This proves packaged scheduling/retry, not actual-provider indexing
  or public activation. The first packaged run was started before the build completed,
  used the prior image and lacked the schedule table; it is retained separately in
  `receipt-runtime-smoke.log`. Completed-image runs pass in
  `.local-work/issue95/receipt-runtime-smoke-final.log`, the final teardown rerun
  `.local-work/issue95/receipt-runtime-cleanup-final.log` and
  `.local-work/metrics-container-evidence.json`.
- The same packaged run retains metrics/SSE/reconnect, consumer attribution, stored
  metadata privacy and irreversible retention, actual alert firing/retry/recovery and
  two private RustFS archives containing all 97 exported records in the final run.
  Alert firing acceptance takes **60.478 seconds**. Gateway/control-plane/admin each exit **0**.
  These remain local fixture checks; #69, historical RustFS cleanup #90, unchanged
  Node intermediate-mTLS failure and formal phase/provider acceptance remain open.
- This checkpoint exposed a capacity constraint: its 1,000-row tenant history cap
  with seven-day history could stall continuously nonempty minute-cadence exports.
  The continuation below fixes that admission/history boundary. Sustained timer
  throughput/backpressure, authenticated schedule/history/payload controls and
  Settings UX remain required; phase 4.4 and the later roadmap are not complete.

## Scheduled external delivery history capacity — local continuation of issue #95

- The previous packaged image reproduces a continuously full-history stall: internally
  configured scheduling reports `history_full` and sends no source row when 1,000
  young terminal rows are present. Evidence is retained in
  `.local-work/issue95/capacity-before-runtime.log`; the boundary is exercised without
  adding a public activation endpoint or weakening private egress.
- Selected-record caller identities now have an independent 1,000-row admission
  budget and retain their existing 168-hour terminal lifetime. Automatic jobs have
  a hard 1,200-row tenant budget: 1,000 terminal metadata rows plus 200 pending slots
  across the ten permitted destinations. Both sources share the 20-pending-per-
  destination bound. Producer admission and final acknowledgement serialize on the
  tenant admission lock. Excess scheduled terminal metadata compacts in at most
  500-row pages; queued/processing identities and caller rows are never selected.
  If concurrent cleanup owns excess rows at the hard automatic limit, `history_busy`
  preserves the source cursor and retries after five seconds. Legacy excess rows
  drain in bounded pages before more automatic work is admitted.
- A persisted scheduled marker survives schedule foreign-key removal/recreation;
  repeated migration backfills existing scheduled jobs and retains the marker.
  The committed receipt/UUID cursor prevents replay after terminal metadata rolls off.
  Retention-floor advancement remains explicit; automatic metadata is no longer
  promised for a minimum seven days. Receivers still need at-least-once deduplication
  because an acknowledgement can be lost before persistence.
- Deletion and workspace summary increments commit together, including age-based
  cleanup. One fixed summary row counts removed scheduled delivered/failed/expired
  batches and record occurrences. Records exported to multiple destinations count
  multiple times; these are not unique-source totals. `historyState` returns at most
  50 projected destination rows and workspace coverage in one statement snapshot,
  with exact BIGINT decimal strings, the 168-hour maximum age, 1,000 terminal target,
  read limit and last prune time. Neither source IDs nor payloads are returned.
- Ten additional real-PostgreSQL checks bring the scheduler suite to **37 tests**:
  full independent cohorts, active payload/lease preservation, replica serialization,
  atomic coverage-write rollback, age cleanup, schedule removal/recreation, repeated
  migration, exact counters beyond JavaScript's safe integer range, tenant isolation,
  bounded legacy cleanup and actual row-lock ownership at the hard automatic limit.
  All **763 admin tests / 42 suites** pass in **91.629 seconds** with real PostgreSQL,
  Redis and pinned RustFS. Five-project lint/typecheck and four-app builds pass;
  eight unchanged tasks reuse Nx cache. Logs:
  `.local-work/issue95/capacity-admin-bounded-final.log`,
  `capacity-locked-focused.log` and `capacity-gates-bounded-final.log`.
- `admin-api:export-capacity-smoke` exercises actual source/store/worker/transport
  code under UID 1000 with pruned production dependencies and an owned non-UTC
  PostgreSQL database. Its **1,101** windows each produce an actual signed private
  HTTP NDJSON delivery. An independently seeded **1,000-row caller history** stays
  intact; reconstructing the worker/store midway causes no duplicate source or
  delivery ID. The final run takes **19.988 seconds**, retains **1,000 scheduled +
  1,000 caller** rows and **zero payloads**, and records **101** removed delivered
  batches/record occurrences. Image:
  `sha256:5ed5d8fc7b3ac5d48ca68f4a706c44428b78531e0e2314703cf2016667e9cefd`.
  Evidence: `.local-work/issue95/capacity-sweep-bounded-evidence.json` and
  `.local-work/issue95/capacity-sweep-bounded-final.log`. This direct loop is a
  capacity regression, not a timer throughput or comparative provider benchmark.
- Initial verification failures were corrected in fixtures without changing
  production admission/privacy boundaries: caller deduplication must pass its saved
  policy; concurrent producer reservations can legitimately defer one caller; the
  runtime fixture uses an async entry point and the worker's delivery outcome enum;
  the bootstrap receiver tracks its actual batch by ID rather than selecting seeded
  terminal history. Initial logs remain under `.local-work/issue95/`. The retained
  non-root transport smoke passes signed NDJSON, temporary-credential/path-style S3,
  verified virtual-host TLS S3, Datadog EU TLS and actual shutdown drain against the
  final image (`capacity-transport-bounded-final.log`).
- The same final admin image passes the retained three-image OrbStack runtime check.
  Its actual bootstrap timer starts with independently full caller/scheduled history,
  admits the trusted recent receipt despite a 2001 request timestamp, and persists
  the signed private **503→202** retry with stable ID/bytes after source mutation.
  It erases terminal payload, preserves caller rows and records the removed scheduled
  outcome. Metrics/SSE/reconnect, consumer attribution, stored metadata privacy,
  irreversible retention, alert firing/retry/recovery and **two private RustFS archives
  containing 96 rows** pass. Alert firing acceptance takes **59.730 seconds**;
  gateway/control-plane/admin each exit **0**. All owned runtime containers are gone;
  the retained verification infrastructure and unrelated services remain running.
  Evidence: `.local-work/issue95/capacity-runtime-bounded-final.log` and
  `.local-work/issue95/capacity-runtime-bounded-evidence.json`. These controlled local fixtures do
  not close #69, historical RustFS cleanup #90, the unchanged Node intermediate-mTLS
  failure, actual-provider acceptance or formal phase/release gates.

## External delivery discovery under slow receivers — local continuation of issue #95

- Real PostgreSQL/HTTP regression reproduces a stalled receiver holding the entire
  discovery sweep: the fifth healthy destination does not dispatch despite free
  worker slots (`.local-work/issue95/throughput-before.log`). Source/discovery now
  owns its non-overlapping two-second timer separately from provider attempts.
  It reserves only currently free worker slots, excludes its already-owned
  destinations and holds at most four attempts, one per destination per instance.
  Ownership includes claim, actual socket settlement, eligibility polling and final
  persistence. Shutdown aborts and drains both source work and all owned attempts.
  Capacity exhaustion waits for settlement instead of accumulating promises.
- The strengthened regression gives the stalled destination four real immutable
  source batches and verifies that subsequent discovery sends healthy backlog
  while retaining exactly one processing slow batch and three untouched queued
  batches. The bootstrap/shutdown check now takes a real ingestion advisory lock
  to prove source sweeps cannot overlap, then releases it and verifies actual
  socket drain and persisted cancellation. No assertion/deadline is weakened.
- A second real HTTP regression reproduces automatic dispatch selecting older
  caller work when both sources share an active destination. The timer now passes
  an explicit scheduled-only claim: the job must be marked scheduled and still
  have that destination's schedule ID. The caller batch remains queued with zero
  attempts while the scheduled batch is acknowledged. Explicit internal worker
  calls retain their existing behavior. Failure evidence:
  `.local-work/issue95/throughput-scope-before.log`.
- All **114 focused export checks / four suites** pass, including **39 receipt
  scheduler checks**, the durable store and real transport/RustFS boundaries.
  Full admin regression passes **765 tests / 42 suites** in **88.667 seconds** with
  real PostgreSQL/Redis/RustFS. Five-project lint/typecheck/four-app builds pass;
  current admin/shared gates pass again after the claim-scope change. New fixture
  non-null assertions were replaced with explicit ownership checks; a network-boundary
  stub now supplies free capacity and asserts the explicit scheduled claim argument.
  Initial fixture lint warnings and the obsolete stub assertion remain recorded. Evidence:
  `.local-work/issue95/throughput-combined-current.log`, `throughput-admin-current.log`,
  `throughput-gates-final.log`, `throughput-gates-current.log` and
  `throughput-backlog-final.log`.
- `admin-api:export-scheduler-smoke` runs actual compiled source classes with pruned
  production dependencies under UID 1000 and an owned non-UTC PostgreSQL database.
  It starts the actual bootstrap timer with **zero manual ticks**, two workspaces,
  seven destinations and six healthy receivers alongside a stalled receiver.
  A fixture-owned real 20-batch slow queue tests pressure without cursor loss;
  pause drains queued work, reconstruction preserves identities and resume admits
  the remaining source windows. Signed/private bytes, tenant/filter isolation,
  identical bytes for legitimate retries, no replay under a new delivery ID,
  processing/socket bounds and terminal payload erasure are asserted. Initial run
  delivers **73 batches/record occurrences from 41 distinct source records**,
  begins delivery to all healthy destinations in **2.106 seconds**, and completes
  in **56.291 seconds**. Its observed processing limit is **4** and destination
  pending limit is **20**. This controlled workload does not establish production
  scale, larger replica/load acceptance, external-provider indexing or Kong performance.
- Final rebuilt admin image
  `sha256:f76dfe356b768e2a64520cc3e718a27c137df56df83176989e4e5ddff0961972`
  passes the updated timer fixture: **73 batches**, all six healthy destinations
  receiving within **2.100 seconds**, **56.211 seconds** overall, at most **4 processing
  jobs / 3 observed sockets / 20 pending batches per destination**, and zero terminal
  payloads. The retained 1,101-window capacity fixture passes in **22.869 seconds**
  with unchanged caller identities, 1,000 scheduled terminal rows and 101 removed
  outcomes. The retained provider transport smoke covers signed NDJSON, S3 temporary
  credentials/path addressing, verified virtual-host S3 TLS, Datadog EU TLS and
  shutdown drain. The builder now emits all three fixtures; capacity/scheduler use
  a shared bounded launcher that pins the inspected image and records compiled
  fixture hashes. Evidence:
  `.local-work/issue95/throughput-timer-final-evidence.json`,
  `throughput-capacity-final-evidence.json`, `throughput-timer-final.log`,
  `throughput-capacity-final.log` and `throughput-transport-final.log`.
- The same final image passes the retained actual application bootstrap campaign
  with stable signed **503→202** scheduling/retry despite full independent history,
  packaged migration and transactional destination/key revocation. Metrics/SSE,
  consumer attribution, privacy/retention and **three private RustFS archives
  containing 96 rows** pass. Alert firing acceptance takes **59.638 seconds** and
  all three application services exit **0**. Evidence:
  `.local-work/issue95/throughput-runtime-final.log` and
  `throughput-runtime-final-evidence.json`. Old capacity evidence is archived beside
  its own logs rather than relying on the shared latest-evidence files. This remains
  unmerged local development; public activation, larger workload/provider acceptance,
  #69/#90, the unchanged Node intermediate-mTLS gate and later phases remain open.

## Authenticated external delivery controls — local continuation of issue #95

The external delivery path now has explicit tenant APIs and Settings controls. This
remains unmerged local development, with formal phase/provider acceptance still open.

- Saving credentials creates an inactive draft. The destination list reports the
  installation's delivery capability and separate draft/enabled/paused configuration
  state. Metadata/key writes preserve that state and revoke waiting bytes for the
  previous destination revision. Enabled does not establish provider health/indexing.
- Authenticated `GET/PUT/DELETE /tenants/:tenantId/log-export-destinations/:id/delivery`
  expose safe state and strict revision-aware configuration/removal. The history
  suffix returns at most 50 metadata rows with exact decimal workspace coverage.
  No arbitrary source IDs, records, raw payloads or cursor writes are exposed.
  The global tenant session guard binds the subject/path; foreign identifiers return 404. Responses are `no-store` and contain no credentials or provider responses.
- First scheduling begins at database save receipt time, without backfill. Pause
  keeps the cursor and queued retries; resume catches up within retained coverage.
  Payload-policy changes fence old bytes. Pause and removal work without encryption
  keys and when saved filters refer to now-omitted workspace metadata. Removal expires
  only scheduled waiting leases/payloads, retains caller work and terminal history,
  and recreation begins at its new save receipt. Owned history remains readable by
  destination ID after credential removal; delivered external copies cannot be recalled.
- The shared contracts and typed client precede the native Settings dialog. Controlled
  cadence/status/prefix/consumer/privacy inputs retain selections on write or revision
  failures. History separates source and acknowledgement from indexing, reports bounded
  retention/compaction and keeps large decimal counters exact. Reads/mutations have
  owned deadlines and cancel on close/workspace changes, without promising rollback.
  The editor initializes from its own completed state read; it never starts from an
  older cached revision. Background refreshes retain current selections. Browser
  regressions caught and corrected the modal wrapper, select labels and reopening
  race; those failing logs remain under `.local-work/issue95/activation-browser-*`.
- Real PostgreSQL/Nest HTTP checks cover explicit activation/start time, strict DTOs,
  session/tenant boundaries, stale writes, unavailable keys, preserved hidden filters,
  scheduled-only lease removal, safe retained history and enabled metadata/key writes.
  All **781 admin tests / 42 suites** pass in **87.883 seconds** with local
  PostgreSQL/Redis/RustFS. The focused final lease check passes **34 tests / two suites**.
  Existing dashboard regression passes **10 tests / three suites**. All five projects'
  lint/typecheck and four application builds pass; current dashboard/admin/shared
  gates pass again after the reopening correction. Evidence:
  `.local-work/issue95/activation-admin-regression.log`,
  `activation-http-lease-final.log`, `activation-dashboard-regression.log`,
  `activation-static-feedback-final.log`, `activation-other-static.log`,
  `activation-backend-builds.log` and `activation-plane-build.log`.
- The initial passing production browser suite completes **seven cold loads**, all
  three providers' explicit delivery activation, retained filters/privacy, revision
  recovery, pause/resume, enabled metadata edits, stopping without keys,
  removal/recreation, two interrupted writes and workspace/focus/Escape/Tab checks.
  Desktop/mobile axe checks and runtime errors are empty. Evidence:
  `.local-work/issue95/activation-browser-seventh.log` and
  `activation-browser-seven-evidence.json`. The final campaign completes **42 cold
  loads under sixfold CPU throttling** and adds two held read cancellations, with
  **zero runtime/accessibility findings** and a finalized trace. Both reads and errors
  now belong to the current dialog: an earlier canceled request's cached error cannot
  replace its loading/feedback state. The held-read fixture also owns pending event
  waits so teardown retains the original assertion failure instead of an unhandled
  rejection. Evidence: `activation-browser-stress-owned-final.log` and
  `activation-browser-stress-final-evidence.json`. The earlier failed stress run is
  retained; a passing hydration campaign does not close #69.
- Rebuilt admin image
  `sha256:58786256e5a51aac9f45958bf427693933067be6ffba4111c2b23b20b2a98d95`
  passes the actual application bootstrap check. Only the operator-trusted encrypted
  local receiver uses fixture SQL; scheduling is enabled through authenticated HTTP
  before inserting a fresh database-receipted source. Its signed **503→202** retry
  retains identity/bytes despite source mutation and full separate histories.
  Public history returns 50 safe rows and compaction coverage; public pause/removal
  retain history. Packaged migration, stale-write/lease preservation, revocation,
  metrics/SSE, consumer attribution, privacy/retention and **two private RustFS
  archives containing 96 rows** pass. Alert firing acceptance takes **59.773 seconds**;
  all three application services exit **0**. Evidence:
  `.local-work/issue95/activation-runtime-initial.log` and
  `activation-metrics-container-evidence.json`.
- The same image passes the retained actual bootstrap timer with two workspaces,
  seven destinations, zero manual ticks and **73 signed batches/record occurrences
  from 41 distinct sources**. All six healthy destinations receive within **2.103
  seconds**, with **54.299 seconds** overall, at most **4 processing jobs / 2 observed
  sockets / 20 pending batches**, and zero terminal payloads. The 1,101-window capacity
  fixture completes in **23.984 seconds**, preserves all 1,000 caller identities and
  1,000 scheduled terminal rows, and records 101 removed outcomes. UID 1000 transport
  checks retain signed NDJSON, S3 temporary/path and verified virtual-host TLS,
  Datadog EU TLS and shutdown drain. Evidence:
  `.local-work/issue95/activation-export-scheduler-evidence.json`,
  `activation-export-capacity-evidence.json`, `activation-timer-final.log`,
  `activation-capacity-final.log` and `activation-provider-final.log`.

Larger workload/replica and actual-provider acceptance, scalable consumer rollups,
#69/#90, the unchanged Node intermediate-mTLS gate, later phases and formal release
acceptance remain open. No production deployment or comparative Kong claim is made.

## Issue #95 review preparation — 11 October 2026

The export work is separated from the later consumer-rollup, declarative import
and CLI changes. Those later features remain in the shared working checkout and
are not part of this issue's committed source. The personal SSH alias
`github-personal` authenticates as `mayank-rawat98`; the repository uses the matching
commit identity and push URL.

- Backend commit `9012b6d` contains bounded provider transports, immutable durable
  delivery, receipt scheduling, capacity/history controls, public authenticated APIs
  and their actual receiver/PostgreSQL regressions.
- UI commit `798bc53` contains explicit activation, pause/resume, filters, payload
  policy and metadata-only history. Credential saves remain inactive drafts.
- An isolated checkout with its own `npm ci` verifies these exact source blobs.
  It starts at snapshot `4ba599debb390f14c80210786c6914918cc627b9`; every committed
  backend/UI source, test and configuration blob matches that snapshot. Final docs
  add the new verification record without changing tested source.
- All five projects pass lint, typecheck and application builds. All four production
  images are rebuilt from the isolated snapshot; image IDs are retained in
  `.local-work/issue95/commit-preparation/isolated-image-evidence.json`.
- Structured quiescent admin verification passes **782 tests / 42 suites**, with
  zero skipped tests, in **85.832 seconds**. A preceding loaded run recorded two
  five-second alert setup-hook timeouts; the failure remains retained. No timeout
  or assertion was weakened.
- The isolated production browser campaign passes **42 cold loads**, sixfold CPU
  throttling, all three providers and activation/revision/stop/recreation/cancellation
  flows with zero runtime/accessibility findings. The first nested-checkout preview
  failed because Next.js selected its parent workspace; relocating the checkout
  outside the repository and rebuilding corrected verification isolation.
- Evidence lives under `.local-work/issue95/commit-preparation/`: `isolated-static-build.log`,
  `isolated-admin-results.json` (the loaded failure),
  `isolated-admin-quiescent-results.json`, `isolated-admin-quiescent.log`,
  `isolated-dashboard-final.log`, `isolated-browser-evidence.json` and image logs.

- The final isolated three-application pipeline passes real gateway traffic,
  metrics within two seconds, reconnect/history, private archives, privacy/retention,
  signed automatic delivery/retry, authenticated activation/history and revision
  revocation. Gateway, collector and admin all exit **0**. Actual alert firing
  acceptance takes **59.307 seconds**. The initial runtime under concurrent builds
  failed an exact 10-success response assertion with 8; its failure remains retained,
  and the quiescent repeat passes unchanged assertions.
- The non-root transport fixture passes signed NDJSON, temporary-credential path S3,
  virtual-host TLS S3, regional Datadog TLS and actual-work shutdown. The automatic
  two-workspace/seven-destination scheduler delivers **73 batches / 41 distinct
  sources**, progresses all six healthy destinations in **2.106 seconds** and
  preserves four-slot/20-pending bounds, pause/resume and reconstruction.
  There are **zero manual timer ticks**. The capacity fixture delivers **1,101 real
  windows in 21.650 seconds**, retains 1,000 caller plus 1,000 scheduled rows,
  reports exact 101-row/record compaction and leaves no terminal payloads.
- The fourth production image returns **HTTP 200** for login and exits **0**.
  Image login is separate from the full production browser campaign above.
- Additional evidence: `isolated-runtime-evidence.json`, `isolated-runtime-quiescent.log`,
  `isolated-runtime.log` (the initial failure), `isolated-export-runtimes.log`,
  `isolated-scheduler-evidence.json`, `isolated-capacity-evidence.json` and
  `isolated-dashboard-image-evidence.json` in the same directory.

- Retained collector and dashboard regressions pass **114 / 7 suites** and
  **10 / 3 suites**, respectively. Gateway verification passes **583 of 584**;
  the unchanged native intermediate-chain mTLS case still returns **403** where
  **200** is required. The gateway source has not changed in this PR. This is an
  explicit failing gate, not a full-workspace pass. Structured results and
  `isolated-retained-final.log` preserve the failure. The first report-writing
  attempt also failed because its output directories were absent; directories
  were created and the final commands leave only the native mTLS failure.

This is the historical pre-runtime issue #95 checkpoint. Issue #97 / PR #98
subsequently fixes the native intermediate-mTLS runtime gate, and PR #96 is merged
into dev. Current issue-level verification and remaining formal acceptance are
recorded above; no main deployment is authorized.

## Consumer count/path rollups — issue #99 / PR #100

The branch starts from dev `e8886267`, after PRs #98 and #96. Backend commit
`8ba759b` contains admin-owned migration/provisioning, transactional count/path
materialization, indexed backfill, durable one-row replica notifications and
bounded readers/cleanup. UI commit `7caa20c` exposes exact retained counts,
histogram upper estimates, partial UTC intervals, path group counts, independent
backfill/capacity coverage and stale/retry states. Commit `110a35f` corrects the
late-observation label to “15 seconds or more,” matching the inclusive SQL boundary.
Declarative import, CLI and live-log work remain separate local changes.

- **1,535 tests pass, zero failed/skipped:** 825 admin / 46 suites, 586 gateway /
  38 suites, 114 collector / 7 suites and 10 dashboard / 3 suites. This includes
  31 real PostgreSQL storage cases, eight real PostgreSQL reader cases, three
  histogram checks and actual shutdown ownership. The final wording-only UI
  correction also passes all ten dashboard tests. Evidence: `test-evidence.json`,
  per-project results and `dashboard-label-results.json` under `.local-work/issue99`.
- All five projects pass lint, typecheck and build (`static-build.log`); the final
  dashboard source passes its static/build checks (`dashboard-label-static.log`).
  Both production browser campaigns pass without runtime or axe WCAG findings:
  42 cold loads / six passes at sixfold CPU throttling in
  **213.735 seconds**, then seven final loads in
  **44.968 seconds**. Full traces, run metadata and
  mobile coverage/path/privacy screenshots remain in `browser-artifacts` and
  `browser-label-artifacts`. The final mobile image was visually inspected.
- All four fresh images run Node 26.11.1 as UID 1000. The three backend bundles
  match the tested host builds byte-for-byte (`fresh-bundle-evidence.json`). The
  final dashboard image serves login and all 16 referenced assets with HTTP 200
  and exits 0 (`image-evidence.json`). The first dashboard dependency install
  reported npm `TAR_ENTRY_ERROR EFAULT`; that build was explicitly cancelled and
  rejected for verification. Its log/disposition remain. A clean builder install
  completes without extraction errors and passes the runtime checks; the final
  label rebuild also passes. This retry does not establish the filesystem cause
  or prevent recurrence; issue #101 remains open.
- The single-image production timer materializes **200,001 retained records**
  in **108.629 seconds**, preserving the
  150-second deadline. Authenticated query takes
  **466.509 ms**; exact counts/path groups, estimate
  metadata, excessive-pending refusal and immediate/automatic privacy erasure
  pass. There are zero manual worker ticks; the non-root admin exits 0.
  Evidence: `single-runtime.log`, `consumer-rollup-runtime-evidence.json`.
- The two-image fixture materializes **400,001 observations**, **19,995 normalized
  groups** and exactly **20,000 path cells** in
  **111.202 seconds**. The other workspace
  progresses in **255.995 ms** while backfill is
  active. Concurrent replay of 2,000 existing IDs preserves source/count identity;
  a replica exits 0, restarts and finishes the active backlog. Both replicas match
  independent counts, all histogram estimates and global ranking. Eight concurrent
  reads yield four complete responses and four actionable refusals, then recover.
  Tenant isolation, whole-response refusal of a 20,001st cell, shorter-window and
  receipt-retention recovery pass. Current path privacy projects immediately;
  automatic historical erasure completes in
  **101.230 seconds**, and restoring path
  retention does not resurrect metadata. Original 180-second materialization and
  cleanup limits, 20-second fairness, SQL/lock/admission limits remain unchanged.
  Both non-root replicas exit 0; zero manual ticks or manufactured marker/aggregate
  writes. Evidence: `replicas-runtime.log`, `consumer-rollup-replicas-evidence.json`.
- The retained three-service pipeline verifies **21 real consumer requests** /
  **10 server errors** / **21 latency samples** atomically materialized into both
  stores, with histogram coherence and private internal markers. Metrics/SSE,
  private RustFS archives, authenticated export activation/history, immutable
  signed retries, payload/revision revocation, privacy/retention and independent
  consumer attribution pass. Alert firing acceptance takes
  **59.299 seconds**. Its separate
  200,001-record backfill finishes in
  **104.423 seconds**.
  All three services exit 0. Evidence: `pipeline.log`, `pipeline-evidence.json`.
- Retained export timers deliver **73 batches**
  across two tenants/seven destinations, with the first healthy pass in
  **2.091 seconds**, at most
  **2 database connections**, four processing and
  twenty pending batches. Pause/resume and reconstruction pass, with no terminal
  payloads or manual timer ticks. The direct producer/worker capacity fixture
  delivers **1,101 real windows** in **20.651 seconds**,
  retains 1,000 caller identities (synthetic fixture rows) plus 1,000 scheduled
  outcomes, records exactly 101 compacted batches/records and retains no terminal
  bytes. It does not claim timer discovery; that is verified separately above.
  Evidence: `exports-runtime.log`, `export-scheduler-evidence.json`,
  `export-capacity-evidence.json`.

Prior failing diagnostics remain under `.local-work/issue95`: TypeORM mutation
tuple handling, lost sweeps through brief receipt/public-row contention, missing
idle ingestion wake-ups and two-worker historical privacy starvation. Current
real PostgreSQL regressions retain their corrected row-return, lock order,
bounded retry/cooldown, notification rollback and cursor/revision ownership.
Source backup and hashes are preserved under `.local-work/issue99/source-backup`;
the original dirty workspace and global Node runtime are untouched.

These are finite persisted-record/controlled-receiver and issue regression results.
They do not establish complete traffic/billing coverage, larger workload/cardinality
acceptance, actual-provider indexing/inbox guarantees or comparative Kong throughput.
Issues #69, #90 and #101, later roadmap phases, enterprise requirements and formal
all-phase/release acceptance remain open. Main is reserved for that final gate.

## Dependency extraction rejection — issue #101 / PR #102

CI and all four Docker dependency installs now use the builtin-only verified
npm wrapper; backend production pruning uses it too. It rejects npm tar
extraction diagnostics even when npm exits zero, keeps normal npm failures,
streams output with bounded diagnostic overlap/backpressure, and propagates
POSIX cancellation to npm and its lifecycle-script group. The copied guard
invalidates earlier unguarded Docker install layers. Failed installs are not
repaired or retried automatically; existing images need rebuilding.

The real npm/tar regression injects one fixture file-write EFAULT. Unguarded
npm accepts a zero-byte module with a missing constructor; guarded ci/prune
reject it. Quiet options/environment cannot suppress the warning. Healthy
installs preserve the 52-byte module and constructor. A real prepare script
runs; cancellation drains it and npm with exit 143. A script failure keeps
exit 17, all 128 KiB of output and its trailing diagnostic. Missing-lock/npm
errors fail, and a real negative Docker build cannot publish its image tag.
This controlled callback injection proves rejection, not the original kernel
cause. The bundled npm 11.20.0 / pacote 21.5.1 / tar 7.5.22 source explains
nonfatal write-error handling; attribution to Node/libuv/OrbStack and observed
memory pressure remains unproven. Issue #101 remains open for that trace.

A fresh guarded Node 26.11.1 host install passes. All five projects' lint and
typecheck pass, reusing three matching Nx cache results among ten tasks.
All four images build with fresh guarded installs and no extraction diagnostic;
three backend pruning steps succeed. Every image runs as UID 1000 with Node
26.11.1. All three packaged backend bundle hashes match the already verified
merged dev checkpoint. The production dashboard serves login and all 16 assets
with HTTP 200, retains a 4,558-byte Next base-http module and real constructor,
and shuts down with exit 0.

The retained production pipeline also passes actual gateway traffic, committed
metrics/SSE/history, private archives, privacy/retention and authenticated
signed stable-body delivery/retry/revocation. Alert firing is accepted in
59.924 seconds. Automatic timers materialize 200,001 persisted records in
102.503 seconds with no manual ticks; the authenticated query takes 336.994 ms.
Gateway, collector and admin all finish shutdown with exit 0; disposable
fixtures are removed. These are finite local regressions, not complete
provider/inbox, larger-workload or comparative Kong acceptance.

Evidence is retained under `.local-work/issue101`: `repro-before.json`,
`extraction-smoke-final.log`, `verified-host-ci.log`, `static.log`, four
`*-image-build.log` files, `image-build-evidence.json`, `image-evidence.json`
and `pipeline.log` / `pipeline-evidence.json`. The original 85 dirty source
files are preserved byte-for-byte. Main remains reserved for final roadmap
and formal release acceptance. Later phases, enterprise requirements and
issues #69, #90 and the remaining #101 investigation stay open.

## Remaining work

### Next: build follow-up and developer tooling; retain follow-ups #69 and #90

- Reproduce the intermittent server/session hydration recovery, identify the DOM/state
  mismatch and fix its source. Keep strict browser error gates and record a regression
  that demonstrates the failure before the fix. Successful reruns alone do not close it.
- Resolve RustFS empty-bucket cleanup/orphan metadata in #90 with a real regression
  and verified fix; preserve strict lifecycle cleanup gates.
- The npm extraction rejection gate and real regression are implemented in
  [PR #102](https://github.com/mayank-rawat98/NovaGate/pull/102). Investigate the
  original filesystem EFAULT in [issue #101](https://github.com/mayank-rawat98/NovaGate/issues/101);
  a clean retry or injected callback error does not establish its kernel cause.
- Retain #92’s actual Jest/PostgreSQL timeout ownership regression and strict budgets;
  any remaining resource-pressure deadline failures must remain visible.
- Continue later work through the issue → dev branch → tested PR → merge convention.
- Provider/inbox acceptance and at-least-once receiver/provider deduplication remain
  explicit formal acceptance requirements, not locally proven provider guarantees.

### Remaining phase 4 work

- Verify larger external delivery workloads/replicas and actual-provider acceptance.
  Transports, immutable snapshots, bounded durable retries, receipt scheduling,
  authenticated activation, stricter payload policies and metadata-only history
  are merged into dev through PR #96; formal acceptance remains open.
- Bounded per-consumer count/path rollups, idempotent ingestion/backfill, retention
  and explicit materialization coverage are implemented in issue #99. Broader
  workload/window/cardinality/replica acceptance and actual traffic completeness
  remain unproven beyond the finite persisted-record fixtures.
- Formal acceptance for tracing, two-second live metrics, 90-second actual alert delivery,
  private RustFS export and consumer analytics.

### Phase 5 — developer ecosystem

- Declarative configuration is implemented through #103/PR #104; configuration
  history/operator rollback, broader workloads and formal acceptance remain.
- The private `gwx` commands and authenticated live logs are implemented through
  #105/PR #106. Scoped/revocable automation tokens are implemented in #107.
  Enterprise RBAC, package distribution and formal acceptance remain.
- Developer portal: implemented in #109; formal acceptance remains.
- Terraform provider: implemented in #111; registry publication and formal acceptance remain.
- Plugin SDK/third-party loading: implemented in #113 (trust-based, pinned versions, bounded hooks, quarantine and kill switch); npm publication of the SDK, a WASM sandbox (6.6) and formal acceptance remain.
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

## Declarative configuration — issue #103 / PR #104

The preserved local import/export prototype is reconciled onto dev `0b4671e`
without restoring its older Node runtime, unguarded installs or stale rollup code.
The visible workspace is the development branch; all 85 original pending source
files were byte-verified in `.local-work/source-cleanup-20261012` and Git stash
`81642c05611c282de67dc044ddf09b3ad511cced` before cleanup. Nineteen source files
already matched dev. At this checkpoint, the useful CLI/log-stream prototype was
preserved for its separate issue and PR. Issue #105 / PR #106 records that work
and the final source cleanup disposition below.

The authenticated API and Settings now support strict complete YAML/JSON documents,
write-free metadata previews, ten-minute revisions, drift detection and atomic
service/route/consumer reconciliation with the version and durable gateway outbox.
Matching identities, consumer keys and omitted saved plugin credentials survive;
removed entries are soft-deleted/revoked. Route/plugin order survives reconnect.
Exports omit credentials and refuse unsafe or unimportable configurations. New
consumer keys return once after commit; queued delivery is labelled accurately.
See [the operator contract](apps/admin-api/src/config-import/README.md).

Review also fixes unknown target fields and malformed URL-like export metadata.
The parser is pinned to production `yaml` 2.9.1 at the repository's existing root
and admin dependency locations, so production pruning and image copies retain it.
Real HTTP/PostgreSQL checks cover duplicate keys/identities, aliases/tags/multiple
YAML documents, deep parser/visitor inputs, authentication, private errors, stable
identity, ordering, outbox rollback, drift, two-replica races, bounded lock/admission
and shutdown. The maximum 200-consumer replacement reviews and commits all 400
create/remove actions.

Final current-source validation:

- **847 admin / 47 suites, 586 gateway / 38 suites, 115 collector / 7
  suites, 10 dashboard / 3 suites**, with no failures or skips. The final import
  suite contains 22 actual HTTP/PostgreSQL cases. Static checks pass for five
  projects; all four application builds pass. One matching static result was
  reused from Nx cache; the final admin checks are recorded separately.
- Fresh guarded installs in all four Node 26.11.1 images, with no extraction
  diagnostics; all three guarded production prunes pass. All images run as UID 1000. All backend bundles match current host builds byte-for-byte. The final
  admin image contains yaml 2.9.1. Dashboard login and all 16 referenced assets
  return HTTP 200; its Next base-http module is nonempty with the actual request
  constructor, and shutdown exits 0.
- **42 production browser cold loads at sixfold CPU throttling**, followed by
  download/file input, preview failure/retry, editing invalidation, acknowledged
  apply, revision conflict recovery, one-time keys, Escape/focus/Tab, mobile axe
  and two interrupted applies/workspace reset checks. The full verifier completes
  in **153.539 seconds**, with zero runtime or WCAG A/AA findings. The mobile
  drawer screenshot was visually reviewed. Superseded artifacts from older runs
  are excluded from this issue's evidence; their originals remain preserved.
- The fresh-image pipeline verifies actual authenticated export/reviewed apply,
  durable gateway ACK, new-key routing, anonymous rejection, restart/reconstruction
  and idempotent roundtrip. Retained traffic, metrics/SSE/history, private archives,
  privacy/retention and stable signed delivery/retry/revocation still pass. Alerts
  fire in **57.418 seconds**. Automatic timers materialize **200,001 records in
  106.377 seconds**; the authenticated query takes **706.872 ms**, with zero manual
  worker ticks. All three app services exit 0 and owned fixtures are removed.

Evidence: `.local-work/phase5-1` contains current test/static/build logs, guarded
host installs, image logs/IDs/bundle proofs, pipeline evidence, fresh browser
artifacts and source review/merge records. Verification was local; workflow and
deployment triggers remain unchanged. Main stays reserved for final acceptance.

This is a bounded development checkpoint: 200 entries and 64 KiB per complete
configuration document. Larger workloads, scoped automation, CLI distribution, user-facing
configuration history/rollback and formal phase/release acceptance remain open.
Transaction rollback is not an operator rollback feature. Existing issues #69,
#90 and the unproven filesystem cause in #101 remain open.

## CLI and live request logs — issue #105 / PR #106

The remaining useful CLI prototype is reconciled onto dev `00007d3` after PR #104.
The private `@api-gateway/gwx` package contains the bundled executable, its manifest
and operator guide, with no runtime package dependencies. Login/logout, metadata
lists, consumer creation, secret-free export, reviewed exact-byte apply and live
logs use existing tenant JWT sessions. A maximum-size replacement presents all
400 create/remove actions. Named pipes and nonregular credential/document inputs
fail without blocking; saved sessions use private POSIX file/directory modes.

The live-log endpoint admits at most 16 clients, two per tenant, and four database
queries. Receipt cursors are encrypted and tenant-bound; current privacy and
retention project every page. SQL, output, lifetime and closing-response budgets
remain bounded. Shutdown retains ownership of actual streams and pending queries
until they close, including delayed HTTP completion. See [the CLI guide](tools/gwx/README.md)
and [the stream contract](apps/admin-api/src/proxy-config/log-stream.README.md).

Current-source verification:

- **862 admin tests / 48 suites** pass in **271.853 seconds**, including all 15
  actual HTTP/PostgreSQL stream cases. **27 built CLI process/HTTP/file tests**
  pass on Node 26.11.1 in **3.343 seconds** and Node 24.21.0 in **4.026 seconds**.
  These runs have zero failures or skipped cases. A timestamp-tie fixture was
  corrected to use one millisecond-truncated statement timestamp; its original
  failure remains in the local evidence.
- Six projects pass lint/typecheck (12 tasks, three cached results), with two
  existing unrelated fixture warnings and no errors. Five production builds
  pass, with the matching CLI build cached. A real POSIX pseudo-terminal verifies
  hidden password input, declined apply without mutation, Ctrl-C exit 130 and
  EOF without mutation. The gateway, collector and dashboard retain the preceding
  PR #104 regression/browser evidence; their suites were not rerun for this CLI change.
- Four rebuilt images run Node 26.11.1 as UID 1000. Two fresh guarded dependency
  installations supply the shared newly verified install layers reused by the
  collector and dashboard; all three backend production prunes pass. Moving the
  dashboard telemetry setting immediately before its build permits this shared
  layer while retaining disabled build/runtime telemetry. No npm extraction
  diagnostics occur. Backend bundles match current host builds byte-for-byte;
  production yaml is 2.9.1. Dashboard login/all 16 referenced assets return 200,
  its Next.js request constructor is present and shutdown exits 0.

- The CLI tarball is installed outside the checkout and exercised through its actual
  executable: authenticated login/private saved session, metadata lists, consumer
  key routing, secret-free export, mutation-free preview, reviewed apply, gateway
  ACK, anonymous rejection, idempotent preview, privacy-projected live logs and
  logout removal all pass. The package contains exactly README, manifest and bundle.
- The full fresh-image pipeline retains traffic, metrics/SSE/history, private
  RustFS archives, privacy/retention and stable export retry/revocation. Alerts fire
  in **56.863 seconds**. Automatic timers materialize **200,001 records in
  107.016 seconds**; the authenticated query takes **483.671 ms**,
  with zero manual worker ticks. All three services exit 0; owned fixtures are removed.
  Two earlier full runs timed out during alert delivery and automatic receipt
  scheduling while the shared machine was heavily swapping. Both failure records
  remain preserved; the unchanged source/images/assertions/deadlines pass after
  waiting for the competing compiler build to finish. No root-cause proof is claimed.

The complete source backup remains in `.local-work/source-cleanup-20261012`.
All 85 original preserved source hashes are recorded: **19 already merged**, **four
stale/unnecessary changes omitted**, and **62 useful changes integrated or
reconciled** through PRs #104 and #106. Omitted changes comprise an unused generated
CLI debug entry, an older consumer-usage label and two obsolete rollup evidence
paths. Current runtime guards, rollups, UI behavior and verification records remain.
The backup is local evidence, not pending development work. Environment files at
all depths remain ignored and excluded from commits.

Evidence is in `.local-work/phase5-2`: actual test/static/build/terminal logs,
image identities and bundle proofs, packed CLI/runtime evidence and reviewed-source
records. Public npm publication, scoped/revocable automation tokens, enterprise
RBAC, Windows credential-store acceptance and broader workload/provider/comparative
acceptance remain open. This checkpoint does not complete phase 5.2 or a production
release. Main remains reserved for final acceptance.

## Scoped automation tokens — issue #107

Workspace automation tokens replace the full-permission session JWT for
non-interactive use. `ngat_` secrets carry 32 random bytes; the database stores
only their SHA-256 digest and an 11-character display prefix. Tokens expire after
1–365 days (default 90); a workspace holds at most 50 active tokens, serialized on
the workspace row. Revocation is idempotent and immediate; token-authenticated SSE
streams close within 60 seconds so revocation reaches open streams. Last use is
written at most once a minute.

`TenantAuthGuard` accepts a token only on endpoints that declare
`@AutomationScope`, rejecting other endpoints before any database lookup. Fourteen
scopes cover workspace profile, routes, services, consumers, configuration,
logs, analytics and alert rules; write implies read. Import previews need only
`config:read`; apply needs `config:write`. Token management, gateway keys, the mTLS
CA bundle, privacy, retention, archives, export destinations and alert channels are
session-only. See [the token contract](apps/admin-api/src/automation-tokens/README.md).

`gwx tokens list|create|revoke` manage tokens from a signed-in session, and CLI
errors now distinguish a missing scope. Settings → Automation tokens creates tokens
with labelled scope choices, shows the secret once with copy, lists prefix/scopes/
expiry/last use/status and confirms revocation.

The same change rounds consumer-usage percentiles to microsecond precision. The
consumer analytics integration test failed on x86-64 PostgreSQL 16 (39.699999999999996
versus 39.7 ms) because interpolation rounding differs by CPU; rounding makes the
reported value platform-independent.

Verification (Node 26.11.1, local PostgreSQL 16 and Redis 7, x86-64 Linux):

- **857 admin tests / 46 suites pass**; 28 tests in 4 suites skip because they need
  RustFS/S3 fixtures and this environment has no container runtime. The new suites
  cover actual PostgreSQL/HTTP token behaviour (18 cases) and guard decisions (5 cases).
- **35 built CLI tests** (27 existing, 8 new) and **10 dashboard tests** pass.
- Lint and typecheck pass for admin-api, dashboard, gwx and shared-types with only
  the four pre-existing warnings.
- The full production dashboard browser smoke passes, including the new
  automation-token verifier: validation, failed create/revoke with retained input,
  one-time secret absent from browser storage and the list, Escape/focus restoration
  and desktop/mobile axe checks, with zero runtime or WCAG A/AA findings.

Not repeated here: packaged image builds and the packaged CLI/runtime pipeline,
because Docker is unavailable in this environment. Team RBAC, immutable audit
history and formal phase acceptance remain open.

## Developer portal — issue #109

`apps/developer-portal` is a new Next.js 16 app for a workspace's own API
consumers. It runs on a shared host (`/w/:tenantId`) or on a workspace custom
domain resolved by `src/proxy.ts`. The admin API adds `portal/` with settings
(revisioned), a public catalog, developer registration with email confirmation,
sign-in with lockout, and developer keys and usage. Developer sessions use a
derived signing key and a distinct audience, and they end on suspension or
unpublishing. Developer keys are tenant consumers tagged `portalDeveloperId`:
the gateway is unchanged, both ownership columns are stripped from gateway
payloads, and declarative replacement never revokes developer keys. Routes
carry `portal` metadata (`visible`, summary, plain-text description) through the
route API, Settings route editor and declarative documents. The catalog derives
authentication methods and the enforced rate limit, and never exposes upstreams
or plugin configuration. See the
[contract](apps/admin-api/src/portal/README.md).

The catalog work exposed a gateway bug, fixed here: the `rate-limit` plugin
ignored its validated `windowMs`, so 30 per second was enforced as 30 per minute.

Verification (Node 26.11.1, local PostgreSQL 16 and Redis 7):

- 9 real PostgreSQL/HTTP portal cases: settings, catalog leaks, registration,
  lockout, session isolation, keys, usage, suspension and declarative round
  trips. Config-import (22), token (18) and guard suites pass with them. Two new
  gateway rate-limit window tests pass.
- Developer portal: lint/typecheck, 5 component tests, production build, and a
  production browser smoke. The smoke covers catalog/docs, registration and
  verification, keys, usage, sign-in, custom domains via Chromium host mapping,
  CSP/frame headers, mobile layout and axe WCAG A/AA, with zero runtime findings.
  It found and fixed a Next 16 proxy rewrite that self-proxied over HTTP and
  dropped the custom-domain host.
- Dashboard: lint/typecheck/tests and the full production browser smoke with a
  new portal verifier (settings revision conflict, publish with domain,
  suspension, route publication, focus, mobile axe). It found and fixed mobile
  overflow and missing focus restoration in the new panels; the token-panel fix
  is also pushed to PR #108.
- `developer-portal:gateway-e2e` on real processes: route delivery, the
  emailed confirmation link, key creation in the browser, five accepted gateway
  calls plus one invalid-key rejection, five recorded requests in portal usage,
  and revocation reaching the gateway.

Not verified here: Docker image builds (`docker/Dockerfile.developer-portal`, and
the extra manifest copy in the other four Dockerfiles), because this environment
has no container runtime. The compose service sits behind the `portal` profile,
so default deployments are unchanged. Quotas and formal acceptance remain open.

## Terraform provider — issue #111

`integrations/terraform-provider` is a Go provider on the Terraform Plugin
Framework 1.19. It is configured with `api_url`, `tenant_id` and a scoped `ngat_`
automation `token` (or `NOVAGATE_*` variables). It requires HTTPS except on
loopback, refuses redirects, bounds responses at 4 MiB and never retries writes.
Resources:

- services: weighted targets, health settings and load balancing; destroy
  soft-deletes;
- routes: retry, rate-limit override, normalized sensitive plugin JSON and portal
  publication, with explicit nulls when a setting is removed; destroy
  soft-deletes;
- consumers: the key is returned once and held as a sensitive state value;
  name/tier changes replace the consumer and groups update in place; destroy
  revokes;
- alert rules: revision-checked updates and deletes; channels stay in the
  dashboard because they hold credentials.

Data sources cover the workspace profile and consumers by unique name. See the
[provider guide](integrations/terraform-provider/README.md).

Verification (Go 1.25.8, Terraform 1.16.7, Node 26.11.1, local PostgreSQL 16 and
Redis 7):

- `gofmt`/`go vet` clean; client unit tests (configuration validation, token
  header, error mapping, refused redirects, response bound).
- `terraform-provider:acceptance`: a disposable workspace, the built admin API
  and two minted tokens, then the real CLI through create → update (nested
  objects, plugin JSON, set changes, alert revision 2) → clear optional
  settings → import all four resources → destroy. A read-only token is refused
  with the missing `services:write` scope. SQL confirms the route and service
  rows remain with `deletedAt` and the consumer with `revokedAt`. Both tokens
  record last use, and the write token never appears in test output.
- The example configuration validates against the built provider through a dev
  override.

Registry signing/publication and formal acceptance remain open. CI installs Go
and Terraform and runs lint, test, build and acceptance.

## Third-party plugins — issue #113

Gateway operators install plugin packages with npm in a directory mounted into
the gateway and pin each one (`THIRD_PARTY_PLUGIN_DIR`, `THIRD_PARTY_PLUGINS`).
At startup the gateway checks that each installed manifest matches its pinned
name and exact version, and validates the export. It registers the plugin under
its scoped package name, so a plugin can never replace a built-in. At runtime:

- every hook has a deadline; a failing request hook refuses the request
  (`502 PLUGIN_FAILED`), and failing response/error hooks are skipped;
- repeated failures, or an uncaught exception or unhandled rejection whose stack
  points into the plugin's installed directory, pause the plugin for the
  quarantine period (`503 PLUGIN_UNAVAILABLE`); other crashes keep Node's default
  behaviour;
- packages that failed to load, and plugins the workspace disabled
  (`503 PLUGIN_DISABLED`), fail their routes closed.

The gateway reports each plugin's version, state, failure count and bounded
last error to the control plane after authentication, on change and every 60 s.
The control plane validates the report and keeps it in Redis for 180 s; the admin
API re-validates it on read. `GET/PUT /tenants/:id/gateway-plugins` exposes the
report and the disabled list. Writes are session-only, and each change publishes
a configuration version through the durable outbox. Routes, declarative
configuration and the Terraform provider accept scoped plugin names with a JSON
object of at most 16 KiB (up to 32 plugins per route). The portal flags routes
whose third-party policies it cannot describe. The control plane's `auth_ok`
snapshot now also omits the admin-only portal columns, matching published
updates.

Verification (Node 26.11.1, PostgreSQL 16, Redis 7):

- `@api-gateway/api:plugins-e2e`: `npm pack` + `npm install --ignore-scripts`
  of both examples, then built admin API, control plane and gateway. Request and
  response hooks stamp live traffic, and an uninstalled pinned package answers
  503 and is reported `failed`. Timer and unhandled-rejection crashes each
  quarantine the plugin while the gateway process stays up and other routes keep
  serving. The admin kill switch disables and re-enables the plugin on the
  gateway.
- Admin integration (real PostgreSQL/Redis/HTTP): report reads and corrupt
  reports, cross-workspace denial, the outbox version and published payload,
  no-op saves, invalid lists, read-token access with session-only writes, route
  validation bounds and a lossless export → import preview.
- Control-plane integration: tenant-attributed reports with TTL, invalid reports
  ignored, `disabledPlugins` and stripped portal fields in `auth_ok`, and
  tolerance of a schema without the new column.
- Gateway loader specs (pinning, invalid exports, collisions, timeouts,
  quarantine and recovery, crash attribution, disabled list) and SDK specs.
- Dashboard and portal production browser smokes (states, failure retry,
  reversible unreported names, route-editor validation and order, mobile and
  axe WCAG A/AA).

Not verified here: the gateway Docker image with a mounted plugin directory (no
container runtime). npm publication of `@api-gateway/plugin-sdk`, a sandbox for
untrusted plugins (phase 6.6) and formal acceptance remain.
