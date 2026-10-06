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
LoggingMiddleware → JwtMiddleware → [RateLimitGuard] → ProxyMiddleware
                                                               ↓
                                                       PluginRunner.onRequest
                                                       → forward to downstream
                                                       → PluginRunner.onResponse
```

- `JwtMiddleware` — attaches `req.user` when it recognises a platform JWT or consumer API key; passes through otherwise. Only hard-blocks on `TOKEN_EXPIRED` (platform-signed token that has expired). Third-party OIDC tokens are passed through for the `oidc` plugin to validate.
- `RateLimitGuard` — Redis sliding window; separate limits for authenticated vs unauthenticated clients
- `LoggingMiddleware` — observes actual response finish/close before authentication; captures monotonic latency, final status and validated `X-Request-ID`; batches logs for async upload
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

1. Run reusable CI: lint, typecheck, test, build and dashboard browser checks.
2. After CI succeeds, build and push Docker images for `api`, `control-plane`, `admin-api` and `dashboard` to GitHub Container Registry.
3. After every image build succeeds, SSH into the VPS and deploy the tested SHA, waiting for container health.

CI runs only within this deployment workflow on pushes to `main`. Pull requests and pushes to `dev`, tags and manual dispatch do not trigger CI or deployment. A failed verification job prevents all image publishing and the deployment script. Continue running feature and regression checks locally while implementation stays on `dev`.

Deployment uses images tagged with the tested commit SHA and waits for Docker Compose health checks before finishing.

TLS and routing: the VPS is shared with squadup.in, whose Caddy owns ports 80/443 and serves `novagate.dev`, `api.novagate.dev` and `ws.novagate.dev` (see `caddy/Caddyfile` in that repo). Caddy reaches `dashboard`, `admin-api` and `control-plane` over the `novagate-edge` network defined here, and issues and renews the certificates itself.

---

## Gateway Environment Variables

| Variable                                       | Default     | Notes                                                                                            |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `GATEWAY_API_KEY`                              | required    | Authenticates gateway with control plane                                                         |
| `CONTROL_PLANE_URL`                            | required    | `wss://ws.novagate.dev/gateway-ws`                                                               |
| `REDIS_URL`                                    | required    | Local Redis for config cache and rate limiting                                                   |
| `JWT_SECRET`                                   | required    | Min 32 chars — validates consumer tokens                                                         |
| `TRUSTED_PROXY_CIDRS`                          | empty       | Comma-separated trusted reverse-proxy IPs/CIDRs; forwarding headers are ignored by default       |
| `PORT`                                         | `3000`      | HTTP port                                                                                        |
| `HEALTH_DEFAULT_INTERVAL_MS`                   | `10000`     | Legacy service probe interval; integer 1000–60000 ms, overridden by service settings             |
| `HEALTH_FAILURE_THRESHOLD`                     | `3`         | Consecutive failures before eviction; integer 1–10                                               |
| `HEALTH_RECOVERY_THRESHOLD`                    | `2`         | Consecutive successes before a failed target recovers; integer 1–10                              |
| `HEALTH_PROBE_TIMEOUT_MS`                      | `3000`      | Absolute probe deadline including connection and headers; integer 100–10000 ms                   |
| `HEALTH_PROBE_CONCURRENCY`                     | `8`         | Maximum simultaneous probes per gateway; integer 1–64                                            |
| `WS_ALLOW_QUERY_TOKEN`                         | `false`     | Explicit legacy query-token opt-in; credentials are stripped from the upstream URL               |
| `WS_HANDSHAKE_TIMEOUT_MS`                      | `5000`      | Absolute auth, quota and upstream upgrade deadline, 100–60000 ms; service timeout can shorten it |
| `WS_MAX_CONNECTIONS`                           | `256`       | Cap including pending admission, accepted connections and cancelled provider work, 1–10000       |
| `WS_MAX_HEADER_BYTES`                          | `16384`     | Request and upstream handshake header limit, 1024–65536 bytes                                    |
| `WS_MAX_BUFFERED_HEAD_BYTES`                   | `65536`     | Bound on data coalesced with upgrade headers, 0–1048576 bytes                                    |
| `WS_IDLE_TIMEOUT_MS`                           | `300000`    | Inactive tunnel expiry, 1000–3600000 ms                                                          |
| `WS_SHUTDOWN_GRACE_MS`                         | `5000`      | Drain accepted tunnels before closing sockets, 0–60000 ms                                        |
| `GRPC_ENABLED`                                 | `false`     | Enable the separate native HTTP/2 gRPC listener                                                  |
| `GRPC_ALLOW_INSECURE`                          | `false`     | Explicit private cleartext operation behind a trusted TLS-terminating proxy                      |
| `GRPC_HOST`                                    | `127.0.0.1` | Listener address; container deployments need an appropriate private interface                    |
| `GRPC_PORT`                                    | `50051`     | Listener port, 1–65535                                                                           |
| `GRPC_TLS_CERT_FILE`                           | unset       | Read-only PEM server certificate file; pair with key                                             |
| `GRPC_TLS_KEY_FILE`                            | unset       | Read-only PEM private key file; pair with certificate                                            |
| `GRPC_MAX_MESSAGE_BYTES`                       | `4194304`   | Maximum encoded frame payload, 1–64 MiB; compressed payloads remain opaque                       |
| `GRPC_MAX_HEADER_BYTES`                        | `16384`     | Request/response metadata bound, 1024–65536 bytes                                                |
| `GRPC_MAX_CONCURRENT_STREAMS`                  | `100`       | Per-session stream cap, 1–1000, also capped by upstream settings                                 |
| `GRPC_MAX_SESSIONS_PER_TARGET`                 | `4`         | Per-service/target upstream session cap, 1–32                                                    |
| `GRPC_MAX_ACTIVE_CALLS`                        | `256`       | Admission cap (including pending cancelled auth/quota work) and incoming-session cap, 1–10000    |
| `GRPC_DEADLINE_MS`                             | `30000`     | Absolute maximum call duration, 100–3600000 ms; caller/service deadlines can shorten it          |
| `GRPC_IDLE_TIMEOUT_MS`                         | `30000`     | Unused upstream session expiry, 1000–3600000 ms                                                  |
| `GRPC_SHUTDOWN_GRACE_MS`                       | `5000`      | Drain existing calls before cancellation, 0–60000 ms                                             |
| `IDENTITY_PROVIDER_ALLOW_INSECURE_HTTP`        | `false`     | Explicit private HTTP opt-in                                                                     |
| `IDENTITY_PROVIDER_TIMEOUT_MS`                 | `5000`      | Absolute provider/cache verification deadline, 100–60000 ms                                      |
| `IDENTITY_PROVIDER_MAX_RESPONSE_BYTES`         | `262144`    | Provider JSON response limit, 1024–1048576 bytes                                                 |
| `IDENTITY_PROVIDER_MAX_HEADER_BYTES`           | `16384`     | Provider response header limit, 1024–65536 bytes                                                 |
| `IDENTITY_PROVIDER_MAX_TOKEN_BYTES`            | `16384`     | Credential/token byte limit, 128–65536 bytes                                                     |
| `IDENTITY_PROVIDER_MAX_PENDING_REQUESTS`       | `128`       | Pending callers including cancelled unsettled work, 1–10000                                      |
| `IDENTITY_PROVIDER_MAX_CONCURRENT_FETCHES`     | `16`        | Simultaneous provider connections, 1–256                                                         |
| `IDENTITY_PROVIDER_MAX_CACHE_ENTRIES`          | `128`       | Per-process shared LRU cache cap, 1–4096                                                         |
| `IDENTITY_PROVIDER_MAX_JWKS_KEYS`              | `64`        | Keys accepted per JWKS document, 1–256                                                           |
| `IDENTITY_PROVIDER_JWKS_CACHE_TTL_MS`          | `300000`    | JWKS lifetime, 1000–86400000 ms                                                                  |
| `IDENTITY_PROVIDER_JWKS_REFRESH_COOLDOWN_MS`   | `30000`     | Unknown-key refresh cooldown, 1000–60000 ms                                                      |
| `IDENTITY_PROVIDER_INTROSPECTION_CACHE_TTL_MS` | `30000`     | Maximum active introspection cache lifetime, 0–300000 ms; 0 disables                             |
| `IDENTITY_PROVIDER_OUTBOUND_CACHE_TTL_MS`      | `3600000`   | Maximum outbound credential lifetime, 0–86400000 ms; 0 disables                                  |
| `HTTP_TLS_CERT_FILE`                           | `unset`     | PEM server certificate/chain; pair with key to enable HTTPS/WSS                                  |
| `HTTP_TLS_KEY_FILE`                            | `unset`     | Read-only PEM listener private key; never upload private keys to dashboard                       |
| `HTTP_TLS_CLIENT_CA_FILE`                      | `unset`     | Read-only verified client CA bundle; requests TLS client certificates                            |
| `HTTP_TLS_CRL_FILE`                            | `unset`     | Optional PEM revocation list; requires listener client CA                                        |
| `GRPC_TLS_CLIENT_CA_FILE`                      | `unset`     | Native gRPC client CA bundle; requires gRPC cert/key                                             |
| `GRPC_TLS_CRL_FILE`                            | `unset`     | Optional gRPC revocation list; requires gRPC client CA                                           |
| `TLS_HANDSHAKE_TIMEOUT_MS`                     | `10000`     | HTTP/gRPC native TLS handshake deadline, 100–60000 ms                                            |
| `HTTP_TLS_MAX_CONNECTIONS`                     | `1024`      | Native HTTPS socket cap, 1–100000                                                                |
| `MTLS_TRUSTED_PROXY_CIDRS`                     | `empty`     | Explicit socket-peer CIDRs for verifying certificate proxies; wildcard trust rejected            |
| `MTLS_MAX_CERTIFICATE_BYTES`                   | `16384`     | Native/forwarded client chain byte limit, 1024–65536 bytes                                       |
| `MTLS_MAX_CA_BUNDLE_BYTES`                     | `65536`     | Tenant trust bundle limit, 1024–65536 bytes                                                      |
| `MTLS_MAX_CHAIN_DEPTH`                         | `8`         | Maximum parsed certificate chain/tenant anchor count, 1–16                                       |
| `MTLS_MAX_IDENTITY_BYTES`                      | `4096`      | Verified subject-header byte limit, 128–16384 bytes                                              |
| `PROXY_TIMEOUT_MS`                             | `10000`     | Downstream request timeout                                                                       |
| `RATE_LIMIT_WINDOW_MS`                         | `60000`     | Sliding window duration                                                                          |
| `RATE_LIMIT_UNAUTH_MAX`                        | `100`       | Requests/window for unauthenticated clients                                                      |
| `RATE_LIMIT_AUTH_MAX`                          | `500`       | Requests/window for authenticated consumers                                                      |

