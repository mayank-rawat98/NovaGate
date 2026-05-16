# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `npm exec nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

---

## Common Commands

Package manager: **npm**

```sh
# Serve apps in development
npm exec nx serve apps/api
npm exec nx serve apps/control-plane
npm exec nx serve apps/admin-api
npm exec nx serve apps/dashboard

# Build
npm exec nx build apps/api

# Test a project
npm exec nx test apps/api

# Test a single spec file
npm exec nx test apps/api -- --testFile=apps/api/src/gateway/rate-limit/rate-limit.service.spec.ts

# Run all affected tests (required before any PR)
npm exec nx affected -t test

# Lint
npm exec nx lint apps/api
```

Local dev infrastructure:

```sh
docker compose up -d             # postgres, redis, control-plane, admin-api, dashboard
docker compose up gateway-local  # gateway connected to local docker services
```

---

## Architecture

This is a **hybrid SaaS API gateway**. Live traffic never touches the SaaS servers — the gateway runs on the customer's own VPS and proxies traffic directly to their downstream services.

```text
CUSTOMER'S VPS                         SAAS SERVERS
┌────────────────────────────┐          ┌──────────────────────────────────────┐
│  apps/api  (NestJS)        │          │  apps/control-plane (NestJS/WS)      │
│  ControlPlaneConnector  ───┼──WSS────►│  TenantConnectionManager             │
│  GatewayConfigManager      │          │                                      │
│  (in-memory + Redis cache) │          │  apps/admin-api  (NestJS REST)       │
│                            │          │  apps/dashboard  (Next.js 14)        │
│  Proxy  (live traffic)     │          │  PostgreSQL  (schema-per-tenant)     │
│  Client → Gateway          │          │  Redis  (config.update pub/sub)      │
│    → Downstream service    │          └──────────────────────────────────────┘
└────────────────────────────┘
```

**Key principle:** SaaS server cost is O(tenants), not O(requests). If the control plane is unreachable, the gateway continues serving live traffic from in-memory config and local Redis warm-start cache.

### Apps

