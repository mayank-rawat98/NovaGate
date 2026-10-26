# Anomaly detection — issue #117

Statistical per-route anomaly detection (roadmap 6.1). No model is trained;
every value is a z-score against the route's own history.

## How it works

- **Routes.** A route is `method` plus the normalized `path` the gateway logs (the
  configured route pattern). Request logs are grouped by trusted database receipt
  time (`receivedAt`), not the gateway's timestamp.
- **Baseline.** Completed 15-minute windows go into `route_traffic_windows`: requests,
  5xx count and p95 latency per route, retained for 7 days and capped at 200 routes
  per window. A window is materialized one minute after it ends, at most 16 per
  evaluation while catching up. A new workspace starts 24 hours back. A window whose
  query misses its 10 s deadline is skipped rather than retried forever.
- **Current window.** The last 5 minutes per route, evaluated every minute
  (`ANOMALY_EVALUATION_INTERVAL_MS`, 1000–3600000, default 60000).
- **Scores** (with at least 4 baseline windows):
  - **5xx rate, upward.** Windows with at least 10 requests. The z-score uses a
    standard deviation of at least `max(0.5%, 10% of the mean)`, and the rise must
    be at least 2 percentage points.
  - **p95 latency, upward.** Same windows. The deviation floor is
    `max(2 ms, 5% of the mean)`, and the rise must be at least `max(20 ms, 25%)`.
  - **Traffic, spikes and drops.** Requests per second, zero-filled over every
    window since the route first appeared. A spike must be at least 1.5× the mean;
    a drop must be at most half the mean. Drops count only for routes that are still
    configured and enabled, and only when the baseline expects at least
    `minRequests` in 5 minutes.
  - Rates and latency need at least `minRequests` requests in the current window.
  - A finding needs `|z| ≥ zThreshold` (2–10, default 3).
- **Lifecycle.** A new finding opens an `anomalies` row (at most one active row per
  route and metric, and at most 10 new ones per evaluation). Seeing it again updates
  it in place. After 3 consecutive evaluations without it, it resolves. Resolved
  anomalies are kept for 30 days, with at most 1,000 rows.
- **Alerts.** Opening and resolving insert `alert_events` rows (`ruleId` NULL,
  `"anomalyId"`, and an `anomaly` JSON description with the summary). They also
  queue `alert_deliveries` for the workspace's selected channels (at most 5). From
  there the Phase 4 delivery worker handles signing, retries, history and
  channel-change cancellation unchanged. Webhook payloads carry `event.anomaly`;
  Slack and email text use its summary.
- **Coordination.** `public.anomaly_schedule` holds one lease row per workspace,
  claimed with `FOR UPDATE SKIP LOCKED`. The final write re-checks the lease token,
  and window materialization advances its cursor by compare-and-set, so replicas and
  expired leases never double-count. Turning detection off resolves open anomalies
  without notifications and pauses baseline collection.

Runs in admin-api next to the Phase 4 evaluator and delivery worker, because they
own the alert tables and channel credentials. The roadmap placed it in the control
plane.

## API

| Method | Path                                       | Scope          |
| ------ | ------------------------------------------ | -------------- |
| `GET`  | `/tenants/:id/anomalies?state=active\|all` | `alerts:read`  |
| `GET`  | `/tenants/:id/anomaly-settings`            | `alerts:read`  |
| `PUT`  | `/tenants/:id/anomaly-settings`            | `alerts:write` |

`PUT` takes exactly `enabled`, `zThreshold` (one decimal place), `minRequests`,
`channelIds` (workspace channels, at most 5) and `expectedRevision`. A stale
revision gets 409.

## Verification

- `anomaly-scoring.spec.ts`: statistics, guards and descriptions.
- `anomalies.integration.spec.ts` runs on real PostgreSQL:
  - materialization from backdated receipts, and quiet behaviour on normal traffic;
  - opening with an event and deliveries, in-place updates, and calm resolution
    with a resolved event;
  - error spikes, and drops limited to configured routes;
  - disabled detection, missing baselines and settings validation.
- `admin-api:anomaly-e2e`: seeded baseline windows, then the real gateway, control
  plane and admin API. A latency spike delivers a signed webhook alert, about 6 s
  after injection in the recorded run.
