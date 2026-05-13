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
│                            │          │  apps/dashboard  (Next.js 14)       │
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

| Layer | Technology |
| --- | --- |
| Gateway (data plane) | NestJS 10, TypeScript, Redis (sliding-window rate limiter) |
| Control plane | NestJS, WebSocket (`ws`), Redis pub/sub |
| Admin API | NestJS, TypeORM, PostgreSQL (schema-per-tenant) |
| Dashboard | Next.js 14 App Router, Tailwind CSS, SWR |
| Infrastructure | Docker, Docker Compose, Nginx (SSL termination), GitHub Actions |
| Monorepo | Nx 20 with project-boundary lint rules |

---

## Key Engineering Decisions

### Redis sliding-window rate limiter

Uses a sorted-set (`ZADD` / `ZREMRANGEBYSCORE` / `ZCOUNT`) so the window slides continuously rather than resetting on a fixed boundary. Redis failure is **fail-open** — the guard logs the error and allows the request rather than taking down traffic.

### Schema-per-tenant Postgres

Each tenant gets a dedicated schema (`tenant_<uuid>`) provisioned at signup. Queries never cross tenant boundaries at the SQL level — no `WHERE tenant_id = ?` guard rails needed.

### WebSocket config delivery with offline queue

The control plane holds one persistent WebSocket per connected gateway. If a gateway is offline when a config change is published, the update is stored in `public.pending_config_updates` and replayed on reconnect. Gateways also persist config to local Redis so they can cold-start without a control-plane round-trip.

### Nx module-boundary enforcement

ESLint tags prevent circular imports between `proxy`, `rate-limit`, `logging`, and `auth` layers. Shared state lives in `shared/` — nothing imports from `proxy` except `gateway.module.ts`.

---

## Monorepo Structure

```text
apps/
  api/            Gateway binary — Docker image deployed on customer VPS
  control-plane/  WebSocket server — config push & telemetry ingestion
  admin-api/      REST API for dashboard — CRUD, analytics, auth
  dashboard/      Next.js 14 tenant UI — route management, observability
libs/
  shared-types/   Single source of truth for WS message types, DB entities, TenantConfig
docker/
  Dockerfile.api
  Dockerfile.dashboard
  nginx.conf
.github/
  workflows/deploy.yml   Build → push GHCR → SSH deploy on merge to main
```

---

## Gateway Middleware Pipeline

Request path (order is load-bearing):

```text
JwtMiddleware → RateLimitGuard → LoggingInterceptor → ProxyMiddleware
```

- `JwtMiddleware` — decodes JWT, attaches `req.user`; never blocks (auth is enforced per-route by the proxy)
- `RateLimitGuard` — Redis sliding window; separate limits for authenticated vs unauthenticated clients
- `LoggingInterceptor` — captures latency, status, `X-Request-ID`; batches logs for async upload
- `ProxyMiddleware` — strips path prefix, forwards to downstream with timeout, streams response back

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
    image: ghcr.io/rawatshahab/novagate/api:latest
    environment:
      GATEWAY_API_KEY: <from novagate.dev/settings>
      CONTROL_PLANE_URL: wss://ws.novagate.dev/gateway-ws
      REDIS_URL: redis://redis:6379
      JWT_SECRET: <min 32 chars>
    ports:
      - "3000:3000"
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
2. Push to GitHub Container Registry (`ghcr.io/rawatshahab/novagate/*`)
3. SSH into VPS → `docker compose pull && docker compose up -d`

Zero-downtime: Docker Compose restarts containers one at a time; Nginx keeps serving during image pulls.

---

## Gateway Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `GATEWAY_API_KEY` | required | Authenticates gateway with control plane |
| `CONTROL_PLANE_URL` | required | `wss://ws.novagate.dev/gateway-ws` |
| `REDIS_URL` | required | Local Redis for config cache and rate limiting |
| `JWT_SECRET` | required | Min 32 chars — validates consumer tokens |
| `PORT` | `3000` | HTTP port |
| `PROXY_TIMEOUT_MS` | `10000` | Downstream request timeout |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration |
| `RATE_LIMIT_UNAUTH_MAX` | `100` | Requests/window for unauthenticated clients |
| `RATE_LIMIT_AUTH_MAX` | `500` | Requests/window for authenticated consumers |
