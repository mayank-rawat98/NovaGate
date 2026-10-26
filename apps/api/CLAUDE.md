# Gateway — apps/api

Runs on user's VPS. Single tenant per instance. No DB connection.
Communicates with control plane via outbound WebSocket only.

## Boot sequence (do not change order)

1. Read `GATEWAY_API_KEY` + `CONTROL_PLANE_URL(S)` from env (crash if invalid)
2. Attempt WSS auth, 10s timeout
   - Success: load config from `auth_ok` → write to Redis `cfg:default` → serve
   - Failure: read Redis `cfg:default`
     - found: log WARN with cache age, serve, retry WSS in background
     - not found: crash with clear message

## Middleware pipeline (order is load-bearing)

```text
LoggingMiddleware → JwtMiddleware → [RateLimitGuard] → ProxyMiddleware
                                                               ↓
                                                       PluginRunner.onRequest
                                                       → forward to downstream
                                                       → PluginRunner.onResponse
```

- `JwtMiddleware` — attaches `req.user`; never blocks
- `RateLimitGuard` (global guard) — sliding-window Redis check; reads `req.user` for tier
- `LoggingMiddleware` (before authentication) — records actual response finish/close exactly once
- `ProxyMiddleware` → `ProxyService.forward()` — resolves plugins, runs hooks, forwards to downstream

CORS, IP restriction, rate limiting, body size limits, header transforms, and basic-auth are all
handled as **plugins** on the route's `plugins[]` array — not middleware.

## Module structure

```text
gateway/
  auth/
    jwt.middleware.ts               attaches req.user from Bearer token; never blocks
  rate-limit/
    rate-limit.guard.ts             global guard; Redis sliding-window per clientKey
    rate-limit.service.ts           ZADD/ZREMRANGEBYSCORE sorted-set implementation
  proxy/
    proxy.middleware.ts             entry point; calls ProxyService.forward()
    proxy.service.ts                load-balanced forwarding + retry + plugin hooks
    load-balancer.service.ts        weighted round-robin over ServiceConfig.targets
    proxy.controller.ts             wildcard catch-all route
  health/
    health.controller.ts            GET /health
    upstream-health.service.ts      polls targets every 10s; marks unhealthy after 3 fails
  logging/
    logging.middleware.ts           logs actual response completion/cancellation
  metrics/
    metrics.service.ts              prom-client counters/histograms
    metrics.controller.ts           GET /metrics (Prometheus scrape endpoint)
  config-manager/
    gateway-config-manager.service.ts  in-memory TenantConfig + Redis warm-start (cfg:default)
  connector/
    control-plane-connector.service.ts  WSS lifecycle, reconnect, message buffer, config.ack
  telemetry/
    gateway-telemetry.service.ts    batches logs/health/errors/metrics → sends upstream
  circuit-breaker/
    circuit-breaker.service.ts      per-service sliding-window circuits; admissions settle once per attempt
  plugins/
    plugin-runner.service.ts        executes onRequest / onResponse / onError hooks in order
    plugin-registry.service.ts      DI-based registry; resolves plugin instances by name
    gateway-plugin.token.ts         GATEWAY_PLUGIN injection token
    plugins.module.ts               registers all built-in plugins as providers
    cors/                           CORS headers + preflight short-circuit
    ip-restriction/                 CIDR allow/deny check
    rate-limit/                     per-route rate limit override
    request-size-limit/             Content-Length check + streaming byte cap
    request-transform/              add/remove request headers and query params
    response-transform/             add/remove response headers + status override
    basic-auth/                     WWW-Authenticate challenge; credentials stored as SHA-256
    oidc/                           JWKS-based JWT validation (Auth0, Cognito, Keycloak); 24h key cache; kid miss triggers refresh
    oauth2-client-credentials/      token introspection (Redis-cached) OR outbound client-credentials grant injection
    hmac-auth/                      HMAC-SHA256/512 signature validation; timing-safe compare; multi-secret rotation; clock skew check
    acl/                            consumer group allow/deny — reads groups from TenantConfig.consumers
    mtls/                           client cert validation via ssl_client_cert header; uses tenant caCertPem from config
    graphql-guard/                  AST depth/complexity/introspection policy + shared GraphQL-over-HTTP parsing
    graphql-federation/             supergraph execution; ProxyService runs it after auth and metering (#127)
  services/
    service.entity.ts               TypeORM entity for service config
  shared/
    gateway-error.ts                typed error class
    gateway-exception.filter.ts     maps GatewayError → structured JSON response
    redis.tokens.ts                 DI tokens for Redis clients
    request-context.ts              RequestWithUser, ResponseWithLocals types
    route-matcher.ts                shared matchRoute() used by proxy and plugins
```

