
# Gateway — apps/api

Runs on user's VPS. Single tenant per instance. No DB connection.
Communicates with control plane via outbound WebSocket only.

## Boot sequence (do not change order)
1. Read GATEWAY_API_KEY + CONTROL_PLANE_URL from env (crash if missing)
2. Attempt WSS auth, 10s timeout
3a. Success: load config from auth_ok → write to Redis cfg:default → serve
3b. Failure: read Redis cfg:default
    - found: log WARN with cache age, serve, retry WSS in background
    - not found: crash with clear message

## Middleware pipeline (order is load-bearing)
JWT → RateLimit → Logging → Proxy

## Redis keys (no tenantId prefix — single tenant per instance)
cfg:default          full config JSON, TTL 7 days
rl:<clientKey>       rate limit sorted set
apikey:<sha256>      consumer key cache, TTL 5min

## Guardrails
- NEVER add tenantId prefix to Redis keys
- NEVER make HTTP response path wait for log writes
- NEVER retry on close codes 4001, 4003, 4004
- NEVER read process.env.GATEWAY_MODE outside GatewayConfigService
- NEVER set cfg:default TTL below 24h
- fail-open on Redis errors (allow request, increment counter)
- path labels in Prometheus must be normalized patterns, never raw URLs