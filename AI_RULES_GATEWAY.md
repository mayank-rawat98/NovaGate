# AI_RULES_GATEWAY.md

These rules encode correctness constraints that are easy to get wrong
and have caused or would cause production incidents. The agent must
follow all of these unconditionally. Deviation requires an explicit
human override with a documented reason.

---

## Rule 1 — Sliding Window is Non-Negotiable

**The rate limiter must use a Redis sorted set sliding window.**

Correct implementation:

```typescript
// Every call must use a pipeline to guarantee atomicity
const pipeline = this.redis.pipeline();
const now = Date.now();
const windowStart = now - this.windowMs;
const key = `rl:${clientKey}`;

pipeline.zremrangebyscore(key, '-inf', windowStart); // evict old entries
pipeline.zadd(key, now, `${now}-${Math.random()}`); // record this request
pipeline.zcard(key);                                  // count in window
pipeline.expire(key, Math.ceil(this.windowMs / 1000)); // auto-cleanup

const results = await pipeline.exec();
const count = results[2][1] as number;
return count <= this.limit;
```

WRONG — do not use this pattern:

```typescript
// Fixed window — resets hard on the minute boundary, gameable
const count = await this.redis.incr(key);
await this.redis.expire(key, 60);
return count <= this.limit;
```

Why: A fixed window allows 2× the limit in a burst (N requests at
:59 + N requests at :00). The sliding window prevents this.
Changing to a fixed window is a product decision, not an
implementation choice.

---

## Rule 2 — Redis Failure Must Fail Open

When Redis is unavailable, the rate limit guard must allow the request
through — not reject it.

```typescript
try {
  const allowed = await this.rateLimitService.check(clientKey);
  if (!allowed) throw new TooManyRequestsException();
} catch (err) {
  if (err instanceof TooManyRequestsException) throw err;
  // Redis is down — fail open, increment error counter
  this.metricsService.increment('gateway_rate_limit_redis_errors_total');
  this.logger.warn({ msg: 'Redis unavailable, failing open', error: err.message });
  // Allow request to continue
}
```

Why: Rate limiting is a traffic management feature, not a security
gate. Taking down the API because Redis is unavailable is strictly
worse than allowing excess traffic temporarily. The error counter
alerts on-call to the Redis issue.

NEVER do this:

```typescript
} catch (err) {
  throw new ServiceUnavailableException(); // blocks all traffic
}
```

---

## Rule 3 — Path Labels Must Be Normalized

Prometheus metric labels that include the request path must use the
matched route pattern, not the raw URL.

```typescript
// CORRECT — cardinality is bounded by number of routes
const routePattern = req.route?.path ?? 'unknown'; // e.g. /users/:id
httpRequestsTotal.labels(method, routePattern, statusCode).inc();

// WRONG — cardinality explodes with user IDs, UUIDs, etc.
const rawPath = req.path; // e.g. /users/a3f2-91bc-...
httpRequestsTotal.labels(method, rawPath, statusCode).inc();
```

Why: Each unique label combination creates a new Prometheus time series.
With raw URLs containing UUIDs, a busy API creates millions of series,
exhausting Prometheus memory and making dashboards unusable. This has
taken down production monitoring.

If `req.route?.path` is unavailable (unmatched routes), use `'unmatched'`
as the path label value — never fall back to the raw path.

---

## Rule 4 — Token Expiry Error Code is a Contract

Expired JWT must return HTTP 401 with exactly this body:

```json
{
  "error": "TOKEN_EXPIRED",
  "message": "Access token has expired",
  "requestId": "<uuid>"
}
```

The frontend refresh interceptor checks for `error === 'TOKEN_EXPIRED'`
to trigger the token refresh flow. Any other error code or shape causes
silent auth failures on the client where requests are dropped instead
of retried with a fresh token.

Never merge `TOKEN_EXPIRED` and `TOKEN_INVALID` into a single generic
`UNAUTHORIZED` code — they require different client handling.

---

## Rule 5 — X-Request-ID Must Propagate

Every proxied request must include the `X-Request-ID` header with a
UUID v4 generated at the gateway. This header must:

1. Be generated if not present in the incoming request
2. Be forwarded to the downstream service
3. Be included in the gateway's log entry for that request
4. Be included in the gateway's response to the client

```typescript
const requestId = req.headers['x-request-id'] as string ?? uuidv4();
req.headers['x-request-id'] = requestId;
res.setHeader('X-Request-ID', requestId);
```

Why: Without this, distributed tracing across the gateway and
downstream services is impossible. Support tickets cannot be
correlated with logs.

---

## Rule 6 — Proxy Path Stripping is Exact-Match Only

When stripping the path prefix before forwarding to downstream:

```typescript
// CORRECT — exact prefix match
const stripped = req.path.startsWith(prefix + '/')
  ? req.path.slice(prefix.length)
  : req.path;

// WRONG — substring replace, can match in the middle of a path
const stripped = req.path.replace(prefix, '');
// /api/users/prefix-injection → /api/users/-injection (wrong)
```

