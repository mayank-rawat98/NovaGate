# Circuit breakers API

Per-service circuit breakers are configured on services (`circuitBreaker` in
`POST/PUT /tenants/:tenantId/services`) and enforced by the gateway. This module
exposes the state the workspace's gateway reports through the control plane.

| Method | Path                                         | Scope           | Purpose                          |
| ------ | -------------------------------------------- | --------------- | -------------------------------- |
| `GET`  | `/tenants/:tenantId/circuit-breakers`        | `services:read` | Latest `CircuitBreakerSnapshot`  |
| `GET`  | `/tenants/:tenantId/circuit-breakers/stream` | `services:read` | Server-sent `circuits` snapshots |

The snapshot comes from `gw:circuits:<tenant>` (90 s TTL; the gateway refreshes it
every 30 s and on every transition). It is re-validated with
`parseCircuitStatuses`; a missing, expired, malformed or unreachable entry reads
as `{ reportedAt: null, services: [] }`. The stream relays `circuits:<tenant>`
publications with the metric stream's connection, per-workspace and lifetime
bounds. It sends the current snapshot first, then each change, plus heartbeats.

Service settings: an object with `enabled`, `windowSize` (5–100),
`failureRatePercent` (1–99, open strictly above), `minimumRequests`
(1–windowSize), `openMs` (1000–300000) and `halfOpenSuccesses` (1–10), or `null`
for none. Create without the field uses `DEFAULT_CIRCUIT_BREAKER`; update without
it keeps the stored value. Existing services migrate to `NULL` (no breaker).

Verification: `circuit-breakers.integration.spec.ts` (real PostgreSQL, Redis and
HTTP: defaults, validation, publication, declarative round trip, snapshot and live
stream isolation).