| App                  | Role                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`           | Gateway Docker image — deployed on customer VPS, no DB, talks only to control plane via outbound WebSocket                     |
| `apps/control-plane` | WebSocket server — accepts connections from all gateway instances, delivers config updates, ingests logs/health/errors/metrics |
| `apps/admin-api`     | REST API consumed only by the dashboard — CRUD for routes/services/consumers/tenants, analytics                                |
| `apps/dashboard`     | Next.js 14 tenant-facing UI — route management, observability, setup flow                                                      |
| `libs/shared-types`  | Single source of truth for TypeScript interfaces: WS message types, DB entities, `TenantConfig`                                |

**shared-types change order is non-negotiable:** update `shared-types` first, then the sender, then the receiver.

### Config propagation flow

1. Tenant edits routes/services in the dashboard → `admin-api` writes to `tenant_<id>` schema
2. `admin-api` publishes to Redis `config.update` channel
3. `control-plane` (`TenantConnectionManager`) pushes `config.update` WS message to the tenant's gateway (or stores in `pending_config_updates` if offline)
4. Gateway (`ControlPlaneConnectorService`) calls `GatewayConfigManagerService.loadConfig()` → persists to `cfg:default` in local Redis → proxy uses new config immediately

### Database (schema-per-tenant)

- `public` schema: `tenants`, `api_keys`, `plans`, `pending_config_updates`
- `tenant_<uuid_underscored>` per tenant: `routes`, `services`, `consumers`, `request_logs`, `error_events`, `health_snapshots`, `metrics_snapshots`

Schemas are provisioned on signup by `TenantProvisioningService` in `admin-api`. Use **soft-deletes** on routes and services — never hard DELETE.

### WebSocket protocol

Types are in `libs/shared-types/src/lib/ws-messages.ts`. Key rules:

- Gateway opens outbound WSS, sends `auth` → receives `auth_ok` with initial `TenantConfig`
- Control plane pushes `config.update`; gateway replies with `config.ack`
- Gateway sends batched `logs`, `health`, `errors` (errors require `ack`), `metrics`
- Close codes `4001`, `4003`, `4004` are permanent — **do not reconnect**

---

## Gateway Module Structure (`apps/api/src/gateway/`)

```text
auth/           JwtMiddleware — attaches req.user, never blocks
rate-limit/     RateLimitGuard + RateLimitService (Redis sliding window)
proxy/          ProxyMiddleware + ProxyService + LoadBalancerService + ProxyController
logging/        LoggingInterceptor
metrics/        MetricsService (prom-client) + MetricsController (/metrics)
health/         HealthController (/health) + UpstreamHealthService (polls targets every 10s)
config-manager/ GatewayConfigManagerService — in-memory config + Redis warm-start
connector/      ControlPlaneConnectorService — WS lifecycle, reconnect, message buffer
telemetry/      GatewayTelemetryService — batches telemetry to send upstream
services/       ServicesModule — TypeORM entity + repository for service config
plugins/        PluginRegistryService + PluginRunnerService + 12 built-in plugins
shared/         GatewayExceptionFilter, GatewayError, redis.tokens, request-context, route-matcher
```

**Middleware pipeline (order is load-bearing — do not reorder):**
`JwtMiddleware` → `RateLimitGuard` → `LoggingInterceptor` → `ProxyMiddleware` → `PluginRunner.onRequest` → downstream → `PluginRunner.onResponse`

**Plugin system:** Auth, CORS, IP restriction, rate limiting, body size limits, and header transforms are all handled as **plugins** registered on `route.plugins[]`. The 12 built-in plugins are:

- Phase 1: `cors`, `ip-restriction`, `rate-limit`, `request-size-limit`, `request-transform`, `response-transform`, `basic-auth`
- Phase 2: `oidc` (JWKS-based JWT validation), `oauth2-client-credentials` (introspection or grant injection), `hmac-auth` (Stripe-style HMAC signatures), `acl` (consumer group allow/deny), `mtls` (client cert validation)

Plugins run in listed order; returning a `PluginShortCircuit` stops the chain.

**Import rules:** `proxy`, `rate-limit`, `logging` may import from `metrics`. Nothing else imports from `proxy`, `logging`, or `auth` except `gateway.module.ts`. Shared state between subfolders belongs in `shared/`.

---

## Mandatory Reading Before Working in `apps/api`

- [`.github/instructions/gateway.instructions.md`](.github/instructions/gateway.instructions.md) — module conventions, naming rules, error response shape, allowed dependencies
- [`AI_RULES_GATEWAY.md`](AI_RULES_GATEWAY.md) — correctness constraints (rate limiter, Redis fail-open, Prometheus cardinality, JWT error codes, request ID propagation)
- [`REDIS_KEY_DESIGN.md`](REDIS_KEY_DESIGN.md) — Redis key schema (`cfg:default`, `rl:<clientKey>`)
- [`apps/api/CLAUDE.md`](apps/api/CLAUDE.md) — gateway boot sequence, plugin system, and per-app guardrails

---

## Code Quality Tooling

**Commitlint** (`commitlint.config.js`) — enforces Conventional Commits on every commit message via the `commit-msg` Husky hook. Format: `type(scope): subject` (e.g. `feat(api): add rate-limit plugin`).

**Husky pre-commit hook** (`.husky/pre-commit`) — runs on every commit:

1. `npx prettier --write .` — formats all files in place
2. `npm run check` — runs `nx run-many -t lint build typecheck --all`

**CI** (`.github/workflows/ci.yml`) — triggers on push to `dev` (i.e. when a PR is merged). Runs `lint → typecheck → test → build` for all projects via `npx nx run-many`.

---

## Critical Correctness Rules

1. **Rate limiter uses Redis sorted-set sliding window** — never `INCR`/`EXPIRE` fixed window
2. **Redis failure must fail open** — allow the request, increment error counter; never throw `ServiceUnavailableException`
3. **Prometheus path labels are normalized** — use `req.route?.path` (e.g. `/users/:id`), never the raw URL
4. **Expired JWT → 401 `TOKEN_EXPIRED`** — distinct from `TOKEN_INVALID`; the frontend refresh interceptor depends on this exact error code
5. **`X-Request-ID` must propagate** — generate UUID if absent, forward to downstream, include in response and log entry
6. **Proxy prefix stripping is exact-match** — `startsWith(prefix + '/')` only; `/user` must not match `/users/123`
7. **No PII in logs or metrics** — no emails, JWT strings, passwords, or full IPs in metric label values
8. **Config schema crashes on startup** — Joi in `configuration.schema.ts` must cover all required env vars; a running service with missing config is worse than a clean crash

---

## Environment Variables (Gateway)

| Variable                | Default  | Notes               |
| ----------------------- | -------- | ------------------- |
| `PORT`                  | `3000`   |                     |
| `REDIS_URL`             | required |                     |
| `JWT_SECRET`            | required | min 32 chars        |
| `CONTROL_PLANE_URL`     | required | `wss://…`           |
| `GATEWAY_API_KEY`       | required | API key for WS auth |
| `PROXY_TIMEOUT_MS`      | `10000`  |                     |
| `RATE_LIMIT_WINDOW_MS`  | `60000`  |                     |
| `RATE_LIMIT_UNAUTH_MAX` | `100`    |                     |
| `RATE_LIMIT_AUTH_MAX`   | `500`    |                     |
