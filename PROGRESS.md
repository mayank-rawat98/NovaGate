# NovaGate progress and remaining work

Updated: **6 October 2026** (Asia/Calcutta).

This report distinguishes merged development work, the alerting foundation checkpoint,
and formal acceptance. The detailed roadmap is [implementation.md](implementation.md).
No whole phase or production release is declared complete by this report.

## Current checkpoint

- Latest merged `dev` checkpoint: **`653d7a00`**, [PR #67](https://github.com/mayank-rawat98/NovaGate/pull/67), including alert storage/evaluation foundations and both roadmap documents.
- Current issue-linked branch: **`65-feat-alert-delivery-and-dashboard`**, created from that dev checkpoint.
- Current issue: [#65 — durable tenant alerting](https://github.com/mayank-rawat98/NovaGate/issues/65), still open.
- Foundation [issue #66](https://github.com/mayank-rawat98/NovaGate/issues/66) is closed. New transport/delivery work under #65 is on the issue-linked branch and unmerged; full alerting remains unfinished.
- AlertsModule contains the controller/evaluator but is **not imported by AppModule**.
  Its endpoints and workers therefore are not enabled in the normal application.
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
  credentials. Scheduled exports and other export destinations remain unfinished.

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

## Issue #65: implemented on the current branch

Storage/CRUD/evaluation foundations were merged in PR #67. Transport and delivery below
are local branch implementation; this is not yet an enabled alert product.

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

New on the current branch (6 October):

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

**Current delivery branch (6 October):** the combined Nx regression run passes
**1,092 tests** (559 gateway, 432 admin, 91 control-plane and 10 dashboard), with
matching cache results reused for two unchanged test tasks. All five projects pass
lint/typecheck and all four application builds pass; the final admin/shared recheck
also passes after sender compatibility changes. Real local HTTP tests cover all
three delivery formats, HMAC/redaction, safe DNS pinning, private/redirect/TLS denial,
byte/deadline/admission bounds, crash/replica recovery, finite retries, live cancellation,
transaction rollback, pool saturation and shutdown. These are not packaged acceptance.

Current tests cover authenticated HTTP routes, credential redaction/encryption/tampering/
rotation, tenant isolation, concurrent capacity/revision races, atomic rollback under a
forced database failure, stale/expired leases, cooldown/resolution/no-data and idle cleanup.

Local evidence lives in ignored `.local-work` artifacts, including:

- `issue65-delivery-all-tests-final.log` — 1,092 regression tests.
- `issue65-delivery-all-gates.log`, `issue65-delivery-gates-final.log` — application/static gates.
- `checkpoint-tests.log`, `checkpoint-static.log`, `checkpoint-build.log` — combined checkpoint gates.
- `issue65-aggregation-tests-recheck.log` — gateway interval foundations.
- `issue65-storage-final-tests.log` — control-plane interval persistence.
- `issue65-evaluator-timer-recheck.log` — 367 admin tests.
- `issue65-evaluator-timer-gates.log` — final admin lint/typecheck/build.
- `issue63-pipeline-shutdown-verified.log` — merged packaged metrics pipeline/shutdown.

Current transport/delivery tests verify actual local HTTP receivers for webhook, Slack
and email payloads; real provider/inbox acceptance and packaged service/browser checks
remain pending. The production images/browser evidence from #63 predates #65 and
does not prove the alert feature.
Formal phase exit criteria, comparative Kong benchmarks and production acceptance
remain unverified. Include sanitized reproducible evidence in each eventual PR.

## Remaining work

### Next: finish issue #65 / phase 4 alerting

1. Build accessible Alerts UI for rules, channels, deliberate secret replacement,
   delivery availability, coverage/no-data/cooldown explanations and recent history.
2. Enable the module once delivery and UI work. Verify fresh production images,
   end-to-end delivered alerts, replica/lease recovery, production desktop/mobile
   browser/accessibility, shutdown and retained gateway/admin/control-plane/storage regressions.
3. Verify provider acceptance/deduplication semantics without treating API acceptance
   as final inbox receipt; document at-least-once delivery and receiver deduplication.
4. Publish sanitized evidence, commit/push on the current issue-linked branch, open a
   PR against dev with `Closes #65`, merge after verification and close the issue.
   Continue later work through the same issue → dev branch → tested PR → merge convention.

### Remaining phase 4 work

- Scheduled/per-tenant exports, configurable external S3-compatible destinations,
  webhook NDJSON and Datadog exporters, with private credentials and redaction controls.
- Per-consumer RPS/error/latency/top-path aggregates, tenant-scoped APIs and dashboard UX.
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
- Complete privacy/redaction and secret-management controls; storage encryption where
  supported, backup/restore drills and documented operational recovery.
- AI token/cost budgets, provider fallback, sensitive-data handling and MCP policy controls.
- Continue modern accessible dashboard UX for every new capability; mobile, keyboard,
  reduced-motion, contrast and real-user usability verification.
- Recheck all phases 0–3 acceptance gaps, including external Auth0/provider behavior,
  protocol conformance and production upgrade compatibility.
- Reproducible NovaGate/Kong benchmarks, security/chaos testing and regional failover drills.
- Run the formal all-phase acceptance campaign after implementation, preserve evidence
  for every exit criterion, and use a separate release gate before any production deployment.