For native gRPC upstreams, choose **Native gRPC health service** in the Services form. Leave the health service name empty to check overall server health, or enter the name registered by the upstream. The gateway calls the standard `grpc.health.v1.Health/Check` RPC and accepts only a successful `SERVING` response; it caps the encoded health response at 4096 bytes and applies the gateway probe deadline and failure/recovery thresholds. Your upstream must implement that RPC. See the [official health service schema](https://github.com/grpc/grpc-proto/blob/master/grpc/health/v1/health.proto). HTTP health checks continue to use the configured path, with HTTP/2 when that service setting is enabled.

WebSocket clients use the HTTP listener and a GET route pointing to a service with **WebSocket upgrades** enabled. Header Bearer credentials accept consumer API keys or HS256 gateway JWTs. Basic Auth, OIDC, OAuth introspection, ACL and IP restriction are compatible handshake plugins; unsupported plugins reject the upgrade explicitly. Outbound OAuth credential injection does not authenticate an inbound client. Upgrade quotas apply after verified authentication, and forwarding/certificate assertions are stripped before authorization. Prefer Authorization headers; browser clients that need `?token=` must use the explicit operator opt-in. Query credentials never reach the upstream URL or gateway connection logs.

Accepted tunnels preserve text, binary, fragmentation, ping/pong, close frames, negotiated subprotocols and compression bytes with stream backpressure. The handshake follows [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455#section-4); the transport uses [Node HTTP upgrade sockets](https://nodejs.org/docs/latest-v24.x/api/http.html#event-upgrade). HTTPS upstreams verify certificates using Node’s trust store. Tenant, route policy, consumer, service or target removal closes affected connections. Handshake deadlines include provider and quota work, and disconnected requests retain admission capacity until that work settles. Active connections and traffic bytes are counted only after successful upstream acceptance. Shutdown rejects new upgrades and permits accepted tunnels to drain for the configured grace before terminating remaining sockets; it does not inject frames into an opaque partial frame. WebSocket authentication happens during the handshake; continuous message authorization is outside this transport’s contract.

The Services form also exposes HTTP/2 upstream connections and WebSocket upgrades. Native gRPC client traffic uses the separate opt-in gRPC endpoint; the HTTP/2 setting controls ordinary HTTP proxy connections and HTTP health probes. The service timeout and caller `grpc-timeout` can shorten the gateway's maximum gRPC deadline. Live-network verification covers listener/upstream TLS, call/session admission limits, cancellation reuse, slow-client backpressure and shutdown grace. Upstreams use Node’s certificate trust store; mount a private CA and set `NODE_EXTRA_CA_CERTS` before startup when your upstream uses a private PKI. Certificate/key mounts must be readable by the image’s non-root UID 1000. Publish the gRPC port explicitly on your private network when enabling the listener.

The gateway data plane uses Redis and tenant configuration from the control plane. It has no PostgreSQL connection or local administrative CRUD; manage services through the authenticated tenant admin API. `DATABASE_URL` is required by the admin API and control plane, and is ignored by the gateway.

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

The test credentials are for the isolated local stack only. Integration suites run when both TEST variables are set. Release CI supplies the same dependencies before deployment on a push to `main`; development PRs use local verification. Formal acceptance testing follows the remaining implementation phases.

Fresh PostgreSQL volumes are initialized with `docker/postgres-init.sql`; admin-api performs idempotent schema upgrades for existing volumes. The control plane uses `synchronize: false` to preserve admin authentication columns. Admin-api requires `PLATFORM_JWT_SECRET` with at least 32 characters; tenant operations require a signed bearer token whose subject matches the tenant ID. Signup goes through email verification, and tenant responses exclude password and recovery tokens.

The packaged gRPC verifier creates a disposable gateway/Redis network with no PostgreSQL dependency. Build the image, then run the task:

```sh
docker build -f docker/Dockerfile.api -t novagate-api:verification .
NOVAGATE_GRPC_IMAGE=novagate-api:verification npm exec -- nx run @api-gateway/api:grpc-container-smoke
```

It requires OrbStack, OpenSSL and access to the pinned grpcurl image. It generates short-lived fixture certificates inside `.local-work`, checks authenticated protobuf calls with grpcurl and real WebSocket traffic through trusted/untrusted TLS upstreams, and writes evidence to `.local-work/grpc-container-evidence.json`. WebSocket checks cover malformed-token survival, negotiated compression/subprotocols, binary/text/control traffic, actual Redis route quota, connection capacity, live metrics and target removal. It verifies absent local admin CRUD and an authenticated tenant proxy route on the same prefix, then removes its containers, network and certificate directory. Existing storage and cache contents are preserved.

## Release and developer checks

Use Node 24 (`.nvmrc`) and `npm ci`. `npm run check` runs lint, typecheck, tests and builds for the workspace. `npm run docker:up` (also `docker:up:dev`) starts the isolated PostgreSQL/Redis verification dependencies in OrbStack; `docker:down` stops them. Run application serve targets separately through Nx.

The pre-commit hook checks formatting of the staged content without writing files or adding unrelated edits. Format and stage the files you intend to commit.

The production workflow calls the same CI checks before building all release images. It queues releases, builds from the tested revision, deploys full SHA image tags, checks out that revision on the server and waits for container health. Pull requests and pushes to `dev` do not run CI; verification is a prerequisite within the `main` deployment workflow. Production secrets remain in GitHub environment secrets; this workflow change does not initiate a production release.

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

### Remote authentication providers

OIDC and OAuth endpoints require HTTPS with normal certificate verification. Redirects are rejected. Explicit private HTTP requires `IDENTITY_PROVIDER_ALLOW_INSECURE_HTTP=true`. Provider calls and cache reads/writes share an absolute deadline and bounded admission; concurrent callers coalesce without allowing one cancelled caller to abort others. Cache scopes include tenant, endpoint, issuer/audience, credentials and token identity, so tenant changes or credential rotation cannot reuse another trust scope. Introspection caches contain only active responses with a known future expiration and never exceed the configured lifetime; Redis failure falls back to remote verification. Outbound OAuth tokens never establish inbound client authentication.

OIDC requires an expiring JWT, a matching issuer/audience and an explicitly compatible public signing key. RSA keys must be at least 2048 bits. Client-supplied `x-claim-*` headers are removed before verified claims are forwarded. Unknown signing keys can refresh only after the cooldown; providers should overlap signing keys during rotation.

### Client certificates and tenant trust

Enable native HTTPS/WSS with `HTTP_TLS_CERT_FILE` and `HTTP_TLS_KEY_FILE`, mount a client CA bundle with `HTTP_TLS_CLIENT_CA_FILE`, and upload the tenant's active public CA bundle in Settings. Native gRPC uses its existing listener cert/key and `GRPC_TLS_CLIENT_CA_FILE`. Mount operator files read-only, with permissions readable by the non-root gateway. Native listeners use TLS 1.2 or newer and bounded handshakes; they request client certificates while allowing anonymous health/public routes. Required mTLS routes need a verified peer certificate with clientAuth extended key usage and current tenant trust. A copied public certificate is insufficient. Resumed sessions without a peer certificate are rejected on required mTLS routes.

OpenSSL verifies native certificate paths and any configured CRLs. PEM listener/private-key/CA/CRL files are bounded to 64 KiB; restart the gateway after changing these operator files. Tenant CA changes update native listener client trust without a restart and close affected gRPC calls and WebSocket tunnels; HTTP requests recheck current trust. Operator file mounts enable the listener initially; later public CA uploads replace its client trust. With CRLs enabled, the operator must supply CRLs covering every active issuing CA. Overlap old/new CA certificates while rotating, then remove old trust. Tenant uploads accept at most eight currently active CA certificates and reject leaf certificates, keys and malformed bundles.

Forwarded certificates default off. `MTLS_TRUSTED_PROXY_CIDRS` explicitly trusts only the actual socket peer; it is separate from IP forwarding trust. Your trusted TLS terminator must verify client private-key possession and overwrite `ssl_client_cert` plus `ssl_client_verify: SUCCESS` (or the corresponding `x-ssl-client-cert`/`x-ssl-client-verify` pair). For intermediate chains, include the validated client chain in the URL-encoded PEM assertion. Duplicate/ambiguous assertions are rejected. Restrict access to that gateway connection to the trusted proxy; forwarded client IPs cannot grant certificate trust. The gateway rechecks current tenant anchors and clientAuth usage; full path/revocation verification belongs to the trusted terminator.

Verified identity uses a certificate fingerprint, with a bounded safe subject header. The Docker health probe checks loopback HTTPS when enabled and skips certificate/hostname verification only for that local liveness request; client/provider/upstream TLS verification remains enabled. Native listener behavior follows the [Node TLS documentation](https://nodejs.org/download/release/v24.20.0/docs/api/tls.html).

### Webhook signatures

Use `hmac-auth` with `mode: generic` (the default) for GitHub/raw-body SHA-256 or SHA-512 signatures. Use `mode: stripe`, `header: stripe-signature`, `algorithm: sha256` for Stripe's `t=<seconds>,v1=<hex>` format: the signed bytes are `timestamp.body`. Multiple v1 signatures and up to eight overlapping secrets support rotation. Original wire headers and bytes are captured before body-aware hooks; policy hooks retain their saved order. Duplicate signature headers, partial hex, invalid/absent signed timestamps and stale/future timestamps fail closed.

For custom generic timestamp signatures, configuring `timestampHeader` **requires signing `timestamp.body`**. This corrects the old unsigned timestamp check: senders using that option must update their signing format. Freshness defaults to 300 seconds and may be configured from 1–3600 seconds. A timestamp-free GitHub signature proves body authenticity but does not prevent replay. Keep durable event-ID deduplication in your application: valid provider retries are intentionally accepted. Use HTTPS and high-entropy private signing secrets; never put secrets in logs or source control. These are HTTP webhook policies, not gRPC/WebSocket handshake credentials.

| Gateway setting             | Default | Bounds/purpose                                                                      |
| --------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `HMAC_MAX_BODY_BYTES`       | 1048576 | 1–16777216 bytes; the smaller explicit route size limit also applies                |
| `HMAC_BODY_TIMEOUT_MS`      | 5000    | 100–30000 ms absolute upload deadline                                               |
| `HMAC_MAX_PENDING_REQUESTS` | 32      | 1–256 concurrent prepared requests, retained until response completion/cancellation |
| `HMAC_MAX_HEADER_BYTES`     | 4096    | 128–16384 bytes per signature/timestamp field                                       |

Each route permits up to eight nonempty secrets, each at most 4096 UTF-8 bytes, and at most eight Stripe v1 signatures. Oversized uploads return 413, upload deadlines 408, admission exhaustion 503 and signature failures 401. Limits apply to cached and chunked bodies; cancelled/aborted uploads release listeners and admission. Preparation never authenticates: verification remains in the ordered HMAC policy hook.

Provider references: [GitHub validation and reference vector](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [Stripe webhook verification](https://docs.stripe.com/webhooks), [Stripe's signature implementation](https://github.com/stripe/stripe-node/blob/master/src/Webhooks.ts).

### Bounded GraphQL request policies

Enable `graphql-guard` on a route or set its legacy `graphql` policy. Defaults are depth 10, weighted field complexity 1000 and introspection disabled. Depth is 1–100 and complexity is 1–100000. When both policies exist, their explicit limits intersect; every configured policy must explicitly permit introspection. Null disables the legacy policy. Duplicate plugin names are rejected. The dashboard consolidates both representations into one visible plugin and saves `graphql: null`; disabling every plugin saves `plugins: []`.

The pinned official GraphQL AST parser checks GET query parameters, JSON POST and raw `application/graphql` POST. It selects the requested operation, expands fragment depth and repeated-spread cost without recursively expanding the fragment graph, and checks aliases, inline fragments, cycles, duplicate definitions and introspection. GET mutations return 405. Batches, persisted-query extensions and subscriptions are rejected until dedicated policies exist. Unsupported methods/media/compression fail before forwarding. A final validation hook rechecks transformed queries and headers before dispatch.

Complexity is a conservative schema-free weighted field count, including repeated spreads. It does not estimate resolver execution, pagination cardinality or response size. Schema-aware cost multipliers and persisted-operation manifests remain roadmap requirements.

| Variable                            | Default  | Valid range / purpose                              |
| ----------------------------------- | -------- | -------------------------------------------------- |
| `GRAPHQL_MAX_QUERY_BYTES`           | 65536    | 128–1048576 bytes                                  |
| `GRAPHQL_MAX_TOKENS`                | 10000    | 16–20000 tokens                                    |
| `GRAPHQL_MAX_LEXICAL_DEPTH`         | 128      | 8–256 nested punctuation groups before parsing     |
| `GRAPHQL_MAX_BODY_BYTES`            | 1048576  | 128–16777216 bytes                                 |
| `GRAPHQL_BODY_TIMEOUT_MS`           | 5000     | 100–30000 ms absolute upload deadline              |
| `GRAPHQL_MAX_PENDING_REQUESTS`      | 32       | 1–256 prepared requests                            |
| `BODY_CAPTURE_MAX_BODY_BYTES`       | 16777216 | 1–67108864 bytes across body-aware policies        |
| `BODY_CAPTURE_TIMEOUT_MS`           | 5000     | 100–30000 ms absolute upload deadline              |
| `BODY_CAPTURE_MAX_PENDING_REQUESTS` | 64       | 1–512 prepared requests across body-aware policies |

HMAC, GraphQL and request-size policies share one bounded capture of original bytes; the smallest applicable byte and deadline limit wins. Shared and mode-specific admission remain held until response finish, close or cancellation. No policy reconstructs signed bytes from parsed JSON. Capacity failures return 503, body overflow 413 and capture timeout 408; GraphQL policy/parse failures return 400, invalid configuration 500. Errors retain the gateway request ID and omit query contents. Native WebSocket/gRPC listeners reject HTTP-only GraphQL policies and cancel affected existing streams after policy changes.

Request telemetry uses matched route patterns (or `unmatched`), excludes raw query strings and user agents, and replaces malformed client request IDs with UUIDs. Broader telemetry/redaction acceptance remains part of phase 4 and the final campaign.

### Bounded HTTP/2 upstream connections

A service with `h2: true` uses verified Node HTTP/2 connections and waits for peer SETTINGS before opening an application stream. No active request queues past the configured pool/peer capacity. Capacity and shutdown admission failures return 503; oversized request metadata returns 431; oversized responses or malformed/reset upstream streams return 502; absolute connection/stream deadlines return 504. Body capture uses the shared original-byte size, deadline and admission limits above and never reconstructs signed JSON.

Idle eviction closes real sockets and deletes empty origins. GOAWAY prevents reuse; active streams retain their capacity until closure. Configuration changes close removed origins and tenant-changed sessions. Shutdown cancels work and stops admission. Buffered response bytes and headers are finite; these settings govern HTTP/2 forwarding, while native gRPC uses its separate transport limits.

| Variable                          | Default | Valid range                                |
| --------------------------------- | ------- | ------------------------------------------ |
| `HTTP2_MAX_TARGETS`               | 64      | 1–1024 origins                             |
| `HTTP2_MAX_SESSIONS`              | 64      | 1–1024 sessions globally                   |
| `HTTP2_MAX_SESSIONS_PER_TARGET`   | 10      | 1–32 sessions per origin                   |
| `HTTP2_MAX_STREAMS_PER_SESSION`   | 100     | 1–1024, further limited by peer SETTINGS   |
| `HTTP2_MAX_ACTIVE_REQUESTS`       | 64      | 1–1024, including connection setup         |
| `HTTP2_MAX_RESPONSE_BYTES`        | 4194304 | 1–67108864 bytes per buffered response     |
| `HTTP2_MAX_HEADER_BYTES`          | 16384   | 1024–65536 bytes, including field overhead |
| `HTTP2_CONNECT_TIMEOUT_MS`        | 5000    | 100–30000 ms absolute SETTINGS deadline    |
| `HTTP2_IDLE_TIMEOUT_MS`           | 30000   | 100–300000 ms for inactive sessions        |
| `PROXY_MAX_HANDLER_CACHE_ENTRIES` | 256     | 1–4096 HTTP proxy handlers                 |

Size memory budgets for concurrency times request/response byte limits plus Node session overhead. Admission is bounded rather than an unbounded waiting queue. An idle sweep runs at most one second apart. Origin pooling shares connections, not request credentials; every request retains its own authenticated headers and policy context.

HTTP health probes use the same predispatch negotiation fallback under their existing absolute probe deadline; gRPC health probes never fall back to HTTP/1.

HTTP/1 fallback is allowed only for recognized connection/protocol negotiation failures before dispatch. Certificate/trust failures, capacity exhaustion, deadlines and already-dispatched streams cannot trigger fallback. The fallback retains verified HTTPS, original bytes, ordered response hooks and the remaining absolute upstream deadline. Before response headers, expiry returns 504; after streaming headers, expiry closes the connection because its status is already committed. Pool idle/deadline bookkeeping uses monotonic time. A reset POST is never replayed through HTTP/1; configured retries remain restricted to GET/HEAD/OPTIONS. Upstream response status and headers are passed through HTTP/2 response hooks before committing the buffered body. Private targets and raw upstream error strings are omitted from HTTP/2 error telemetry.

### Load-balancer state limits

Issue #57 adds bounded per-replica balancing state and a persisted service `loadBalancing` policy (`weighted-round-robin` by default, or `least-connections`). Reservations cover HTTP/1 requests, HTTP/2 and native gRPC streams, and WebSocket tunnels. Concurrent protocol tests verify busy-target avoidance and release after cancellation/closure. PostgreSQL integration and dashboard browser checks verify policy persistence.

| Variable                                | Default | Valid range                                          |
| --------------------------------------- | ------- | ---------------------------------------------------- |
| `LOAD_BALANCER_MAX_SERVICES`            | 1024    | 1–4096 cached service states                         |
| `LOAD_BALANCER_MAX_TARGETS_PER_SERVICE` | 256     | 1–1024 target states per service                     |
| `LOAD_BALANCER_MAX_ACTIVE_RESERVATIONS` | 4096    | 1–65536 reservations, including detached generations |

The admin API accepts at most 256 unique HTTP/HTTPS targets per service, without embedded credentials and with URLs bounded to 2048 UTF-8 bytes. Weights must be integers from 1 to 100. Least-connections compares active work divided by weight; equal load uses weighted rotation. Core reservations release once and retain their original generation, so stale completion cannot decrement new target counters. Capacity exhaustion returns 503; invalid gateway balancing configuration returns 500. Dispatch must retain reservations until actual upstream request/stream/tunnel closure.

## Distributed tracing

Manual tracing uses the pinned OpenTelemetry JavaScript SDK and validated W3C trace context. It does not extract baggage or export raw request targets, queries, credentials, user agents or payloads. Recording admission, SDK attributes/events/links, queue count/bytes, batch count/bytes and WebSocket buffered bytes are finite. Explicit per-request context avoids cross-request global state; old tenant generations cannot export into replacement tenant connections. Export is best effort and never adds a waiting queue to responses. HTTP, native gRPC and WebSocket request/attempt spans reach authenticated tenant storage and the dashboard Traces explorer. Open traces from correlated request logs, or search by time preset, exact trace/request ID, route and error outcome. Timelines show received gateway/attempt spans and explain sampling, missing parents and truncation; external downstream span ingestion is planned with phase 5 OTLP support.

| Variable                     | Default | Accepted range                                                             |
| ---------------------------- | ------- | -------------------------------------------------------------------------- |
| `TRACING_ENABLED`            | true    | boolean                                                                    |
| `TRACING_SAMPLE_RATE`        | 0.1     | 0–1 for new roots; respects valid parent decisions within admission limits |
| `TRACING_MAX_ACTIVE_SPANS`   | 1024    | 1–16384                                                                    |
| `TRACING_MAX_QUEUED_SPANS`   | 512     | 1–8192                                                                     |
| `TRACING_MAX_QUEUE_BYTES`    | 1048576 | 8192–16777216 bytes                                                        |
| `TRACING_MAX_BATCH_SPANS`    | 32      | 1–128                                                                      |
| `TRACING_MAX_BATCH_BYTES`    | 65536   | 8192–65536 bytes                                                           |
| `TRACING_FLUSH_INTERVAL_MS`  | 1000    | 100–30000 ms                                                               |
| `TRACING_MAX_BUFFERED_BYTES` | 131072  | 8192–1048576 bytes, including the next batch                               |

The shared trace wire contract allows 16 whitelisted scalar attributes, at most 256 UTF-8 bytes each, 8192 bytes per span, and 128 spans/65536 bytes per batch. Capacity and transport drops have bounded reason labels in Prometheus. Logs retain integer milliseconds for existing PostgreSQL schemas; trace spans preserve fractional timing. See the [OpenTelemetry trace SDK](https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/sdk-trace/README.md) for manual instrumentation concepts.

Control-plane and admin query limits are documented in [docker/tracing.env.example](docker/tracing.env.example). By default each tenant retains up to 100,000 spans for seven days; ingestion admits eight concurrent transactions with 5-second statement/1-second lock deadlines. Idle cleanup visits up to 64 tenant tables each minute. Admin trace queries admit eight concurrent transactions, use a 3-second statement deadline, allow seven-day ranges, return 50 traces per page and at most 256 detail spans. `TRACE_RETENTION_DAYS` must match across the control plane and admin API. Queries immediately hide expired spans; background physical deletion can take multiple ticks. Trace delivery is best effort, so use durable audit facilities for audit requirements.

## Live HTTP metrics

The Overview streams completed HTTP request rates, error rates (final status 400
or above, including cancellation), and latency percentiles. Percentiles are fixed
histogram bucket upper estimates. Native gRPC/WebSocket counters remain available
through Prometheus. A single gateway timer reports every second using bounded
transient transport; disconnected snapshots are dropped, counted by
`gateway_metric_snapshots_dropped_total`, and never queued for replay.

The control plane validates and stores each report before publishing it to Redis.
`GET /api/tenants/:tenantId/metrics/stream` requires the workspace's bearer session
in the Authorization header. Tokens in URLs are rejected. The dashboard uses
authenticated fetch streaming, loads history on connection, retains up to 600
latest samples within one hour, and supports automatic/manual reconnect with
stale-data feedback. Switching workspaces cancels the previous requests and clears
their samples. Other dashboard lists refresh every 30 seconds.

Streaming replicas each use one Redis subscriber. Defaults allow 256 connections,
eight per tenant, eight simultaneous history reads and 64 KiB write buffers.
Heartbeats run every 15 seconds; streams close at session expiry or five minutes,
on subscription loss, shutdown or backpressure. The admin HTTP adapter closes remaining transport sockets after service cleanup so abandoned preconnections cannot prevent shutdown. Reconnecting reads the latest
persisted sample; Redis notifications are best effort. The reverse proxy must
preserve streaming and honor `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no`.

Metric ingestion admits 32 concurrent transactions with 3-second statement and
1-second lock deadlines. Each tenant keeps at most 100,000 samples for seven days;
the row cap can shorten that history. Idle expiry visits at most 64 tenant tables
per minute. Queries immediately filter expired data. Keep `METRICS_RETENTION_DAYS`
consistent between admin and control plane. Gateway budgets are in
[docker/gateway.env.example](docker/gateway.env.example); ingestion, stream and
history budgets are in [docker/tracing.env.example](docker/tracing.env.example).

After building the three production images locally with OrbStack, run the complete
pipeline verifier:

```sh
docker build -f docker/Dockerfile.api -t novagate-api:verification .
docker build -f docker/Dockerfile.admin-api -t novagate-admin:verification .
docker build -f docker/Dockerfile.control-plane -t novagate-control-plane:verification .
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run @api-gateway/api:metrics-container-smoke
```

This fixture creates its own database, Redis, network and containers, checks actual
gateway traffic through persistence and authenticated SSE within two seconds,
verifies stored history and reconnect, then evaluates actual gateway windows and
delivers firing/recovery alerts to disposable webhook, Slack-format and Mailtr-format
receivers. It checks webhook signatures, a durable five-second retry with a stable ID,
credential redaction, revision conflicts and retained history before removing its
resources. Evidence is
written inside `.local-work/metrics-container-evidence.json`. Run the retained
`@api-gateway/api:grpc-container-smoke` transport checks and `dashboard:ui-smoke`
browser/accessibility checks as well.

### Tenant alerts

Open **Observability → Alerts** to create error-rate, downstream-timeout, p95-latency
or RPS rules, choose notification channels and follow delivery history. The interface
shows missing evidence, paused rules/channels, firing cooldowns and verified recovery.
Rule/channel changes use revision checks; saved secrets remain hidden and rotation
requires explicit replacement. Empty channel selection records history only.

Operators configure dedicated encryption keys and optional Mailtr credentials using
[docker/alerting.env.example](docker/alerting.env.example). Default notification egress
uses validated public HTTPS; intentional private receivers require exact trusted
origins. Read the [alerting guide](apps/admin-api/src/alerts/README.md) for key rotation,
webhook signature verification, finite retries and at-least-once delivery semantics.
API acceptance does not prove final email inbox receipt. Formal provider/phase
acceptance remains separate from local development checks.
