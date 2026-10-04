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

| Variable                       | Default     | Notes                                                                                      |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------ |
| `GATEWAY_API_KEY`              | required    | Authenticates gateway with control plane                                                   |
| `CONTROL_PLANE_URL`            | required    | `wss://ws.novagate.dev/gateway-ws`                                                         |
| `REDIS_URL`                    | required    | Local Redis for config cache and rate limiting                                             |
| `JWT_SECRET`                   | required    | Min 32 chars — validates consumer tokens                                                   |
| `TRUSTED_PROXY_CIDRS`          | empty       | Comma-separated trusted reverse-proxy IPs/CIDRs; forwarding headers are ignored by default |
| `PORT`                         | `3000`      | HTTP port                                                                                  |
| `HEALTH_DEFAULT_INTERVAL_MS`   | `10000`     | Legacy service probe interval; integer 1000–60000 ms, overridden by service settings       |
| `HEALTH_FAILURE_THRESHOLD`     | `3`         | Consecutive failures before eviction; integer 1–10                                         |
| `HEALTH_RECOVERY_THRESHOLD`    | `2`         | Consecutive successes before a failed target recovers; integer 1–10                        |
| `HEALTH_PROBE_TIMEOUT_MS`      | `3000`      | Absolute probe deadline including connection and headers; integer 100–10000 ms             |
| `HEALTH_PROBE_CONCURRENCY`     | `8`         | Maximum simultaneous probes per gateway; integer 1–64                                      |
| `GRPC_ENABLED`                 | `false`     | Enable the separate native HTTP/2 gRPC listener                                            |
| `GRPC_ALLOW_INSECURE`          | `false`     | Explicit private cleartext operation behind a trusted TLS-terminating proxy                |
| `GRPC_HOST`                    | `127.0.0.1` | Listener address; container deployments need an appropriate private interface              |
| `GRPC_PORT`                    | `50051`     | Listener port, 1–65535                                                                     |
| `GRPC_TLS_CERT_FILE`           | unset       | Read-only PEM server certificate file; pair with key                                       |
| `GRPC_TLS_KEY_FILE`            | unset       | Read-only PEM private key file; pair with certificate                                      |
| `GRPC_MAX_MESSAGE_BYTES`       | `4194304`   | Maximum encoded frame payload, 1–64 MiB; compressed payloads remain opaque                 |
| `GRPC_MAX_HEADER_BYTES`        | `16384`     | Request/response metadata bound, 1024–65536 bytes                                          |
| `GRPC_MAX_CONCURRENT_STREAMS`  | `100`       | Per-session stream cap, 1–1000, also capped by upstream settings                           |
| `GRPC_MAX_SESSIONS_PER_TARGET` | `4`         | Per-service/target upstream session cap, 1–32                                              |
| `GRPC_MAX_ACTIVE_CALLS`        | `256`       | Gateway admission cap and incoming-session cap, 1–10000                                    |
| `GRPC_DEADLINE_MS`             | `30000`     | Absolute maximum call duration, 100–3600000 ms; caller/service deadlines can shorten it    |
| `GRPC_IDLE_TIMEOUT_MS`         | `30000`     | Unused upstream session expiry, 1000–3600000 ms                                            |
| `GRPC_SHUTDOWN_GRACE_MS`       | `5000`      | Drain existing calls before cancellation, 0–60000 ms                                       |
| `PROXY_TIMEOUT_MS`             | `10000`     | Downstream request timeout                                                                 |
| `RATE_LIMIT_WINDOW_MS`         | `60000`     | Sliding window duration                                                                    |
| `RATE_LIMIT_UNAUTH_MAX`        | `100`       | Requests/window for unauthenticated clients                                                |
| `RATE_LIMIT_AUTH_MAX`          | `500`       | Requests/window for authenticated consumers                                                |

