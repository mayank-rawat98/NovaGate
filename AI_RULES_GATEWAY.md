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
pipeline.zcard(key); // count in window
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
  this.logger.warn({
    msg: 'Redis unavailable, failing open',
    error: err.message,
  });
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
3. Be included in the gateway's log entry unless the tenant explicitly redacts request correlation IDs
4. Be included in the gateway's response to the client

```typescript
const requestId = (req.headers['x-request-id'] as string) ?? uuidv4();
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
const stripped = req.path.startsWith(prefix + '/') ? req.path.slice(prefix.length) : req.path;

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

## Rule 12 — Retry Must Never Fire on Body-Bearing Methods

`ProxyService` retry is only allowed on `GET`, `HEAD`, and `OPTIONS`. Even if
`retry.methods` includes `POST`, `PUT`, `PATCH`, or `DELETE`, the gateway must
not retry because the request body cannot be safely replayed.

```typescript
// DEFAULT — safe methods only
const retryMethods = retryConfig?.methods ?? ['GET', 'HEAD', 'OPTIONS'];
const requestMethod = request.method.toUpperCase();
const canRetry = maxAttempts > 1 && ['GET', 'HEAD', 'OPTIONS'].includes(requestMethod) && retryMethods.includes(requestMethod);
```

Why: Retrying POST/PUT/PATCH/DELETE can cause double-writes (duplicate payments,
double inserts) and the request body cannot be replayed without buffering. Until
we implement explicit body buffering, retries must be limited to safe methods.

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
  return; // never falls through to proxy
}
next();
```

Why: If a preflight reaches the downstream, CORS headers are set by both
the gateway and the downstream. Double headers cause browser rejections.
Some downstreams also don't handle OPTIONS and return 405.

---

## Rule 15 — Forwarding headers require explicit proxy trust

Use Express `req.ip` with the validated `TRUSTED_PROXY_CIDRS` configuration. Never prefer raw `X-Forwarded-For` from an untrusted socket peer. Native protocol handlers use the socket peer and apply explicit trusted proxy policy before interpreting forwarding assertions. Forwarding headers never establish certificate trust.

---

## Rule 16 — Authentication caches cannot transfer trust

Cache keys must hash tenant identity, the effective provider endpoint/trust configuration, credentials and token identity. Credential rotation or a different tenant must require fresh verification. Raw credentials never appear in keys or logs. A Redis error or malformed cache entry cannot establish authentication; verify remotely or reject. Bound active introspection caching by both token expiration and the operator revocation-staleness limit. Outbound OAuth injection never authenticates an inbound client.

Remote verification uses verified HTTPS by default, no redirects, an absolute deadline, byte/header/token limits and bounded concurrent admission. Retain capacity for cancelled operations until they actually settle. Shared work may survive one caller cancelling, but aborts when its last caller leaves. Unknown signing-key refreshes are throttled, and public keys must explicitly match permitted algorithms and signing use. Remove client-asserted claim headers before forwarding verified claims.

## Rule 17 — A public certificate is not proof of possession

Required mTLS authentication needs an actual verified TLS peer certificate, including on resumed sessions. A signature on a public certificate alone cannot authenticate the sender. Forwarded certificate assertions default off and are accepted only from explicitly trusted socket-peer proxy CIDRs with a verifying terminator that overwrites both certificate and SUCCESS status. X-Forwarded-For never establishes this trust. Native OpenSSL/terminator path and revocation checks are required before tenant-current anchor checks; clientAuth usage, valid CA bundles, finite bytes/chain depth and safe fingerprint identity are mandatory. Trust changes revoke affected gRPC calls and WebSocket tunnels.

## Rule 18 — Webhook freshness must be signed

Never authorize from a timestamp checked independently of the signature. Stripe and custom timestamp modes sign exact timestamp.body bytes, require canonical numeric timestamps and validate freshness again after body capture. Generic body-only signatures cannot claim replay prevention. Require exact-length hex before decoding and constant-time comparison for every bounded rotation key/signature. Use original wire headers, reject duplicates and capture original bytes under size/deadline/admission limits before body-aware policy hooks. Preparation must never authenticate or transform a request; ordered policy execution remains unchanged. Keep admission until response completion/cancellation. Preserve application event-ID deduplication and legitimate delivery retries.

## Rule 19 — GraphQL policies require bounded AST analysis

Use the pinned official parser with byte, token and lexical nesting limits. Validate operation selection and the entire fragment dependency graph. Memoize fragment summaries, saturate costs at policy bounds and include repeated spreads without exponential expansion. Guard all supported transports and revalidate effective requests after transformations. Unsupported batches, persisted operations and subscriptions must fail closed. Share bounded original body capture with HMAC and size policies; hold admission through response completion. Reject duplicate plugins and HTTP-only policies on native listeners, including revoking affected streams after configuration changes. Logs and metrics use route patterns, never GraphQL query text or caller-supplied arbitrary IDs.

