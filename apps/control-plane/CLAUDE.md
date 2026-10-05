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

| Type      | Handler                          | Notes                                    |
| --------- | -------------------------------- | ---------------------------------------- |
| `auth`    | `handleConnection`               | Must be first; closes on timeout/invalid |
| `logs`    | `ingestionService.ingestLogs`    | Batched `RequestLog[]`                   |
| `health`  | `ingestionService.ingestHealth`  | `HealthSnapshot[]`                       |
| `errors`  | `ingestionService.ingestErrors`  | `ErrorEvent[]`; control plane sends ACK  |
| `metrics` | `ingestionService.ingestMetrics` | `MetricsSnapshot[]`                      |
| `pong`    | Refreshes `gw:online` Redis key  | Response to server-sent ping             |

## Config push rule

Config updates originate in the **admin-api** `ConfigPushService`:

1. `ConfigPushService.triggerUpdate()` increments `gatewayConfigVersion` in DB
2. Publishes `{ tenantId, config, version }` to Redis `config.update` channel
3. Control plane (`TenantConnectionManager`) subscribes; on message:
   - **online**: send `config.update` WS message immediately
   - **offline**: the admin API already persisted `pending_config_updates`; replay on reconnect

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