## Redis keys (no tenantId prefix — single tenant per instance)

| Key                | Purpose                | TTL      |
| ------------------ | ---------------------- | -------- |
| `cfg:default`      | Full TenantConfig JSON | 7 days   |
| `rl:<clientKey>`   | Rate-limit sorted set  | windowMs |
| `apikey:<sha256>`  | Consumer key cache     | 5 min    |
| `meter:<YYYYMM>:*` | Usage meters (#119)    | 40 days  |
| `meter:source`     | Meter source ID        | none     |
| `wasm:<sha256>`    | Verified WASM module   | 30 days  |

## Plugin system rules

- Each plugin implements `GatewayPlugin` from `@api-gateway/shared-types`: `onRequest?`, `onResponse?`, `onError?`
- `PluginContext` carries: `req`, `res`, `route`, `service`, `tenantId`, `requestId`, `logger`
- `onRequest` returning a `PluginShortCircuit` stops the chain and sends that response immediately
- Plugins are resolved by name from `PluginRegistryService`; unknown names are silently skipped
- All 12 built-in plugins are registered via `GATEWAY_PLUGIN` multi-provider token in `plugins.module.ts`
- `requestId` is always present on `PluginContext` — generate UUID in `ProxyService` if absent on `req`
- Phase 2 plugins that need config manager: `acl` and `mtls` inject `GatewayConfigManagerService` directly
- Phase 2 plugins that need Redis: `oauth2-client-credentials` injects `REDIS_CLIENT` token
- OIDC plugin caches JWKS keys in-memory (24h TTL); refreshes on `kid` miss then fails if still not found
- Bounded HMAC `prepareRequest` captures original bytes before body-aware hooks without authenticating; request policies run in saved order. HMAC admission lasts until response finish/close/cancellation. Stripe and custom timestamp modes sign timestamp.body; body-only mode cannot claim replay protection.

## Circuit breaker (issue #115)

`circuit-breaker/circuit-breaker.service.ts` holds per-service circuits for
services whose `ServiceConfig.circuitBreaker` is valid and enabled (it lives
outside `proxy/` because the connector reports it). Every protocol takes an
admission before acquiring a target and settles it exactly once at the upstream
classification point: HTTP/1 `proxyRes`/error/upstream `timeout`/client-socket
timeout, the HTTP/2 result, the WebSocket upgrade/response/error and the gRPC
response headers or connection failure. Unsettled admissions settle as neutral.
5xx, timeouts and connection failures are failures; 4xx, caller cancellation and
client body failures are not. Open circuits refuse before dispatch (`503
CIRCUIT_OPEN` + `Retry-After`, WebSocket 503, gRPC `UNAVAILABLE`); half-open
admits one probe at a time, and a probe unsettled for 3× `openMs` is replaced.
Changing a service's breaker settings resets its circuit. State changes are
reported as `circuit.state` snapshots (debounced 200 ms, heartbeat 30 s).

## WebAssembly plugin sandbox (issue #123)

`plugins/wasm/`: `WasmPluginService` follows `TenantConfig.wasmPlugins` (name,
digest, hooks, allowed hosts), loads modules from memory, then `wasm:<sha256>`
in Redis, else sends `wasm.fetch` and verifies the `wasm.module` reply against
the digest and `inspectWasmModule` (shared-types) before compiling. It registers
a resolver for `wasm:<name>` route plugins in `PluginRegistryService`; anything
not active resolves to `UnavailableWasmPlugin` (503, fail closed). `WasmSandbox`
runs a module in a small pool of `worker_threads` evaluated from
`wasm-worker.source.ts` (plain JS string bundled with the gateway): host-created
memory capped at 160 pages, only the `novagate` host functions, a per-call
deadline (`WASM_PLUGIN_TIMEOUT_MS`, default 50) after which the thread is
terminated, a bounded queue, and `http_get` to allowlisted hosts via a
SharedArrayBuffer while the parent fetches (HTTPS unless
`WASM_PLUGIN_ALLOW_HTTP`). `WasmPlugin` applies header edits or a response, fails
closed (502 `PLUGIN_FAILED`, 503 `PLUGIN_BUSY`/`PLUGIN_UNAVAILABLE`), quarantines
after `WASM_PLUGIN_FAILURE_THRESHOLD` failures and reports `wasm.status` (state,
failures, p50/p99/max µs) on change and every 30 s. Never give the worker WASI,
filesystem, environment or network access. Rebuild fixtures and the catalog
with `node tools/build-wasm-plugins.mjs`.

## GraphQL federation (issue #127)

`plugins/graphql-federation/`: `GraphqlFederationService` registers the
`graphql-federation` plugin and follows `TenantConfig.federatedGraphs`
(supergraph SDL, digest, subgraph → service ID and path). The plugin is HTTP
only and must be the route's last plugin (the admin API enforces this):

- `prepareRequest` captures the body through `RequestBodyService`, which counts
  the plugin as a GraphQL route.
- `onRequest` parses with `graphql-guard/graphql-http-request.ts` and applies
  the token, byte and lexical bounds. Depth and complexity defaults apply only
  when no graphql-guard policy is on the route. It also checks that the graph's
  schema builds (503 `GRAPH_UNAVAILABLE` otherwise).
- It never short-circuits a valid request. `ProxyService.forward` calls
  `execute` after the route `authRequired` check and metering, so schema
  validation (with suggestions hidden) and execution never run for refused
  requests. It then applies onResponse plugins and writes the result, and never
  forwards to the route's service.

The executable schema comes from `getStitchedSchemaFromSupergraphSdl`, cached
per graph by digest. Subgraph executors map the `novagate://subgraph/<name>`
endpoint to the subgraph's service, never to a URL in the SDL. Each call:

- admits the service's circuit;
- takes a lease from the proxy's `LoadBalancerService` over healthy targets;
  the proxy passes `acquire` in, because plugins must not import `proxy/`;
- POSTs `{query, variables, operationName}` to `target + path` with the service
  timeout, sending `X-Request-ID`, the trace context and only the configured
  `forwardHeaders`.

Limits:

- subgraph requests per operation (`GRAPHQL_FEDERATION_MAX_SUBGRAPH_REQUESTS`, 50);
- subgraph response bytes (`GRAPHQL_FEDERATION_MAX_SUBGRAPH_RESPONSE_BYTES`, 8 MiB);
- concurrent operations (`GRAPHQL_FEDERATION_MAX_CONCURRENT_OPERATIONS`, 64).

Failures become GraphQL errors with partial data. The codes are
`SUBGRAPH_UNAVAILABLE`, `SUBGRAPH_TIMEOUT`, `SUBGRAPH_RESPONSE_INVALID`,
`SUBGRAPH_RESPONSE_TOO_LARGE`, `SUBGRAPH_REQUEST_LIMIT` and `CIRCUIT_OPEN`.
Messages never include target addresses.

Responses follow GraphQL over HTTP: request errors are 400 for
`application/graphql-response+json` clients and 200 for `application/json`.
Subscriptions, `@defer` and persisted queries are refused.

## Multi-region control planes (issue #121)

`configuration.ts` parses `CONTROL_PLANE_URLS` (or the single
`CONTROL_PLANE_URL`) into ordered `{ region, url }` endpoints with
`parseControlPlaneEndpoints`. The connector moves the workspace's
`TenantConfig.preferredRegion` to the front, retries a lost session's endpoint
once, then rotates, backing off only after every endpoint failed in turn. After
authenticating anywhere but the first endpoint it closes and returns to the first
after `CONTROL_PLANE_FAILBACK_MS`, doubling (to 1 h) while that stays down; a
preference change moves it after 1 s. `auth` carries a per-process `instanceId`,
`instanceName` and current `configVersion`; `auth_ok` names the region, shown as
`controlPlaneRegion` on `/health`. Telemetry buffered while disconnected drains 4
frames per 50 ms behind which new messages queue in order; config ACKs and pongs
bypass it (control planes close sockets whose queued frames exceed their limit).
Never reconnect on 4001/4003/4004 in any region.

## Usage metering and quotas (issue #119)

`metering/metering.service.ts` counts proxied requests per UTC month in local
Redis (`meter:*`, see REDIS_KEY_DESIGN.md) with one Lua script that refuses a
consumer at `ConsumerConfig.monthlyQuota` without counting. HTTP meters after
the authentication check (preflights excluded); WebSocket upgrades and gRPC
calls meter by `req.user.consumerId`. Refusals are `429 QUOTA_EXCEEDED` with
`Retry-After` and `X-Quota-*` headers (gRPC `RESOURCE_EXHAUSTED`). While
`TenantConfig.suspended.until` is in the future every route is refused before
metering; an expired suspension is ignored without a push. Redis failures
admit the request and increment `gateway_metering_redis_errors_total`. The
connector sends cumulative totals as transient `usage.report` frames, one month
per frame, every 30s and after `auth_ok`.

## Third-party plugins (issue #113)

`plugins/third-party/plugin-loader.service.ts` loads operator-pinned npm packages
from `THIRD_PARTY_PLUGIN_DIR` at module init: the installed manifest must match
the pinned name and exact version, and the export must pass the same checks as
`definePlugin` in `libs/plugin-sdk`. Names are scoped package names, so they can
never replace a built-in plugin. Every loaded package is registered as a
`GuardedPlugin`: hooks have deadlines, request-hook failures fail closed
(`502 PLUGIN_FAILED`), response/error-hook failures are skipped, repeated
failures quarantine (`503 PLUGIN_UNAVAILABLE`) and `TenantConfig.disabledPlugins`
fails routes closed (`503 PLUGIN_DISABLED`). Packages that did not load register
an `UnavailablePlugin` placeholder. The process-level crash guard attributes an
uncaught exception or unhandled rejection to a plugin by the realpath of its
package root in the stack and quarantines it; anything else keeps Node's default
crash. The connector sends transient `plugins.status` reports after `auth_ok`, on
change (debounced 1s) and every 60s. Never let plugin errors carry stacks,
request data or control characters into reports or logs (`sanitizeError`).

## Guardrails

- NEVER add tenantId prefix to Redis keys
- NEVER make HTTP response path wait for log writes
- NEVER retry on WS close codes 4001, 4003, 4004
- NEVER read `process.env` outside `configuration.ts`
- NEVER set `cfg:default` TTL below 24h
- NEVER add CORS/IP/rate-limit as NestJS middleware — use the plugin system
- Fail-open on Redis errors (allow request, increment counter)
- Path labels in Prometheus must be normalized patterns, never raw URLs
- Retry only fires on GET/HEAD/OPTIONS by default — never POST/PUT/DELETE unless route opts in
- Health check unknown state = healthy (avoids dropping traffic at startup)

## GraphQL and body policy invariants

Use shared `RequestBodyService` for original bytes, absolute deadlines and request-lifetime admission. HMAC preparation must run before body consumers. GraphQL uses pinned official AST parsing with lexical/token/byte bounds and memoized fragment DAG summaries; never replace it with regex analysis. Null legacy route policy is disabled. Intersect explicit route/plugin bounds and permit introspection only when all configured policies allow it. Final pure validation follows ordered request hooks. Native protocols reject HTTP-only GraphQL policy and reconcile active streams on policy changes. Log route patterns, never query strings or user agents; request IDs must be validated UUIDs.

HTTP/2 forwarding uses validated `http2` configuration, peer SETTINGS-aware admission and bounded original body capture. Keep stream capacity until close, use absolute deadlines, bound responses/headers and destroy inactive/drained sockets. Configuration removal/tenant changes revoke pooled origins. Only typed predispatch protocol/connection errors permit verified HTTP/1 fallback with remaining deadline; dispatched POSTs and trust failures must never fall back. Proxy handler caching is bounded by `proxy.maxHandlerCacheEntries`.

Load balancing uses `acquireTarget()` leases with bounded service/target/global reservation state and `ServiceConfig.loadBalancing` (weighted round robin by default, or weighted least connections). Hold leases through actual upstream closure, including native gRPC and WebSocket tunnels; safe predispatch HTTP/1 fallback inherits its lease. Every release is idempotent and tied to its original target generation. Current tenant configuration overrides stale hook snapshots. Operator bounds are validated through `loadBalancer` configuration. Never replace runtime leases with nonreserving `selectTarget()`.

HTTP request accounting belongs only in pre-authentication `LoggingMiddleware`. Observe finish/close, never RxJS finalization. Completed responses record the actual final status; incomplete/truncated responses record internal 499 without rewriting the wire response. Use monotonic duration, bounded method labels, normalized configured route patterns (or unmatched for early failures), validated UUID request IDs and no URL/query/user-agent payloads. Rate-limit guards only record quota-specific metrics. Observer/connector failures must not alter authentication or response behavior. Telemetry uses one unreferenced flush timer and clears it while flushing its bounded tail on shutdown.

Tracing work is tracked by issue #61. `OtelService` uses an explicit local SDK provider and per-request contexts rather than registering global instrumentation. Shared wire bounds and whitelisted attributes prevent payload/credential export. Recording, queue and WebSocket buffered-byte admission are finite; transient trace batches never enter the connector reconnect queue. Capture tenant generation at span creation and drop stale exports. Request logs use integer milliseconds for legacy schema compatibility. Request/attempt instrumentation, authenticated storage and the dashboard explorer are verified in #61; formal phase acceptance remains separate.

Issue #63 adds `metrics/metrics-reporter.service.ts`: one unreferenced timer takes a fixed-size aggregate HTTP completion histogram and sends a transient metric snapshot without entering the reconnect queue. Percentiles are bucket upper bounds, capped at one hour. Capture the request tenant at entry and exclude stale completions after tenant replacement. Keep Prometheus counters independent and never wait for reporting on the response path. Reporting config is validated at startup.
