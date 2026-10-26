# Control Plane — apps/control-plane

WebSocket server. Manages `Map<tenantId, WebSocket>` of live connections.
Receives logs/health/errors/metrics from gateways. Pushes config updates down.

## On new connection

1. Expect `auth` message within 5s or close(4002)
2. Hash key SHA-256, look up in `public.api_keys`
3. Not found → close(4001). Found → send `auth_ok` with full `TenantConfig` + `configVersion`
4. Flush any rows from `pending_config_updates` for this tenant (deliver + retain until config.ack)
5. Register socket in `connections` map; set `gw:online:<tenantId>` in Redis (TTL 90s)

## Module structure

```text
ingestion/
  trace-ingestion.service.ts   validated bounded trace batches, tenant storage and retention
  trace-ingestion.service.spec.ts
  log-ingestion.service.ts     writes logs/health/errors/metrics to tenant_<id> schema tables
tenant-connection/
  tenant-connection.manager.ts WebSocket server, auth, heartbeat, inbound message dispatch
config/
  tracing.configuration.ts     validated ingestion and socket admission budgets
  tracing.configuration.spec.ts
database/
  entities/                    TypeORM entities for public schema (Tenant, ApiKey, PendingConfigUpdate)
```

## Inbound message types (gateway → control-plane)

| Type             | Handler                                                                                       | Notes                                                     |
| ---------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `auth`           | `handleConnection`                                                                            | Must be first; closes on timeout/invalid                  |
| `logs`           | `ingestionService.ingestLogs`                                                                 | Batched `RequestLog[]`                                    |
| `health`         | `ingestionService.ingestHealth`                                                               | `HealthSnapshot[]`                                        |
| `errors`         | `ingestionService.ingestErrors`                                                               | `ErrorEvent[]`; control plane sends ACK                   |
| `metrics`        | `ingestionService.ingestMetrics`                                                              | `MetricsSnapshot[]`                                       |
| `pong`           | Refreshes `gw:online` Redis key                                                               | Response to server-sent ping                              |
| `plugins.status` | `parsePluginStatuses` → Redis `gw:plugins:<tenant>` (TTL 180s)                                | Third-party plugin states; invalid reports are dropped    |
| `circuit.state`  | `parseCircuitStatuses` → Redis `gw:circuits:<tenant>` (TTL 90s) + publish `circuits:<tenant>` | Per-service circuit snapshot; invalid reports are dropped |
| `usage.report`   | `parseUsageReport` → `public.usage_meters` / `consumer_usage_meters` (GREATEST per source)    | Cumulative monthly totals; dropped before admin migration |
| `wasm.fetch`     | Replies `wasm.module` with this workspace's module of that digest (base64) or `null`          | Never another workspace's modules                         |
| `wasm.status`    | `parseWasmStatuses` → Redis `gw:wasm:<tenant>` (TTL 180s)                                     | WASM plugin states and timings; invalid reports dropped   |

## Regions and several gateways per workspace (issue #121)

`CONTROL_PLANE_REGION` labels this control plane (returned as
`controlPlaneRegion` in `auth_ok`). `connections` holds a set of sockets per
workspace with a `GatewaySession` per socket (instance ID, sent/acknowledged
version): publications go to every socket and error ACKs return on the socket
that sent the errors. Presence is written best effort to the admin-owned
`public.gateway_instances` (insert on auth, `lastSeenAt` on pong, version on
`config.ack`, `disconnectedAt` on close; missing table or column is ignored).
Every `CONTROL_PLANE_CONFIG_SYNC_INTERVAL_MS` (default 5000) the control plane
compares each connected workspace's `tenants."gatewayConfigVersion"` with what its
sockets acknowledged and sends the assembled configuration to sockets that are
behind (resend after 30 s without ACK). Regions with separate Redis never see
each other's publications; this database sync is what delivers them. Initial
snapshots include `preferredRegion` (tolerant read) and `wasmPlugins` (name,
digest, hooks, allowed hosts; empty when the admin-owned `wasm_plugins` table is
missing), never module bytes.