For native gRPC upstreams, choose **Native gRPC health service** in the Services form. Leave the health service name empty to check overall server health, or enter the name registered by the upstream. The gateway calls the standard `grpc.health.v1.Health/Check` RPC and accepts only a successful `SERVING` response; it caps the encoded health response at 4096 bytes and applies the gateway probe deadline and failure/recovery thresholds. Your upstream must implement that RPC. See the [official health service schema](https://github.com/grpc/grpc-proto/blob/master/grpc/health/v1/health.proto). HTTP health checks continue to use the configured path, with HTTP/2 when that service setting is enabled.

The Services form also exposes HTTP/2 upstream connections and WebSocket upgrades. Native gRPC client traffic uses the separate opt-in gRPC endpoint; the HTTP/2 setting controls ordinary HTTP proxy connections and HTTP health probes. The service timeout and caller `grpc-timeout` can shorten the gateway's maximum gRPC deadline. TLS/container and capacity acceptance for this transport remains in progress under issue #41.

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

### Dashboard browser verification

The workspace uses a responsive ivory, mint and indigo dashboard with CSS clay illustrations. Navigation and configuration forms support keyboard focus, Escape dismissal and focus restoration. Data outages show retry controls; an unavailable gateway status is distinct from an offline gateway.

Run the production standalone preview and its browser checks through Nx:

```sh
mkdir -p .local-work/t .local-work/s
NEXT_PUBLIC_ADMIN_API_URL=/ NX_DAEMON=false NX_NO_CLOUD=true \
TMPDIR="$PWD/.local-work/t" NX_SOCKET_DIR="$PWD/.local-work/s" \
npm exec nx run dashboard:ui-smoke
```

The verifier uses fixture credentials and intercepts tenant API requests. It checks desktop and mobile layouts, saved-session hydration, retry recovery, navigation and form keyboard behavior, every expanded plugin form, the one-time consumer key dialog, reduced motion and axe WCAG A/AA rules. Screenshots and accessibility findings are written under `.local-work/dashboard-verification/`. It uses local Google Chrome when available; otherwise install Playwright Chromium with `PLAYWRIGHT_BROWSERS_PATH="$PWD/.local-work/playwright" npm exec playwright install -- chromium`, and use the same environment variable when running checks. `DASHBOARD_BROWSER_EXECUTABLE` can select another Chromium executable. CI runs these checks and uploads the screenshots and findings.

Browser API calls default to the dashboard's same-origin `/api` rewrite. `NEXT_PUBLIC_ADMIN_API_URL` optionally selects another browser API origin at build time. Set it to `/` for a same-origin verification build when a local production env file already defines an override. `ADMIN_API_URL` selects the server-side rewrite destination. Both settings participate in the Nx build cache key. These fixture checks complement integration tests; they do not establish production or final phase acceptance.

### Private log archives with RustFS

Settings → **Log archives** queues a private NDJSON copy of a tenant's request logs. Choose a UTC range of up to 31 days, optionally a minimum response status or literal path prefix, then download the completed archive. The API also accepts a consumer filter. Failed reads and downloads offer recovery feedback. The dashboard lists the latest 50 jobs and refreshes every 30 seconds.

The API uses tenant session authorization for creation, listing and streaming downloads; it returns neither storage credentials nor private object keys. Jobs persist in PostgreSQL. Replicas claim jobs with row locks and tenant locks, renew fenced leases and recover interrupted work. Each replica runs at most two exports and each tenant has at most one active export and 20 pending requests. Each export reads a repeatable snapshot in 500-row keyset pages, preserves microsecond cursors, and stops at one million records, 512 MiB or two minutes. Automatic attempts stop after three failures; create a new archive with a smaller range when necessary. The worker never marks an incomplete upload ready.

Archives expire after seven days by default (`LOG_EXPORT_RETENTION_DAYS`, 1–90). Expiry immediately prevents API downloads; background cleanup removes attempt objects and abandoned multipart uploads. Cleanup retries after a storage outage, and expired job metadata remains available to explain why a download disappeared. Expired job metadata is kept for 30 more days, then removed only after successful object cleanup. Preserve archive jobs during tenant offboarding until their object prefixes have been deleted.

OrbStack verification includes RustFS 1.0.1 pinned by digest, persistent verification volumes, a loopback S3 listener on port 19000 and no published console. Run the live integration checks with:

```sh
docker compose -f docker/compose.verification.yml up -d --wait
TEST_DATABASE_URL=postgres://novagate_test:local-verification-only@127.0.0.1:15432/novagate_test \
TEST_REDIS_URL=redis://127.0.0.1:16379 \
TEST_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:19000 \
NX_DAEMON=false NX_NO_CLOUD=true npm exec nx run admin-api:test -- --skipNxCache
```

Production storage is disabled until configured. [docker/object-storage.env.example](docker/object-storage.env.example) lists the settings; choose real credentials in the deployment environment rather than editing tracked examples. `COMPOSE_PROFILES=object-storage` enables the bundled RustFS service (Compose 2.20+ is required for its optional dependency). It has persistent data/log volumes and readiness checks, joins only the internal gateway network, and publishes neither S3 nor console ports. External S3-compatible storage can use the same API settings without enabling that profile. Startup checks the bucket policy and ACL and refuses public grants; the adapter never adds a public policy or ACL. Keep AWS S3 Block Public Access enabled as an additional operator control.

Keep RustFS root credentials separate from the application's archive service account. Pre-create a private archive bucket, or use `OBJECT_STORAGE_CREATE_BUCKET=true` once with a provisioning identity and disable it afterward. The application account needs bucket location/list, policy/ACL read and multipart listing permissions, plus object get/put/delete and multipart abort permissions scoped to the archive bucket. It does not need to modify policies or ACLs. Use a TLS endpoint for external storage and restrict credential access. RustFS installation/readiness guidance: [official container documentation](https://docs.rustfs.com/en/installation/container) and [health endpoints](https://docs.rustfs.com/en/operations/status-check).

The bundled single-node storage has no distributed redundancy. Back up PostgreSQL job metadata and RustFS objects together, protect backup credentials and preserve the bucket/object paths. Restore both into an isolated environment first; verify a known archive through the authenticated download endpoint and confirm anonymous access is denied. Expired objects will be removed when the restored worker starts. Distributed storage, restore drills, scheduled exports, redaction controls and additional destinations remain roadmap work; local and CI evidence does not establish final production acceptance.
