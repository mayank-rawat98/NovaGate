# Implementation Phases — From Working Gateway to Beyond Kong

Each phase builds on the previous. Track implementation, regression verification, and production acceptance separately. A phase is complete only after its acceptance criteria have evidence. Run feature and regression checks after each issue; perform the formal end-to-end acceptance campaign after all phases are implemented. Production deployment is a separate release gate.

## Code audit — 4 October 2026

The code contains substantial work for phases 0–3, but file presence does not prove production acceptance. No phase is marked complete by this audit.

| Phase | Evidence in repository                                                                         | Remaining work / verification                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Weighted balancer, active health probes, HTTP retry loop, size/CORS/IP plugins                 | Issue #29 repairs peer-IP trust/IPv6, bounded binary body replay, browser preflight and HTTP retry termination; health interval and target failover acceptance remain         |
| 1     | Plugin contracts, runner, registry, thirteen first-party plugins, dashboard route plugin forms | Plugin aggregate registration and fail-closed name resolution repaired in issue #27, verified through the real Nest module; broader runtime plugin acceptance remains         |
| 2     | OIDC, client credentials, HMAC, ACL, mTLS implementations and unit tests                       | Verify real providers and TLS handshakes; Tenant-bound REST authorization and new-schema consumer groups repaired in issue #27; live provider/TLS acceptance remains          |
| 3     | WebSocket, gRPC, HTTP/2 pool and GraphQL guard with tests                                      | Issue #29 verifies real HTTP/2 response hooks before sending the body and automatic GraphQL guard activation; WebSocket/gRPC protocol acceptance and least-connections remain |
| 4     | Existing logs/health/metrics tables and REST views                                             | Tracing, live metrics, alert delivery/history, RustFS log export and consumer aggregates remain to implement                                                                  |
| 5     | Existing REST configuration primitives                                                         | Declarative reconciliation, CLI, portal, Terraform, plugin SDK and third-party loading remain to implement                                                                    |
| 6     | No verified implementations                                                                    | Anomalies, circuit breaker, regional failover, quotas, Kubernetes reconciliation, WASM and federation remain to implement                                                     |

### Prerequisites discovered by audit

- Authenticate every tenant REST operation and bind the token subject to the requested tenant; remove fallback signing secrets and public tenant provisioning.
- Use schema-qualified queries or transaction-local search paths. Pooled `SET search_path` in telemetry ingestion can cross tenant boundaries.
- Issue #27 implements tenant REST authorization, complete plugin aggregation, schema-qualified ingestion, private tenant responses and fresh schema groups. Real Nest HTTP and PostgreSQL/Redis/WebSocket regression checks cover these prerequisites.
- Load persisted tenant configuration at gateway authentication; preserve monotonic config versions and acknowledge persisted updates. Reject revoked gateway keys and never log keys.
- Register all first-party plugins through an explicit aggregate factory and fail closed for unknown configured plugins.
- Validate existing features with the actual Nest module and live PostgreSQL/Redis in OrbStack before building on them.
- Run CI on PRs targeting `dev`, with least-privilege permissions, reproducible installs and regression gates before merging. Every implementation issue gets a branch from `dev`, a PR with `Closes #<issue>`, and verification evidence.

### Additional product requirements

1. Tenant isolation and access control: tenant-scoped authorization now; team RBAC, scoped automation tokens and immutable audit history before enterprise acceptance.
2. Config safety: validated versioned snapshots, preview/diff, rollback, atomic reconciliation, drift detection and last-known-good operation while the control plane is unavailable.
3. Resilience: bounded queues and body buffers, reconnect backoff, graceful shutdown, retry budgets, circuit breakers, retention and backpressure. No unconstrained metric labels or secret-bearing logs/traces.
4. Storage: RustFS is the default S3-compatible archive backend. Use private per-tenant prefixes, server-side encryption where supported, retention and short-lived download authorization; never expose storage credentials in dashboard APIs.
5. Dashboard: accessible responsive navigation, clay-inspired visual accents, consistent colors, useful empty/loading/error states, keyboard focus, reduced motion, and clear status/validation feedback. Test mobile layouts and contrast.
6. Release evidence: reproducible gateway/Kong benchmarks, protocol conformance, security and chaos tests, backup/restore and regional failover drills. Comparative claims require measurements and current vendor documentation.
7. AI/API platform roadmap: token/cost budgets, provider fallback, sensitive-data redaction and MCP policy controls with explicit threat models and tests.