Initial `auth_ok` snapshots include `suspended` from `tenants."quotaSuspendedUntil"`
(tolerant read; only a future time is sent), matching the admin API's published
configuration (issue #119).

## Config push rule

Config updates originate in the **admin-api** `ConfigPushService`:

1. `ConfigPushService.triggerUpdate()` increments `gatewayConfigVersion` in DB
2. Publishes `{ tenantId, config, version }` to Redis `config.update` channel
3. Control plane (`TenantConnectionManager`) subscribes; on message:
   - **online**: send `config.update` WS message immediately
   - **offline**: the admin API already persisted `pending_config_updates`; replay on reconnect

Declarative import uses `persistUpdate()` in the same transaction as all service,
route and consumer changes, then publishes after commit. Initial connection
snapshots must honor route `configOrder` before creation time/ID, as publication
does. The collector query tolerates legacy schemas missing order/creation-time
columns; schema upgrades remain admin-owned. Preserve plugin array order.

## Close codes (defined in `libs/shared-types/src/lib/ws-close-codes.ts`)

| Code | Meaning      | Gateway should reconnect? |
| ---- | ------------ | ------------------------- |
| 4001 | Invalid key  | No                        |
| 4002 | Auth timeout | Yes (after backoff)       |
| 4003 | Key rotated  | No                        |
| 4004 | Suspended    | No                        |

## Heartbeat

- Server pings all connections every 30s
- On `pong`: refreshes `gw:online:<tenantId>` Redis key (TTL 90s)
- Sockets not responding to ping are removed from the connections map

## Guardrails

- NEVER retry on behalf of the gateway — reconnect is the gateway's job
- NEVER hardcode close codes — import from `@api-gateway/shared-types`
- NEVER skip `pending_config_updates` flush on reconnect
- NEVER assume `config.update` is delivered — persist before publication and retain until config.ack
- Config version comes from the DB (`gatewayConfigVersion`) — never use `Date.now()` as the version

Typecheck declarations and build info live under `out-tsc/typecheck`, separate from Webpack's cleaned `dist` directory so concurrent build/typecheck tasks cannot erase each other's outputs.

Issue #61 adds trace ingestion under authenticated socket tenant IDs. Trace payloads cannot choose a tenant. Bound WebSocket message bytes, queued messages/bytes and global active ingestion; reject malformed trace batches before SQL. Each tenant trace write takes a transaction-scoped lock with statement/lock deadlines and enforces retention plus a hard row bound. Gateway trace export is best effort. New schema creation belongs to admin provisioning/migrations; control-plane ingestion never creates tenant tables.

Trace retention also runs for idle tenants: a single non-overlapping lifecycle timer visits at most 64 trace tables per tick using a schema cursor. Discovery and deletion use statement deadlines, shared ingestion admission and the same per-tenant advisory lock. Clear the timer and await in-flight cleanup on shutdown. Never interpolate a discovered schema without validating its canonical tenant UUID shape.

Issue #63 extends metrics ingestion: validate the five numeric wire fields before SQL; tenant attribution comes from the authenticated socket. Admit a finite number of active transactions and serialize each tenant's retention/row trimming with statement and lock deadlines. Publish only the canonical stored snapshot, after commit, to `metrics:<tenant UUID>`. Preserve fractional RPS with admin-owned migrations and finite Redis publication behavior.

Metric idle retention uses a single non-overlapping lifecycle timer over at most 64 validated metric tables per tick, sharing ingestion admission and the same per-tenant lock/deadlines. Continue past a failed tenant, clear the timer and await in-flight cleanup on shutdown.

Issue #65 adds optional validated interval metadata to the metric wire payload.
Require count/histogram/scalar coherence before SQL. Persist the normalized
aggregateWindow JSONB alongside the summary; old five-field frames store NULL.
Admin migrations must add this column before deploying the updated control plane.
Return and publish only the existing canonical summary fields, never private or
unvalidated metadata. Actual PostgreSQL/WebSocket checks cover authenticated
attribution, histogram preservation, legacy nulls and unchanged live payloads.

Issue #72 adds database-owned request-log receipt timestamps. Admin migrations own
column/default/index creation and UTC normalization. Log JSON record insertion must
override receipt in SQL after admission and the canonical tenant receipt lock; do
not trust gateway receipt fields or bypass INSERT SELECT defaults. Scheduling shares
this transaction lock through commit. Keep log batches/bytes/actual transactions
bounded, with local statement/lock deadlines, finite pool acquisition and shutdown
drain. Real checks retain legacy optional-column conversion, reject blocked writes
within the lock deadline, and prove successful retry and receipt preservation on
replayed IDs.

Issue #76 canonicalizes consumer UUID attribution before JSON record conversion.
Malformed legacy principal IDs become unassigned logs; keep their request records,
receipt lock/default behavior and duplicate IDs intact. Arbitrary gateway/provider
principals are not consumer IDs. Verify mixed batches on actual modern and legacy
schemas and through authenticated production fixture sockets.

Issue #82 aligns trace/metric SQL retention with elapsed 24-hour days. Use
`make_interval(secs => $1::integer * 86400)` in both active and idle cleanup;
calendar-day intervals shift cutoffs during daylight-saving changes. Keep inclusive
retained boundaries, existing advisory locks, row caps and deadlines. Real PostgreSQL
regressions cover UTC/New York/Kolkata sessions and spring/autumn microsecond edges.

Issue #84 extends the shared request-log privacy redactor to six stored metadata
fields. Read persisted policy under the existing receipt-ingestion lock, then redact
legacy frames before JSON record conversion. Preserve authenticated socket tenant,
primary log UUID, receipt, method, status and duration; never accept caller-selected
tenants. Malformed explicit metadata selections fail closed. Selected paths/request
IDs use the required-column placeholder; optional consumer/service/trace/span values
become NULL. Admin owns existing schema upgrades; deploy updated collectors before
enabling selections. Verify actual WebSocket/PostgreSQL persistence, not only mocks.

Consumer rollup storage adds admin-owned statement hooks to request_logs. Preserve
the collector's canonical receipt lock, bounded INSERT and ON CONFLICT DO NOTHING:
the transition table aggregates only newly persisted IDs and shares their commit.
Do not propagate gateway-selected usageRollupVersion or pathRollupVersion; the collector whitelist leaves
both NULL in JSON record conversion and the database materializer owns them. Migration installs all rollup DDL; the collector
does not create it. Aggregate write failure must reject the log transaction, so
there is no successful ACK with a partially committed count. The public analytics
API keeps exact raw-log statistics for small windows and automatically uses bounded
rollup reads with explicit coverage for larger windows. Preserve scalar source
fields and database-owned markers needed for exact request/receipt edge reads.
Path groups have an independent capped store/marker and share source commit,
receipt fencing and privacy projection. Path capacity cannot discard logs or stop
count ingestion. Historical path omission merges redacted groups without replay;
consumer omission and receipt cleanup erase both stores. Public high-volume path
reads reconcile their own pending/edge records within the count snapshot, validate
full counts/histograms before selecting global top-ten groups and expose independent
path coverage. The final policy-revision guard applies to both readers.
Pending source inserts also commit an admin-owned durable wake-up. It has one row
per tenant and carries no source identity or payload. Preserve receipt fencing;
ingestion must not acquire a public tenant write lock after the receipt lock.
Notification persistence failure rejects the source transaction and its ACK.
