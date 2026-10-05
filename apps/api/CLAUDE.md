# Gateway — apps/api

Runs on user's VPS. Single tenant per instance. No DB connection.
Communicates with control plane via outbound WebSocket only.

## Boot sequence (do not change order)

1. Read `GATEWAY_API_KEY` + `CONTROL_PLANE_URL` from env (crash if missing)
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

| Key               | Purpose                | TTL      |
| ----------------- | ---------------------- | -------- |
| `cfg:default`     | Full TenantConfig JSON | 7 days   |
| `rl:<clientKey>`  | Rate-limit sorted set  | windowMs |
| `apikey:<sha256>` | Consumer key cache     | 5 min    |

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
