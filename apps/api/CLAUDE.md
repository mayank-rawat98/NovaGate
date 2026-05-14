
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
CorsMiddleware → IpRestrictionMiddleware → JwtMiddleware → RequestSizeLimitMiddleware
  → [RateLimitGuard] → [LoggingInterceptor] → ProxyMiddleware
```

- `CorsMiddleware` — handles `OPTIONS` preflights before any auth runs
- `IpRestrictionMiddleware` — blocks denied IPs early, before JWT work
- `JwtMiddleware` — attaches `req.user`; never blocks
- `RequestSizeLimitMiddleware` — rejects oversized bodies before proxy reads stream
- `RateLimitGuard` (global guard) — sliding-window Redis check; reads `req.user` for tier
- `LoggingInterceptor` (global interceptor) — captures downstream latency
- `ProxyMiddleware` → `ProxyService.forward()` — forwards to downstream

## Module structure

```text
gateway/
  proxy/
    proxy.service.ts                   load-balanced, health-aware forwarding + retry
    load-balancer.service.ts           weighted round-robin over ServiceConfig.targets
    cors.middleware.ts                 per-route CORS headers and preflight responses
    ip-restriction.middleware.ts       CIDR allow/deny per route
    request-size-limit.middleware.ts   Content-Length check + stream byte cap
  health/
    upstream-health.service.ts         polls targets every 10s; marks unhealthy after 3 fails
  shared/
    route-matcher.ts                   shared matchRoute() used by all middleware
```

## Redis keys (no tenantId prefix — single tenant per instance)

| Key | Purpose | TTL |
| --- | ------- | --- |
| `cfg:default` | Full TenantConfig JSON | 7 days |
| `rl:<clientKey>` | Rate-limit sorted set | windowMs |
| `apikey:<sha256>` | Consumer key cache | 5 min |

## Guardrails

- NEVER add tenantId prefix to Redis keys
- NEVER make HTTP response path wait for log writes
- NEVER retry on WS close codes 4001, 4003, 4004
- NEVER read `process.env` outside `configuration.ts`
- NEVER set `cfg:default` TTL below 24h
- Fail-open on Redis errors (allow request, increment counter)
- Path labels in Prometheus must be normalized patterns, never raw URLs
- Retry only fires on GET/HEAD/OPTIONS by default — never POST/PUT/DELETE unless route opts in
- Health check unknown state = healthy (avoids dropping traffic at startup)