Kong already documents [AI Gateway](https://developer.konghq.com/ai-gateway/), [OpenTelemetry](https://developer.konghq.com/gateway/otel-metrics/) and [health checks/circuit breakers](https://developer.konghq.com/gateway/traffic-control/health-checks-circuit-breakers/). Differentiate through operational simplicity, included capabilities and measured performance; do not claim these capabilities are impossible in Kong.

Issue #27 also disables destructive control-plane entity synchronization and adds explicit initial public DDL, durable pre-publication snapshots, database config versions, ACK-based cleanup, revoked-key rejection, cache identity recovery and PR CI with PostgreSQL/Redis integration checks. Production acceptance remains a separate gate.

Issue #29 adds real upstream HTTP/HTTP2 regression tests for CORS preflight, Basic/OIDC authentication, binary/chunked upload limits, transformed queries/headers, safe retries and GraphQL depth enforcement. External subjects are kept separate from consumer UUIDs. Trusted reverse proxies are opt-in and validated at startup.

Reference review: Mailtr remote `dev` (`db4a0cc3d5184e67208d0c6c196c045e518b1664`) supports reusable CI before deployment and build artifact reuse. Medhank in the local `examinator` checkout has cached `origin/dev` (`c87c366fb34a4c08c1a24a0ed164bcfce2668bfe`, 3 October 2026): migration immutability, runtime image dependency checks, compose validation, bundle budgets and atomic tenant/cache patterns are relevant. Remote Medhank access through the selected personal identity was denied, so this is a cached reference. Adapt safeguards to NovaGate; do not copy credentials, cloud workspace identifiers or unrelated domain code.

Implementation sequence: reconcile baseline → repair isolation/config/plugin prerequisites → close phases 0–3 verification gaps → Phase 4 with RustFS and refreshed dashboard → phases 5–6 and additional requirements → formal acceptance. Terraform and Kubernetes code must live under this repository, not in separate repositories.

---

**Legend:**

- `apps/api` — gateway (runs on customer VPS)
- `apps/admin-api` — SaaS admin REST API
- `apps/control-plane` — SaaS WebSocket server
- `apps/dashboard` — SaaS Next.js frontend
- `libs/shared-types` — canonical TypeScript interfaces (always change first)

---

## Phase 0 — Production Credibility

**Duration: 4–6 weeks**
**Goal: A team running real traffic can trust us.**

Without these, no engineering team will point production traffic at us. These are table stakes, not features.

---

### 0.1 Load Balancing

**Why first:** Every microservice deployment has more than one pod. A single `targetUrl` per service disqualifies us immediately.

**What to build:**

`libs/shared-types` — extend `ServiceConfig`:

```typescript
// before
targetUrl: string;

// after
targets: Array<{ url: string; weight: number }>; // weight 1–100, defaults to equal
```

`apps/api/src/gateway/proxy/` — replace `createProxyMiddleware` with a round-robin selector:

- `LoadBalancerService` — maintains a per-service counter; on each request picks `targets[counter++ % targets.length]` weighted by `weight`
- Weighted implementation: expand targets array by weight before cycling (simple, no external lib)
- Algorithms supported in this phase: **round-robin** and **weighted round-robin**
- Least-connections deferred to Phase 2 (requires connection tracking)

`apps/admin-api` — update `ServicesController`:

- `POST /tenants/:id/services` accepts `targets: { url, weight }[]`
- `PUT` allows adding/removing individual targets without replacing the whole service
- Dashboard `ServiceForm` shows a dynamic target list with weight sliders

**Success criteria:** Two targets per service. Kill one. Traffic shifts to the other within one request cycle. No 502s during target removal.

---

### 0.2 Active Upstream Health Checks

**Why now:** Load balancing is useless without automatic target eviction when a pod crashes.

**What to build:**

`apps/api/src/gateway/health/upstream-health.service.ts`:

- Runs a `setInterval` every `healthCheckIntervalMs` (default 10s, configurable per service)
- Probes `GET {target.url}{healthCheckPath}` with a 3s timeout
- Maintains `Map<targetUrl, { healthy: boolean; failCount: number; lastChecked: Date }>`
- Marks unhealthy after 3 consecutive failures; marks healthy after 2 consecutive successes (avoids flap)
- `LoadBalancerService` skips unhealthy targets; falls back to all targets if all are unhealthy (never drop to zero)

`apps/api/src/gateway/telemetry/` — existing `health` telemetry message already wired; populate it from `UpstreamHealthService` instead of stubs.

**Success criteria:** Stop a downstream service. Within 30s, gateway routes zero requests to it. Restart it. Within 30s, it re-enters rotation. Health page in dashboard reflects current state.

---

### 0.3 Retry Policy

**Why now:** Transient 502s and pod restarts are unavoidable. A single retry recovers most of them silently.

**What to build:**

`libs/shared-types` — add to `RouteConfig`:

```typescript
retry?: {
  attempts: number          // default 2
  on: number[]              // HTTP status codes, default [502, 503, 504]
  methods: string[]         // default ['GET','HEAD','OPTIONS'] — safe methods only
}
```

`apps/api/src/gateway/proxy/proxy.service.ts`:

- Wrap the proxy call in a retry loop
- First retry: immediate. Second retry: 100ms delay.
- On non-idempotent methods (POST, PUT, PATCH, DELETE): only retry if route explicitly opts in via `retry.methods`
- Increment `gateway_proxy_retries_total{route,attempt}` Prometheus counter per retry
- Log retry attempt with original error code and target URL

**Success criteria:** Route configured with `retry: { attempts: 2, on: [502] }`. Downstream returns 502 on first call. Client receives 200 from the second attempt. Counter shows 1 retry.

---

### 0.4 Request Size Limiting

**What to build:**

`libs/shared-types` — add to `RouteConfig`:

```typescript
maxBodyBytes?: number  // default unlimited; suggest 10MB as gateway default
```

`apps/api/src/gateway/proxy/` — new `RequestSizeLimitMiddleware`:

- Reads `Content-Length` header; if set and exceeds limit → 413 immediately, no read
- If `Content-Length` absent, streams and counts bytes; aborts connection at limit
- Applied before proxy middleware; checked per route from config

**Success criteria:** Route with `maxBodyBytes: 1024`. Send 2KB body. Receive 413. Downstream never receives the request.

---

### 0.5 Basic CORS Handling

**Why not a plugin yet:** CORS is a browser prerequisite. Teams will not test us without it. We build it hardcoded now and migrate it to a plugin in Phase 1.

**What to build:**

`libs/shared-types` — add to `RouteConfig`:

```typescript
cors?: {
  origins: string[]          // ['*'] or specific domains
  methods?: string[]         // default: route's method
  headers?: string[]         // extra allowed request headers
  credentials?: boolean      // default false
  maxAge?: number            // preflight cache seconds, default 86400
}
```

`apps/api/src/gateway/proxy/cors.middleware.ts`:

- Handles `OPTIONS` preflight: respond 204 with correct headers, never reaches downstream
- Injects `Access-Control-Allow-*` on actual responses
- Per-route config from `GatewayConfigManagerService`

**Success criteria:** Route with `cors: { origins: ['https://app.example.com'] }`. Browser preflight returns 204. Cross-origin request gets correct headers. Request from unlisted origin gets no CORS headers.

---

### 0.6 IP Allowlist / Denylist

**What to build:**

`libs/shared-types` — add to `RouteConfig`:

```typescript
ipRestriction?: {
  allow?: string[]   // CIDR notation, e.g. ['10.0.0.0/8', '203.0.113.42/32']
  deny?: string[]
}
```

`apps/api/src/gateway/proxy/ip-restriction.middleware.ts`:

- Extracts IP from `X-Forwarded-For` first (gateway is behind a proxy), then `req.ip`
- CIDR matching via `netmask` library (already a transitive dep in most setups, or add it)
- Deny takes precedence over allow
- Returns 403 with `IP_RESTRICTED` error code

**Success criteria:** Route with `deny: ['1.2.3.4/32']`. Request from that IP gets 403. All others pass through.

---

### Phase 0 Exit Criteria

- [ ] Two-target service: killing one target causes zero client-facing errors within 10s
- [ ] Retry: route recovers from transient 502 transparently
- [ ] CORS preflight works on all configured routes
- [ ] IP block works end-to-end
- [ ] `nx build` clean, all integration tests pass
- [ ] Config changes (new targets, CORS, retry) propagate via existing config push without gateway restart

---

## Phase 1 — Plugin System

**Duration: 6–8 weeks**
**Goal: Third-party developers can extend the gateway without forking the codebase.**

This is the architectural decision that separates a gateway from a reverse proxy. Everything built hardcoded in Phase 0 gets refactored to first-party plugins. New capabilities become plugins, not core changes.

---

### 1.1 Plugin Interface (shared-types)

```typescript
// libs/shared-types/src/lib/plugin.ts

export interface PluginContext {
  req: IncomingMessage & { user?: { id: string }; requestId: string };
  res: ServerResponse;
  route: RouteConfig;
  service: ServiceConfig | undefined;
  tenantId: string;
  logger: PluginLogger;
}

export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface GatewayPlugin {
  name: string;

  // Called before the request reaches the proxy.
  // Return a Response to short-circuit (e.g. 403, 401, cached response).
  // Return void to continue to the next plugin.
  onRequest?(ctx: PluginContext): Promise<PluginShortCircuit | void>;

  // Called after the downstream responds, before the response is sent to client.
  // Can mutate response headers. Cannot change body (streaming).
  onResponse?(ctx: PluginContext & { statusCode: number; headers: OutgoingHttpHeaders }): Promise<void>;

  // Called when the proxy encounters an error (timeout, 5xx after retries).
  onError?(ctx: PluginContext & { error: GatewayError }): Promise<PluginShortCircuit | void>;
}

export interface PluginShortCircuit {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}
```

---

### 1.2 Plugin Registry and Loader

`apps/api/src/gateway/plugins/plugin-registry.service.ts`:

- Map of `name → GatewayPlugin` instance
- `register(plugin: GatewayPlugin)` — called at module init
- `resolve(names: string[]): GatewayPlugin[]` — returns ordered plugin chain for a route
- First-party plugins registered in `GatewayModule` constructor
- No dynamic file loading in Phase 1 (security boundary — third-party plugins are Phase 5)

`apps/api/src/gateway/plugins/plugin-runner.service.ts`:

- `runOnRequest(plugins, ctx)` — sequential, stops at first `ShortCircuit`
- `runOnResponse(plugins, ctx)` — sequential, all run (errors are logged, not rethrown)
- `runOnError(plugins, ctx)` — sequential, first `ShortCircuit` wins

---

### 1.3 Migrate Phase 0 Features to First-Party Plugins

Refactor these from middleware into `GatewayPlugin` implementations:

| Plugin Name          | Replaces                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| `cors`               | `cors.middleware.ts`                                                   |
| `ip-restriction`     | `ip-restriction.middleware.ts`                                         |
| `request-size-limit` | `RequestSizeLimitMiddleware`                                           |
| `rate-limit`         | `RateLimitGuard` (keep guard, add plugin wrapper for per-route config) |

Each plugin reads its config from `route.plugins[name]` — a `Record<string, unknown>` defined in `RouteConfig`:

```typescript
// libs/shared-types — RouteConfig addition
plugins?: Array<{ name: string; config: Record<string, unknown> }>
```

---

### 1.4 New First-Party Plugins (Phase 1 ships these)

**`request-transform` plugin**

```typescript
config: {
  addHeaders?: Record<string, string>     // injected into upstream request
  removeHeaders?: string[]                // stripped from upstream request
  renameHeaders?: Record<string, string>  // { 'X-Old': 'X-New' }
  addQueryParams?: Record<string, string>
  removeQueryParams?: string[]
}
```

**`response-transform` plugin**

```typescript
config: {
  addHeaders?: Record<string, string>     // injected into client response
  removeHeaders?: string[]
  statusOverride?: number                 // rewrite upstream 503 → 200 for health endpoints
}
```

**`basic-auth` plugin**

```typescript
config: {
  credentials: Array<{ username: string; passwordHash: string }>
  realm?: string
}
```

Returns `WWW-Authenticate: Basic realm="..."` on missing/invalid credentials.

---

### 1.5 Admin API + Dashboard — Plugin Config UI

`apps/admin-api`:

- `PUT /tenants/:id/routes/:routeId` accepts `plugins` array — stored as JSONB in `routes.plugins`
- Validate plugin names against a registered allowlist; reject unknown plugin names

`apps/dashboard` — Route edit slide-over:

- "Plugins" tab lists available plugins
- Toggling a plugin expands a config form specific to that plugin (each plugin ships a JSON Schema)
- Schema-driven form rendering using `react-hook-form` + `zod`

---

### Phase 1 Exit Criteria

- [ ] CORS, IP restriction, rate-limit, request-transform all run as plugins
- [ ] Adding a new first-party plugin requires zero changes to `gateway.module.ts`
- [ ] Plugin execution order matches `route.plugins` array order
- [ ] Dashboard plugin config tab saves and propagates via config push
- [ ] Plugin error in `onRequest` is caught — gateway returns 500, does not crash
- [ ] `nx test apps/api -- --testFile=**/plugin-runner*` passes

---

## Phase 2 — Auth Completeness

**Duration: 5–7 weeks**
**Goal: Replace the `Authorization` header logic for any standard protocol without custom code.**

---

### 2.1 OAuth 2.0 — Client Credentials Flow

**Who needs it:** Machine-to-machine APIs (microservices calling other microservices through the gateway).

`apps/api/src/gateway/plugins/oauth2-client-credentials/`:

- Per-route config: `{ tokenEndpoint, clientId, clientSecret, scopes }` (for upstream auth injection — gateway acts as OAuth client)
- OR: validate inbound `Bearer` tokens by calling the token introspection endpoint
- Token introspection result cached in Redis with TTL = token `expires_in`
- On cache hit: no round-trip to auth server; latency impact < 1ms

---

### 2.2 OIDC — JWT Validation via JWKS

**Who needs it:** Teams using Auth0, Cognito, Azure AD, Keycloak as their identity provider.

`apps/api/src/gateway/plugins/oidc/`:

```typescript
config: {
  jwksUri: string       // e.g. https://accounts.google.com/.well-known/jwks.json
  issuer: string        // validated against 'iss' claim
  audience?: string     // validated against 'aud' claim
  claimsToForward?: string[]  // e.g. ['sub', 'email'] injected as X-* headers
}
```

- JWKS fetched on first request, cached with 24h TTL, refreshed on `kid` miss (handles key rotation)
- Validates `exp`, `iss`, `aud`, `nbf`
- Compatible with existing `JwtMiddleware` — OIDC plugin runs after and enriches `req.user`

---

### 2.3 HMAC Authentication

**Who needs it:** Webhook senders (Stripe, GitHub, etc.) and legacy API clients that sign requests.

`apps/api/src/gateway/plugins/hmac-auth/`:

```typescript
config: {
  header: string          // header containing signature, e.g. 'X-Hub-Signature-256'
  algorithm: 'sha256' | 'sha512'
  secrets: string[]       // list of valid secrets (supports rotation — check all)
  maxClockSkewSeconds?: number  // default 300
}
```

- Computes `HMAC(secret, rawBody)` and compares to header value using `timingSafeEqual`
- `rawBody` captured before any transformation plugins run

---

### 2.4 Consumer Groups and ACLs

**What to build:**

`libs/shared-types` — add to `ConsumerConfig`:

```typescript
groups: string[]  // e.g. ['admin', 'read-only']
```

`libs/shared-types` — add to `RouteConfig`:

```typescript
acl?: {
  allow?: string[]   // consumer groups allowed
  deny?: string[]    // consumer groups blocked
}
```

`apps/api/src/gateway/plugins/acl/`:

- Reads `req.user.id`, looks up consumer from config, checks groups
- Deny takes precedence; 403 with `ACL_DENIED` code

`apps/admin-api` + `apps/dashboard`:

- Consumer creation form adds optional `groups` field (comma-separated)
- Route ACL config in plugin tab

---

### 2.5 mTLS — Client Certificate Verification

**Who needs it:** Financial services, healthcare, B2B APIs where both parties need to prove identity.

`apps/api/src/gateway/auth/mtls.middleware.ts`:

- Reads `ssl_client_cert` header (set by nginx/load balancer TLS termination) or raw TLS cert from `req.socket`
- Validates against a per-route or global CA bundle stored in the gateway's local config
- Extracts `CN`, `SAN` from cert; populates `req.user.certSubject`

`apps/dashboard` — Settings page:

- Upload CA certificate PEM per tenant; stored encrypted in DB

---

### Phase 2 Exit Criteria

- [ ] Auth0 OIDC flow works end-to-end: token issued by Auth0, validated at gateway edge
- [ ] HMAC validation passes Stripe webhook signature (test in integration test)
- [ ] Consumer in group `admin` can access route with `acl.allow: ['admin']`
- [ ] Consumer without group gets 403
- [ ] JWKS cache survives key rotation (forced key rotation test)
- [ ] All new auth plugins configurable from Dashboard with zero gateway restart

---

## Phase 3 — Protocol Expansion

**Duration: 5–6 weeks**
**Goal: Traffic of any protocol type can flow through the gateway.**

---

### 3.1 WebSocket Proxying (Client Traffic)

**Why it matters:** Real-time apps (chat, live dashboards, collaborative tools) use WebSocket. Without this, those teams cannot adopt us.

`apps/api/src/gateway/proxy/ws-proxy.service.ts`:

- Detect `Connection: Upgrade` + `Upgrade: websocket` in request
- Apply auth plugin chain and rate-limit **before** upgrading (rate-limit by active connection count for WS, not by request)
- Upgrade pass-through to target URL via `http-proxy` WebSocket support
- Telemetry: log connection open/close events; count bytes transferred (not per-message — too expensive)

`libs/shared-types` — add to `ServiceConfig`:

```typescript
supportsWebSocket: boolean; // default false; must be explicit
```

---

### 3.2 gRPC Pass-Through Proxy

**Why it matters:** gRPC is the standard for internal microservice communication. Teams moving from Envoy or nginx need this.

`apps/api/src/gateway/proxy/grpc-proxy.service.ts`:

- Detect `Content-Type: application/grpc*`
- HTTP/2 pass-through to downstream (Node.js `http2` module)
- Auth and rate-limit apply pre-proxy (token from `authorization` metadata)
- Telemetry: method name extracted from `:path` pseudo-header (e.g. `/helloworld.Greeter/SayHello`)
- Prometheus labels: `grpc_service`, `grpc_method`, `grpc_status` (status code from `grpc-status` trailer)

**Deferred to Phase 5:** gRPC-Web transcoding (JSON ↔ protobuf — requires protobuf schema registration)

---

### 3.3 HTTP/2 for Downstream Connections

Upstream connections from gateway → downstream currently use HTTP/1.1 (`http-proxy-middleware`). Switch to HTTP/2 for services that advertise it.

`apps/api/src/gateway/proxy/proxy.service.ts`:

- Per-service `h2: boolean` flag; default false
- When enabled: use `node:http2` client session pool per target URL
- Session pool: max 10 sessions per target, idle timeout 30s
- Falls back to HTTP/1.1 on connection error (no breaking change)

---

### 3.4 GraphQL-Aware Routing

**What to build:**

Not transcoding yet — just awareness that a route is GraphQL so we can apply safe defaults.

`libs/shared-types` — add to `RouteConfig`:

```typescript
graphql?: {
  maxDepth?: number           // default 10; rejects deeply nested queries
  maxComplexity?: number      // default 1000; field count weighted by nesting depth
  introspectionAllowed?: boolean  // default false in production
}
```

`apps/api/src/gateway/plugins/graphql-guard/`:

- Parse `query` from POST body JSON (no schema needed — just AST depth/complexity)
- Reject before proxying if limits exceeded
- `introspectionAllowed: false` blocks `__schema` and `__type` queries

---

### Phase 3 Exit Criteria

- [ ] WebSocket client connects through gateway; messages relay bidirectionally
- [ ] WebSocket connection counts tracked in Prometheus
- [ ] gRPC unary call proxied successfully (tested with `grpcurl`)
- [ ] GraphQL depth limit blocks `{ a { b { c { d { ... } } } } }` beyond configured depth
- [ ] HTTP/2 downstream connection established when `h2: true`

---

## Phase 4 — Observability Platform

**Duration: 4–5 weeks**
**Goal: Any team can debug a production incident using only our dashboard — no external tooling required.**

This is not a feature — it is the core product value for teams who would otherwise pay for Datadog + Kong.

---

### 4.1 Distributed Tracing (OpenTelemetry)

`apps/api/src/gateway/telemetry/otel.service.ts`:

- Emit OpenTelemetry spans for every proxied request
- Span attributes: `http.method`, `http.target`, `http.status_code`, `http.user_agent`, `net.peer.ip`, `gateway.tenant_id`, `gateway.route_id`, `gateway.service_id`, `gateway.retry_count`
- Propagate `traceparent` header to downstream (W3C Trace Context)
- Export to control plane via existing WS `telemetry` message; control plane stores in DB
- Phase 5 will add OTLP export for third-party backends (Jaeger, Zipkin, Tempo)

`apps/dashboard` — new `Traces` page:

- Waterfall view: gateway span → downstream span (if downstream also sends `traceparent`)
- Search by `traceId`, `requestId`, path, time range
- Click a span → see attributes, timing, error if any

---

### 4.2 Real-Time Metrics Streaming

Currently: dashboard polls `GET /tenants/:id/metrics` on interval.
Replace with: Server-Sent Events from admin-api; metrics pushed to dashboard as they arrive.

`apps/admin-api/src/analytics/metrics-stream.controller.ts`:

- `GET /tenants/:id/metrics/stream` — SSE endpoint
- Subscribes to Redis pub/sub channel `metrics:{tenantId}`
- Control plane publishes metrics to this channel when it receives the WS `metrics` message
- Dashboard `EventSource` connects; chart updates without polling

`apps/dashboard` — dashboard overview and metrics page use `EventSource` instead of `useSWR`.

---

### 4.3 Alerting

`libs/shared-types` — new `AlertRule` type:

```typescript
interface AlertRule {
  id: string;
  name: string;
  metric: 'error_rate' | 'p95_latency_ms' | 'rps' | 'downstream_timeout_rate';
  operator: '>' | '<' | '>=';
  threshold: number;
  windowMinutes: number;
  channels: AlertChannel[];
  enabled: boolean;
}

type AlertChannel = { type: 'webhook'; url: string; secret?: string } | { type: 'email'; address: string } | { type: 'slack'; webhookUrl: string };
```

`apps/admin-api/src/alerts/`:

- `AlertEvaluatorService` runs every 60s per tenant; queries recent metrics snapshots; fires matching rules
- `AlertDeliveryService` sends webhook POST (signed), email via SMTP, or Slack block kit
- Deduplication: rule cannot fire more than once per `windowMinutes`

`apps/dashboard` — Alerts page: CRUD for rules, channel config, recent alert history.

---

### 4.4 Log Export

`apps/admin-api/src/log-export/`:

- Background job (configurable schedule: real-time or hourly batch)
- Destinations: S3-compatible (RustFS by default, AWS S3 and compatible providers), webhook (NDJSON), Datadog Logs API
- Config per tenant: `{ destination, credentials, filter: { minStatusCode, paths } }`
- Uses streaming SELECT (TypeORM cursor) to avoid loading all logs into memory

`apps/dashboard` — Settings → Log Export tab.

---

### 4.5 Per-Consumer Analytics

Currently analytics are per-tenant. Add the consumer dimension.

`apps/admin-api/src/analytics/analytics.controller.ts`:

- Existing endpoints gain optional `?consumerId=` filter (already partially there in logs)
- New: `GET /tenants/:id/consumers/:cid/stats` — rps, error rate, top paths, P95 latency for a specific consumer
- Used by Developer Portal in Phase 5

---

### Phase 4 Exit Criteria

- [ ] Trace waterfall visible in dashboard for any proxied request
- [ ] Metrics chart updates within 2s of gateway reporting without page refresh
- [ ] Alert fires within 90s of threshold being crossed; webhook received
- [ ] Log export to a private bucket tested with real RustFS on OrbStack
- [ ] Consumer stats page shows per-consumer rps and error rate

---

## Phase 5 — Developer Ecosystem

**Duration: 6–8 weeks**
**Goal: Customers can build on top of us, not just use us.**

This phase turns the product from a gateway into a platform. Kong sells this as "Kong Konnect." We make it available on all plans.

---

### 5.1 Declarative Config (YAML Import/Export)

`apps/admin-api/src/config-import/`:

- `POST /tenants/:id/import` — accepts YAML or JSON body; dry-run mode returns diff
- `GET /tenants/:id/export` — returns current config as YAML

Schema maps exactly to existing DB model (no new concepts):

```yaml
services:
  - name: users-api
    targets:
      - url: http://users-svc:8080
        weight: 100
    healthCheckPath: /health

routes:
  - method: GET
    pathPattern: /users
    serviceId: users-api
    plugins:
      - name: cors
        config:
          origins: ['https://app.example.com']
      - name: rate-limit
        config:
          windowMs: 60000
          max: 200

consumers:
  - name: mobile-app
    groups: [read-only]
```

`apps/dashboard` — Settings → Import/Export buttons; diff viewer shows what will change before confirming.

---

### 5.2 CLI Tool (`gwx`)

New package: `tools/gwx/` (Nx CLI app, distributed via npm `gwx`):

```bash
gwx login                          # stores token in ~/.gwx/credentials
gwx routes list                    # table of current routes
gwx routes apply gateway.yml       # declarative apply (diff + confirm)
gwx routes apply --dry-run         # show diff without applying
gwx consumers create --name=ci-bot # create consumer, print API key once
gwx logs tail                      # stream logs to terminal (SSE)
gwx alerts list
```

Auth: reads `GW_API_TOKEN` env var or `~/.gwx/credentials`. API calls `admin-api` via the same endpoints as the dashboard.

---

### 5.3 Developer Portal

**Who it serves:** When a GatewayX customer exposes APIs to _their_ customers, those customers need self-service key management.

`apps/developer-portal/` — new Next.js app (separate from `apps/dashboard`):

Routes:

- `/` — API catalog (published routes with documentation)
- `/keys` — consumer creates API keys for themselves; sees usage stats
- `/docs/:routeId` — auto-generated API docs (method, path, auth requirements, rate limits)
- `/usage` — per-key request count, error rate, quota remaining

`apps/admin-api/src/portal/`:

- `POST /tenants/:id/portal-settings` — enable portal; set allowed auth methods, custom domain
- `GET /tenants/:id/portal/routes` — routes marked `portalVisible: true`
- Public endpoint `GET /portal/:tenantId/catalog` — unauthenticated, returns visible routes

`libs/shared-types` — add to `RouteConfig`:

```typescript
portal?: {
  visible: boolean
  description?: string
  rateLimit?: { requests: number; per: 'minute' | 'hour' | 'day' }
}
```

---

### 5.4 Terraform Provider

In-repository directory: `integrations/terraform-provider/` (Go, using Terraform Plugin Framework):

Resources:

- `gatewayx_service`
- `gatewayx_route`
- `gatewayx_consumer`
- `gatewayx_alert_rule`

Data sources:

- `gatewayx_tenant` — read-only tenant metadata
- `gatewayx_consumer` — look up by name

All resources call the same `admin-api` endpoints as the CLI.

---

### 5.5 Third-Party Plugin Loading

Extend the plugin system from Phase 1 to load plugins from npm packages.

`apps/api/src/gateway/plugins/plugin-loader.service.ts`:

- Config: `plugins.npm: [{ package: '@acmecorp/gatewayx-saml-auth', version: '1.2.0' }]`
- At startup: `require(package)` — package must export a `GatewayPlugin` object as default
- Sandboxing: Phase 5 uses trust-based model (customer explicitly configures package name)
- Future Phase 6: WebAssembly sandbox for untrusted plugins

`libs/sdk/` — new library: `@api-gateway/plugin-sdk`:

- Re-exports `GatewayPlugin`, `PluginContext`, `PluginShortCircuit` from shared-types
- Exports test helpers: `createMockContext(overrides)`, `runPlugin(plugin, ctx)`
- Published to npm so third parties can build and test plugins independently

`apps/dashboard` — Settings → Plugins: list installed npm plugins, version, enable/disable per tenant.

---

### Phase 5 Exit Criteria

- [ ] `gwx routes apply gateway.yml` applies config from a file; diff shown before applying
- [ ] Developer portal accessible at `portal.{customDomain}` with correct route catalog
- [ ] Consumer in portal creates API key; uses it to call through gateway; sees usage in portal
- [ ] Terraform resource `gatewayx_route` creates a route; `terraform destroy` soft-deletes it
- [ ] Third-party plugin loaded from npm; `onRequest` hook fires; Gateway stays healthy on plugin crash

---

## Phase 6 — Beyond Kong

**Duration: 6–8 weeks**
**Goal: Capabilities Kong cannot offer without asking you to run more infrastructure.**

This phase targets an integrated operating experience. Compare each capability against current Kong offerings and verify differentiation with deployment effort, cost and performance evidence.

---

### 6.1 AI-Powered Anomaly Detection

**Differentiation target:** Integrated configuration and operation with measurable customer benefit.

`apps/control-plane/src/anomaly/`:

- Rolling baseline computed per tenant per route: P50/P95 latency, error rate, RPS (15-minute windows, retained 7 days)
- Anomaly score: z-score of current window vs 30-day baseline
- Score threshold → auto-creates alert event (reuses Phase 4 alerting infrastructure)
- No ML model needed for v1: pure statistical z-score is sufficient and interpretable

`apps/dashboard` — Anomaly feed in dashboard overview:

- "Unusual 40% spike in 5xx on `/api/orders` — baseline: 0.2%, current: 1.8%"
- One-click to view related logs and traces

---

### 6.2 Automatic Circuit Breaker

**Differentiation target:** Integrated configuration and operation with measurable customer benefit.

`apps/api/src/gateway/proxy/circuit-breaker.service.ts`:

- Sliding window of last 20 requests per (tenantId, serviceId)
- Open circuit when: failure rate > 50% AND minimum 5 requests in window
- Half-open state: let 1 request through every 10s to probe recovery
- Close circuit: 2 consecutive successes in half-open state

`apps/control-plane/src/circuit-breaker/`:

- Receives circuit state changes from gateways via new WS message type `circuit.state`
- Dashboard shows per-service circuit breaker status in real time

`apps/dashboard` — Services page: circuit breaker indicator (closed/open/half-open) per service.

---

### 6.3 Multi-Region Control Plane

**Differentiation target:** Integrated configuration and operation with measurable customer benefit.

Architecture:

- Two control plane regions: primary (e.g. `us-east`) + replica (e.g. `eu-west`)
- PostgreSQL streaming replication (primary → replica)
- Redis Cluster or Redis Sentinel per region
- Gateway connects to nearest control plane via latency-based DNS (Route53 / Cloudflare)
- Failover: on primary outage, replica promotes via PostgreSQL failover; gateways reconnect to same URL

`libs/shared-types` — add `controlPlaneRegion` to `auth_ok` message so gateway logs which region it's connected to.

`apps/dashboard` — Settings: tenant can set preferred region; see which region each gateway instance is connected to.

---

### 6.4 Per-Tenant Usage Quotas and Billing Metering

**Differentiation target:** Tenant and consumer usage controls with transparent, reproducible metering.

`apps/admin-api/src/billing/`:

- Monthly quota per plan tier: `{ requestsPerMonth, consumersMax, routesMax, logRetentionDays }`
- `QuotaEnforcementService` — checked at request time via Redis counter `quota:{tenantId}:{month}`
- On quota exceeded: gateway receives `config.update` with `suspended: true` → all routes return 429 with `QUOTA_EXCEEDED`
- Stripe webhook integration: plan upgrade resets suspension in real-time

`apps/dashboard` — Billing page: current usage vs quota, upgrade flow.

---

### 6.5 Kubernetes Ingress Controller

**Why this matters:** Teams deploying on Kubernetes want to define routes as Kubernetes resources, not via a dashboard. Kong has a K8s controller. We must match it.

In-repository directory: `integrations/k8s-controller/` (Go, using controller-runtime):

CRDs:

```yaml
apiVersion: gatewayx.io/v1
kind: GatewayRoute
metadata:
  name: users-api
spec:
  host: api.example.com
  path: /users
  method: GET
  backend:
    service: users-svc
    port: 8080
  plugins:
    - name: cors
      config:
        origins: ['*']
```

Controller reconciliation loop:

- Watch `GatewayRoute` and `GatewayService` CRDs
- On create/update/delete: call `admin-api` REST API to sync
- Status field updated with current route ID and any errors

---

### 6.6 WebAssembly Plugin Sandbox

Extend Phase 5 plugin loading to run untrusted plugins in a WASM sandbox.

`apps/api/src/gateway/plugins/wasm-loader.service.ts`:

- Plugins compiled to WASM (any language with WASM target: Rust, Go, AssemblyScript, or TypeScript via Javy)
- Executed in `@wasmer/wasm-transformer` or Wasmtime Node.js bindings
- Sandbox limits: 50ms execution time, 10MB memory, no filesystem, no network (must use host functions for HTTP)
- Host functions exposed: read request headers/body, set response headers, log, call external HTTP (whitelisted domains only)

`apps/dashboard` — Plugin Marketplace: browse community WASM plugins; install with one click.

---

### 6.7 GraphQL Federation Gateway

For teams using Apollo Federation or Rover — the gateway stitches multiple subgraphs into a single endpoint.

`apps/api/src/gateway/plugins/graphql-federation/`:

- Receives GraphQL query at `/graphql`
- Query plan execution: routes sub-queries to correct subgraph services registered in the gateway
- Response merging at the gateway level
- Requires: service schema registration (SDL upload in dashboard), schema composition at config push time
- This replaces the need for a separate Apollo Router or GraphQL Mesh deployment

---

### Phase 6 Exit Criteria

- [ ] Anomaly detection fires a real alert within 5 minutes of injecting a latency spike
- [ ] Circuit breaker opens under simulated 60% failure rate; closes after recovery
- [ ] Second control plane region comes online; existing gateways reconnect without config loss
- [ ] Consumer exceeding monthly quota gets 429; dashboard shows 98% quota used warning
- [ ] `kubectl apply -f route.yaml` creates the route in GatewayX dashboard
- [ ] WASM plugin runs in < 50ms; sandbox prevents file system access
- [ ] GraphQL federation query hitting two subgraphs returns merged response

---

## Summary Timeline

| Phase | Theme                  | Duration  | End State                                                                    |
| ----- | ---------------------- | --------- | ---------------------------------------------------------------------------- |
| **0** | Production Credibility | 4–6 weeks | Load balancing, retries, CORS, IP restriction                                |
| **1** | Plugin System          | 6–8 weeks | Extensible middleware; first-party plugin suite                              |
| **2** | Auth Completeness      | 5–7 weeks | OIDC, HMAC, ACL, mTLS — any auth protocol                                    |
| **3** | Protocol Expansion     | 5–6 weeks | WebSocket, gRPC, HTTP/2, GraphQL-aware                                       |
| **4** | Observability Platform | 4–5 weeks | Tracing, real-time metrics, alerting, log export                             |
| **5** | Developer Ecosystem    | 6–8 weeks | CLI, Developer Portal, Terraform, third-party plugins                        |
| **6** | Beyond Kong            | 6–8 weeks | AI anomaly, circuit breaker, multi-region, K8s CRD, WASM, GraphQL federation |

**Total: ~9–12 months** of focused engineering.

---

## The Test at the End of Phase 6

Take a team currently running Kong. Ask them to migrate. The answer should be yes to every question:

- Can we run on Kubernetes and define routes as CRDs? **Yes.** (Phase 6)
- Can we use our existing Auth0 identity provider? **Yes.** (Phase 2)
- Can we proxy our gRPC services? **Yes.** (Phase 3)
- Can we keep our Terraform config as source of truth? **Yes.** (Phase 5)
- Can we see traces without setting up Jaeger? **Yes.** (Phase 4)
- Can we expose our API to our own customers with self-service keys? **Yes.** (Phase 5)
- Can we get alerted when error rates spike automatically without configuring thresholds? **Yes.** (Phase 6)
- Can we trust the gateway to keep routing if your SaaS goes down? **Yes.** (already built)
- Do we have to manage a database for our gateway? **No.** (already built)
- Do we pay per request? **No.** (already built)

Validate every comparison against current vendor documentation and measured deployment results before publishing it.