## Rule 20 — Pool admission and fallback must preserve dispatch safety

Bound targets, sessions, streams, pending setup, headers and response bytes. Peer SETTINGS must arrive before application dispatch; do not queue past advertised capacity. Idle eviction must close sockets, GOAWAY must prevent reuse, and active capacity remains held through actual stream closure. Use absolute deadlines, including continuously active streams, and cancel on caller/shutdown/configuration removal. HTTP/1 fallback is limited to classified predispatch connection/protocol failures; never retry certificate failures, resource exhaustion or already-dispatched mutations. Preserve verified TLS, original bytes, remaining deadline and plugin response/error hooks. Bound fallback handler caches and omit raw targets/errors from telemetry.

## Rule 21 — Balancing reservations follow actual upstream lifetime

Acquire an atomic weighted target reservation immediately before dispatch. Release exactly once after actual HTTP request, HTTP/2 or gRPC stream, or WebSocket tunnel closure; failures before dispatch release after admission settles. Preserve the reservation across safe negotiation fallback. Bound service, target and global active state, including removed generations. Late releases retain captured target objects and cannot decrement replacement configurations. Current tenant topology is authoritative after awaited hooks; health filtering and explicit fallback remain mandatory. Least-connections counts work per gateway replica, not fleet-wide sockets.

## Rule 22 — Observe responses after they finish

Attach HTTP observation before authentication and guards. Hold active request accounting through actual response finish/close, emit once and remove listeners. Record final filter status after completed responses; use internal 499 for interrupted responses rather than false success. Duration is monotonic. Labels use known methods and configured route patterns, never caller URLs, queries or user agents. Validate request IDs before use. Guards must not duplicate general logging/counters. Observation failures cannot change request outcomes; telemetry timers and batches have explicit shutdown cleanup. These are best-effort logs, not a durable audit trail.

## Rule 23 — Field redaction changes observations only

Tenant-selected request-log metadata redaction never changes live request IDs,
consumer identity, routing, authentication, ACL or rate-limit inputs. Preserve
primary log IDs, receipt timestamps and response outcomes. Apply the union of
request-start and request-finish omissions to telemetry and local JSON output.
Use only the shared bounded field inventory; unknown or duplicate field selections
are invalid. Collectors and current historical reads enforce persisted policy before
exposing records. Consumer attribution and path grouping must respect current privacy
while erasure is pending. Separate trace/error storage has separate policies.

## Rule 24 — External export identities and lifetime are part of delivery correctness

External log transports serialize only the bounded documented record shape after
applying the stricter tenant/destination privacy policy. Webhook HMAC authenticates
timestamp, stable delivery ID and exact NDJSON bytes together. S3 uses the official
SigV4 signer, one PUT and a stable tenant/destination/delivery object key. Datadog
correlation IDs do not establish provider deduplication. A provider HTTP acknowledgement
cannot establish indexing, inbox delivery or exactly-once behavior.

Use the shared all-answer DNS-pinned boundary with verified TLS, no redirects and a
dedicated operator-owned export trust allowlist. Never inherit alert trust exceptions
or platform storage credentials. Hold transport admission through actual resolver and
socket settlement, including cancellation/shutdown; workers own durable retries and
must fence destination, privacy and retention revisions. Transport availability alone
never enables stored draft connections.

Receipt scheduling commits the precise receipt/UUID cursor and immutable provider-sized
batch in one transaction under the ingestion lock. Use settled UTC minute/hour windows,
bounded source text reads and pages, fair replica discovery and durable capacity checks.
Queue/history pressure preserves unprocessed receipts. Retention advancement records
skipped elapsed time; invalid/filtered records have separate counters. Pause stops new
admission while already queued batches retain their retry identity. Cadence/filter saves
preserve the cursor; payload-policy changes revoke old bytes through destination revision
fencing. No network operation belongs inside the source transaction.

Bound scheduled metadata independently of selected-record caller identities. Compact
only terminal scheduled rows in bounded pages; never remove queued/processing retry
identities or young caller identities to admit an automatic batch. Serialize admission
and final acknowledgement with the tenant admission lock, and preserve the cursor when
concurrent cleanup owns excess rows at the hard automatic limit. Scheduled source kind
survives schedule removal. Commit deletion and workspace outcome/record-occurrence
coverage together in one fixed summary row; expose exact decimal counters and the
history age/row/read limits. Do not imply complete per-delivery history after compaction,
unique exported records across destinations, or provider deduplication.

Do not hold the discovery timer while waiting for provider responses. Reserve only
free worker slots, keep at most one owned attempt per destination per instance and
hold that ownership through actual socket/poll/final-write settlement. Source sweeps
must remain non-overlapping; shutdown drains both sweeps and independent attempts.
Automatic dispatch must claim only scheduled batches still bound to the current
schedule, even if older caller batches share the same destination.