The prefix must also include a trailing slash check to prevent
partial segment matches:

- prefix `/user` must NOT match `/users/123`
- prefix `/users` must match `/users/123` → `/123`

---

## Rule 7 — No PII in Logs or Metrics

The following must never appear in log fields or metric label values:

- Email addresses
- JWT token strings (full or partial)
- Passwords or secrets
- Full IP addresses in metric labels (logs: IP is allowed, metrics: never)
- User-provided free-text strings

If debugging requires seeing a user identifier, log the `userId` (opaque
internal ID) — never the email or name.

---

## Rule 8 — Config Validation Must Run at Startup

`configuration.schema.ts` must validate all required environment
variables when the app starts. The app must crash on startup if any
required variable is missing or malformed.

```typescript
// configuration.schema.ts
export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  REDIS_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  PROXY_TIMEOUT_MS: Joi.number().default(10000),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_UNAUTH_MAX: Joi.number().default(100),
  RATE_LIMIT_AUTH_MAX: Joi.number().default(500),
});
```

A startup crash is preferable to a running service with missing config
that fails silently at runtime.

---

## Rule 9 — Downstream Timeouts Must Be Bounded

Every proxy call to a downstream service must respect the configured
timeout. The default is 10 000ms. Never await indefinitely.

If a downstream times out:

- Return 504 with `{ error: "DOWNSTREAM_TIMEOUT" }`
- Log at `error` level with `downstreamService`, `downstreamLatencyMs`, `requestId`
- Increment `gateway_downstream_timeout_total` counter with `service` label

---

## Rule 10 — New Rules Require a PR

If a new correctness constraint is discovered during implementation
(a new footgun, a new contract requirement), add it to this file in
the same PR that introduces the code change. Do not leave institutional
knowledge only in the PR description.

---

## Rule 11 — Load Balancer Must Never Drop to Zero Targets

`LoadBalancerService.selectTarget()` must never return an empty string or
throw when all upstream targets are marked unhealthy. Fall back to the full
target list so requests continue (with degraded success rate) rather than
failing immediately with a 503.

```typescript
// CORRECT — fallback to all targets when all are unhealthy
const pool = candidates.length > 0 ? candidates : targets;

// WRONG — silently returns '' when all unhealthy
const pool = candidates; // could be empty
```

Why: An all-unhealthy state usually means the health check is misconfigured
or the upstream is in a rolling restart. Returning real 5xx to clients is
better than a gateway-generated 503, since it preserves the actual error
signal and lets retry logic kick in.

---

## Rule 12 — Retry Must Never Fire on Non-Idempotent Methods by Default

`ProxyService` retry is only allowed on `GET`, `HEAD`, and `OPTIONS` unless
the route config explicitly opts in via `retry.methods`.

```typescript
// DEFAULT — safe methods only
const retryMethods = retryConfig?.methods ?? ['GET', 'HEAD', 'OPTIONS'];
const canRetry = maxAttempts > 1 && retryMethods.includes(request.method.toUpperCase());
```

Why: Retrying POST/PUT/DELETE can cause double-writes (duplicate payments,
double inserts). Never enable this by default even if the retry codes match.
If a developer opts in via `retry.methods: ['POST']`, the downstream must be
idempotent — that is their responsibility.

---

## Rule 13 — Health Check Unknown State Means Healthy

When `UpstreamHealthService` has no recorded result for a target URL (e.g.
between startup and the first check cycle), treat the target as healthy.

```typescript
getHealthyUrls(targets) {
  for (const t of targets) {
    const h = this.health.get(t.url);
    if (!h || h.healthy) healthy.add(t.url); // unknown = healthy ✓
  }
}
```

Why: Starting a gateway with zero healthy targets (because checks haven't
run yet) would drop all traffic in the first 10 seconds. Unknown targets
should be tried; the health check will evict them if they fail.

---

## Rule 14 — CORS Preflight Must Not Reach Downstream

`CorsMiddleware` must respond to `OPTIONS` requests with `204` and return —
it must never call `next()` for preflight requests.

```typescript
if (req.method === 'OPTIONS') {
  res.status(204).end(); // ← return here
  return;               // never falls through to proxy
}
next();
```

Why: If a preflight reaches the downstream, CORS headers are set by both
the gateway and the downstream. Double headers cause browser rejections.
Some downstreams also don't handle OPTIONS and return 405.

---

## Rule 15 — IP Restriction Reads X-Forwarded-For First

`IpRestrictionMiddleware` must prefer `X-Forwarded-For` over `req.ip`
because the gateway sits behind a load balancer or reverse proxy.

```typescript
const fwd = req.headers['x-forwarded-for'];
if (fwd) {
  return (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
}
return req.ip ?? null;
```

Why: `req.ip` is the IP of the last hop (the load balancer), not the
client. Using it would block the load balancer or allow all clients.
Only use `req.ip` as a fallback for local/direct deployments.
