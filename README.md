# NovaGate — Self-Hosted API Gateway

> A production-grade, multi-tenant API gateway where **live traffic never touches the SaaS servers**. Tenants deploy the gateway binary on their own VPS; the SaaS control plane handles config, analytics, and routing rules only.

**Live:** [novagate.dev](https://novagate.dev) &nbsp;·&nbsp; **Docs:** [novagate.dev/docs](https://novagate.dev/docs) &nbsp;·&nbsp; **Dashboard:** [app.novagate.dev](https://app.novagate.dev)

---

## Why this exists

Most API gateway SaaS products (Kong Cloud, Zuplo, etc.) proxy your production traffic through their servers — introducing latency, per-request costs, and data-sovereignty concerns. NovaGate separates the **data plane** (traffic) from the **control plane** (configuration), so:

- Live traffic is proxied directly on the customer's own server — zero latency added by SaaS hops
- SaaS server cost scales with number of tenants, not request volume
- If the control plane goes offline, the gateway keeps serving from its local Redis warm-start cache

---

## Architecture

```text
CUSTOMER'S VPS                          SAAS SERVERS (novagate.dev)
┌────────────────────────────┐          ┌─────────────────────────────────────┐
│  apps/api  (NestJS)        │          │  apps/control-plane  (NestJS/WS)    │
│  ControlPlaneConnector  ───┼──WSS────►│  TenantConnectionManager            │
│  GatewayConfigManager      │          │                                      │
│  (in-memory + Redis cache) │          │  apps/admin-api  (NestJS REST)      │
│                            │          │  apps/dashboard  (Next.js 16)       │
│  Proxy  (live traffic)     │          │  PostgreSQL  (schema-per-tenant)    │
│  Client → Gateway          │          │  Redis  (config.update pub/sub)     │
│    → Downstream service    │          └─────────────────────────────────────┘
└────────────────────────────┘
```

**Config propagation in 4 steps:**

1. Tenant edits a route in the dashboard → `admin-api` writes to their Postgres schema
2. `admin-api` publishes to Redis `config.update` channel
3. `control-plane` pushes a `config.update` WebSocket message to the tenant's live gateway (or queues it if offline)
4. Gateway receives the update, atomically swaps in-memory config and persists to local Redis

---

## Tech Stack

| Layer                | Technology                                                                              |
| -------------------- | --------------------------------------------------------------------------------------- |
| Gateway (data plane) | NestJS 11, TypeScript, Redis (sliding-window rate limiter)                              |
| Control plane        | NestJS, WebSocket (`ws`), Redis pub/sub                                                 |
| Admin API            | NestJS, TypeORM, PostgreSQL (schema-per-tenant)                                         |
| Dashboard            | Next.js 16 App Router, Tailwind CSS, SWR                                                |
| Infrastructure       | Docker, Docker Compose, Caddy (SSL termination, shared with squadup.in), GitHub Actions |
| Monorepo             | Nx 22 with project-boundary lint rules                                                  |

---

## Key Engineering Decisions

### Redis sliding-window rate limiter

Uses a sorted-set (`ZADD` / `ZREMRANGEBYSCORE` / `ZCOUNT`) so the window slides continuously rather than resetting on a fixed boundary. Redis failure is **fail-open** — the guard logs the error and allows the request rather than taking down traffic.

### Schema-per-tenant Postgres

Each tenant gets a dedicated schema (`tenant_<uuid>`) provisioned at signup. Queries never cross tenant boundaries at the SQL level — no `WHERE tenant_id = ?` guard rails needed.

### WebSocket config delivery with offline queue

The control plane holds one persistent WebSocket per connected gateway. Every configuration is stored in `public.pending_config_updates` before publication and retained until the gateway acknowledges its database version. The latest persisted tenant configuration is also loaded on authentication. Gateways also persist config to local Redis so they can cold-start without a control-plane round-trip.

### Plugin system — zero gateway.module.ts changes for new plugins

Routes can carry an ordered `plugins[]` array. Each entry names a plugin and passes config:

```json
"plugins": [
  { "name": "basic-auth", "config": { "realm": "API", "credentials": [{ "username": "admin", "passwordHash": "<sha256>" }] } },
  { "name": "request-transform", "config": { "addHeaders": { "X-Tenant": "acme" } } }
]
```

The registry resolves the ordered plugin list per route. The runner calls `onRequest` hooks sequentially — any plugin can short-circuit by returning a `PluginShortCircuit` response (status + headers + body). `onResponse` hooks run after the upstream responds; errors there are logged but never rethrow. Adding a new first-party plugin requires only adding the class to `plugins.module.ts` — zero changes to `gateway.module.ts`.

**Phase 1 plugins:** `cors`, `ip-restriction`, `rate-limit`, `request-size-limit`, `request-transform`, `response-transform`, `basic-auth`.

**Phase 2 plugins (auth completeness):** `oidc`, `oauth2-client-credentials`, `hmac-auth`, `acl`, `mtls`.

### Phase 2 — Auth completeness (OIDC, HMAC, ACL, mTLS)

Five additional plugins ship with Phase 2, all configurable from the dashboard with zero gateway restart:

| Plugin                      | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `oidc`                      | JWKS JWT validation (Auth0, Cognito, Keycloak); 24h key cache; kid-miss refresh     |
| `oauth2-client-credentials` | Token introspection (Redis-cached) or outbound client-credentials grant injection   |
| `hmac-auth`                 | HMAC-SHA256/512 signing (Stripe style); multi-secret rotation; clock skew guard     |
| `acl`                       | Consumer group allow/deny; groups assigned per consumer via dashboard               |
| `mtls`                      | Client cert validation against tenant CA PEM; cert subject/SAN forwarded as headers |

The CA certificate for mTLS is uploaded in the dashboard **Settings → CA Certificate** section and pushed to the gateway over the existing WebSocket config update channel — no SSH or restart required.

### Nx module-boundary enforcement

ESLint tags prevent circular imports between `proxy`, `rate-limit`, `logging`, and `auth` layers. Shared state lives in `shared/` — nothing imports from `proxy` except `gateway.module.ts`.

---

## Monorepo Structure

```text
apps/
  api/                    Gateway binary — Docker image deployed on customer VPS
    src/gateway/
      plugins/            Plugin system — registry, runner, and 12 built-in plugins
        cors/             Per-route CORS headers and preflight handling
        ip-restriction/   CIDR allow/deny per route
        rate-limit/       Per-route Redis sliding-window rate limiter
        request-size-limit/  Body size guard (Content-Length + stream cap)
        request-transform/   Mutate headers and query params before upstream
        response-transform/  Mutate response headers and override status code
        basic-auth/       SHA-256 credential check with timing-safe comparison
        oidc/             JWKS-based JWT validation (Auth0, Cognito, Keycloak); 24h key cache
        oauth2-client-credentials/  Token introspection (Redis-cached) or outbound grant injection
        hmac-auth/        HMAC-SHA256/512 signature validation; multi-secret rotation; clock skew
        acl/              Consumer group allow/deny — reads groups from TenantConfig.consumers
        mtls/             Client cert validation via ssl_client_cert header; uses tenant CA PEM
  control-plane/          WebSocket server — config push & telemetry ingestion
  admin-api/              REST API for dashboard — CRUD, analytics, auth
  dashboard/              Next.js 16 tenant UI — route management, observability
libs/
  shared-types/           Single source of truth for WS message types, DB entities, TenantConfig, GatewayPlugin interface
docker/
  Dockerfile.api
  Dockerfile.dashboard
.github/
  workflows/deploy.yml    Build → push GHCR → SSH deploy on merge to main
```

---

## Gateway Middleware Pipeline

Request path (order is load-bearing):

```text
JwtMiddleware → [RateLimitGuard] → [LoggingInterceptor] → ProxyMiddleware
                                                               ↓
                                                       PluginRunner.onRequest
                                                       → forward to downstream
                                                       → PluginRunner.onResponse
```

- `JwtMiddleware` — attaches `req.user` when it recognises a platform JWT or consumer API key; passes through otherwise. Only hard-blocks on `TOKEN_EXPIRED` (platform-signed token that has expired). Third-party OIDC tokens are passed through for the `oidc` plugin to validate.
- `RateLimitGuard` — Redis sliding window; separate limits for authenticated vs unauthenticated clients
- `LoggingInterceptor` — captures latency, status, `X-Request-ID`; batches logs for async upload
- `ProxyMiddleware` → `ProxyService.forward()` — resolves and runs route plugins, then forwards to downstream

CORS, IP restriction, rate limiting, body size limits, auth, and all other per-route policies run as **plugins** — not middleware. This keeps the middleware pipeline thin and makes every policy configurable per route without gateway restarts.

---

## Running Locally

**Prerequisites:** Node 22, Docker

```sh
# Install dependencies
npm install

# Start backing services (Postgres, Redis, control-plane, admin-api, dashboard)
docker compose up -d

# Serve the gateway against local services
docker compose up gateway-local

# Run a specific app in dev mode
npm exec nx serve apps/dashboard
npm exec nx serve apps/admin-api

# Run tests
npm exec nx test apps/api
npm exec nx affected -t test   # only affected projects
```

---

## Deploying Your Own Gateway

The gateway is a single Docker image. On any Linux VPS:

```yaml
# docker-compose.yml — two services, zero config beyond your API key
services:
  gateway:
    image: ghcr.io/mayank-rawat98/novagate/api:latest
    environment:
      GATEWAY_API_KEY: <from novagate.dev/settings>
      CONTROL_PLANE_URL: wss://ws.novagate.dev/gateway-ws
      REDIS_URL: redis://redis:6379
      JWT_SECRET: <min 32 chars>
    ports:
      - '3000:3000'
  redis:
    image: redis:7-alpine
```

```sh
docker compose up -d
```

Full setup guide: [novagate.dev/docker](https://novagate.dev/docker)

---

## CI/CD

GitHub Actions pipeline on push to `main`:

1. Build Docker images for `api`, `control-plane`, `admin-api`, `dashboard`
2. Push to GitHub Container Registry (`ghcr.io/mayank-rawat98/novagate/*`)
3. SSH into VPS → `docker compose pull && docker compose up -d`

Zero-downtime: Docker Compose restarts containers one at a time; the reverse proxy keeps serving during image pulls.

TLS and routing: the VPS is shared with squadup.in, whose Caddy owns ports 80/443 and serves `novagate.dev`, `api.novagate.dev` and `ws.novagate.dev` (see `caddy/Caddyfile` in that repo). Caddy reaches `dashboard`, `admin-api` and `control-plane` over the `novagate-edge` network defined here, and issues and renews the certificates itself.

---

## Gateway Environment Variables

| Variable                | Default  | Notes                                                                                      |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `GATEWAY_API_KEY`       | required | Authenticates gateway with control plane                                                   |
| `CONTROL_PLANE_URL`     | required | `wss://ws.novagate.dev/gateway-ws`                                                         |
| `REDIS_URL`             | required | Local Redis for config cache and rate limiting                                             |
| `JWT_SECRET`            | required | Min 32 chars — validates consumer tokens                                                   |
| `TRUSTED_PROXY_CIDRS`   | empty    | Comma-separated trusted reverse-proxy IPs/CIDRs; forwarding headers are ignored by default |
| `PORT`                  | `3000`   | HTTP port                                                                                  |
| `PROXY_TIMEOUT_MS`      | `10000`  | Downstream request timeout                                                                 |
| `RATE_LIMIT_WINDOW_MS`  | `60000`  | Sliding window duration                                                                    |
| `RATE_LIMIT_UNAUTH_MAX` | `100`    | Requests/window for unauthenticated clients                                                |
| `RATE_LIMIT_AUTH_MAX`   | `500`    | Requests/window for authenticated consumers                                                |

Use `docker/gateway.env.example` as a non-secret gateway configuration template. Only list reverse proxies you control in `TRUSTED_PROXY_CIDRS`; do not use a broad network to make client IP detection appear to work. Route IP restrictions support IPv4 and IPv6.

## Local regression verification

Use OrbStack's Docker context. The isolated verification stack uses loopback ports 15432 and 16379, independently of production and other local projects:

```sh
docker compose -f docker/compose.verification.yml up -d --wait
TEST_DATABASE_URL=postgres://novagate_test:local-verification-only@127.0.0.1:15432/novagate_test \
TEST_REDIS_URL=redis://127.0.0.1:16379 \
NX_DAEMON=false NX_NO_CLOUD=true \
npm exec nx run-many -- -t test lint typecheck build --skipNxCache
```

The test credentials are for the isolated local stack only. Integration suites run when both TEST variables are set. CI supplies the same dependencies and runs integration suites on PRs targeting `dev`. Formal acceptance testing follows the remaining implementation phases.

Fresh PostgreSQL volumes are initialized with `docker/postgres-init.sql`; admin-api performs idempotent schema upgrades for existing volumes. The control plane uses `synchronize: false` to preserve admin authentication columns. Admin-api requires `PLATFORM_JWT_SECRET` with at least 32 characters; tenant operations require a signed bearer token whose subject matches the tenant ID. Signup goes through email verification, and tenant responses exclude password and recovery tokens.

## Release and developer checks

Use Node 24 (`.nvmrc`) and `npm ci`. `npm run check` runs lint, typecheck, tests and builds for the workspace. `npm run docker:up` (also `docker:up:dev`) starts the isolated PostgreSQL/Redis verification dependencies in OrbStack; `docker:down` stops them. Run application serve targets separately through Nx.

The pre-commit hook checks formatting of the staged content without writing files or adding unrelated edits. Format and stage the files you intend to commit.

The production workflow calls the same CI checks before building all release images. It queues releases, builds from the tested revision, deploys full SHA image tags, checks out that revision on the server and waits for container health. Pull requests into `dev` continue to run CI. Production secrets remain in GitHub environment secrets; this workflow change does not initiate a production release.

Tenant schema upgrades run in a transaction under a database migration lock. Legacy route CORS, IP restriction and body-limit fields are converted to plugins before their columns are removed; explicitly configured plugins take precedence. A failed migration rolls back and prevents admin API startup. An existing installation whose old migration already removed those fields needs its lost settings restored from a backup or re-entered; this repair cannot recover previously deleted values.

Configuration PUT requests preserve omitted fields. Send `null` to clear optional route retry, GraphQL, plugin or rate-limit override policies; use an empty array to clear consumer groups. Updating a missing configuration record returns 404.