Public activation requires the tenant session, strict supported configuration and
both destination/schedule revisions. Credential storage never enables delivery.
Expose only safe metadata and bounded history/coverage, not arbitrary enqueue,
payloads, source IDs, provider bodies or credentials. Permit pause/removal when keys
are unavailable or saved filters became private. Automatic schedule removal revokes
only scheduled pending leases/bytes; retain caller identities and terminal source
markers. Recreating starts at the new database save receipt. Enabled means configured;
provider acknowledgement does not establish health or indexing.

## Rule 25 — Consumer rollups preserve source identity, privacy and receipt expiry

Materialize only inserted persisted-log IDs; row markers and aggregate updates
commit with ingestion. Replayed IDs cannot increment counts. Admin owns all schema
and hook installation; collectors keep receipt locks, batch/byte limits and reject
failed log transactions. Indexed legacy backfill, cleanup and replica discovery
remain bounded and owned through shutdown. Capacity leaves raw records pending;
it cannot silently drop source records or publish complete coverage.

Use versioned fixed histograms and integer merge/rank arithmetic. Label upper-bound
estimates separately from interpolated observed percentiles. Consumer omission
stops attribution immediately and old aggregate identities must be erased before
omission can be reversed. Keep internal source markers out of reads and archives.
Retention follows trusted receipt floors. Reads must reconcile mixed minute
cells at exact request/receipt boundaries and validate current policy revisions;
whole-cell sums must not include expired observations. Backfill completion only
describes available persisted records, never guaranteed traffic or billing coverage.
Excess cell/raw reconciliation and unsafe integer totals fail without partial
publication. Preserve source/method/coverage metadata in filtered REST metrics;
missing latency samples remain distinguishable from measured zero. UTC edge rates
use actual observed durations. Legacy unavailable path aggregation must be explicit.

Path dimensions use an independent marker and cap so count ingestion can continue
under path pressure. Strip query strings and bound path/method prefixes before
storage. Fresh omitted paths are projected before materialization; historical
redaction must merge exact counts/histograms into redacted groups in bounded pages,
without resetting markers or permitting metadata resurrection. Consumer omission
and receipt expiry clean both stores. Path reads reconcile their own pending/edge
records in the count reader's snapshot and validate all grouped counts and histogram
bins before publication. Select the global top ten after summing all groups, never
per-cell top-ten candidates. Project current path privacy before grouping historical
cells and raw edges. Query limits refuse the entire response without partial totals;
coverage reports all groups and independent path capacity/backfill state. Receipt
lock contention gets a bounded short retry; actual aggregate failures keep their
one-minute cooldown and every transaction retains its SQL and lock budgets.
Pending ingestion must wake recently idle tenants through the durable one-row
notification, not by updating the public tenant row while holding the receipt
fence. Discovery must not lock notifications before that fence. Acknowledgement,
source markers, aggregates and pending state remain atomic; startup recovers
indexed pending notifications and queue-write failure rolls back ingestion.
Privacy discovery must also fall back to a bounded wait when all pending tenants
are briefly locked. Preserve current cursor/revision ownership and source-row
erasure; aligned replica timers cannot silently discard every cleanup sweep.

## Rule 26 — Declarative apply preserves reviewed state and durable delivery

A configuration document replaces the complete active service, route and consumer
set. Validate the entire bounded document before writing. Preview must not write or
expose credentials/hashes; its keyed revision binds the workspace, complete current
private snapshot, normalized desired document and expiry. Apply must fence ordinary
CRUD writes and recheck that revision under the same transaction that reconciles
rows, version and durable outbox. Expiry, drift, edits and replica races require
another preview; database failures leave no partial import. Preserve matching IDs,
consumer keys, omitted matching private plugin fields and ordered routes/plugins.
Never revive revoked keys. Exports omit secrets and refuse unsafe or unimportable
documents. New plaintext consumer keys return once after commit; queued delivery
does not imply a gateway ACK. Browser cancellation cannot promise server rollback.

## Rule 27 — CLI sessions and live logs preserve the tenant boundary

Bind stored CLI credentials to the validated API URL and workspace; refuse
redirects and unsafe URL credentials/query strings. Use private owned atomic
credential files and hidden terminal input before displaying a password prompt.
Environment authentication must not inspect or persist the saved credential store.
Never store new consumer keys, echo private server errors or retry a mutating call.
Apply must use identical reviewed bytes and the preview revision, with explicit
interactive confirmation or an automation acknowledgement. Interrupted output
does not establish that a submitted operation rolled back.

Tail only authenticated tenant request-log observations. Bound connection/SQL/row/
frame/buffer/lifetime resources and retain actual work ownership through shutdown.
Use precise trusted receipt/UUID cursors, authenticated encryption and current
privacy/retention under the ingestion receipt fence. Never expose internal receipt
or rollup columns. Expired rows cannot reappear when retention grows. Resume may
replay interrupted output; warn about retention gaps and label recorded coverage.
Existing tenant session JWTs do not satisfy scoped-token or revocation requirements.
