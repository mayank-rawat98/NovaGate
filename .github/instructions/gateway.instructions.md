# Gateway Backend Instructions

This file is mandatory reading before any implementation in `apps/api`.
It defines module conventions, folder structure, naming rules, and
patterns that all code in this service must follow.

---

## Folder Structure

```
apps/api/src/
  gateway/
    auth/
      jwt.middleware.ts
      jwt.middleware.spec.ts
    rate-limit/
      rate-limit.guard.ts
      rate-limit.guard.spec.ts
      rate-limit.service.ts
      rate-limit.service.spec.ts
    proxy/
      proxy.middleware.ts
      proxy.middleware.spec.ts
      proxy.service.ts
      proxy.service.spec.ts
    logging/
      logging.interceptor.ts
      logging.interceptor.spec.ts
    metrics/
      metrics.service.ts
      metrics.service.spec.ts
      metrics.controller.ts
      metrics.controller.spec.ts
    health/
      health.controller.ts
      health.controller.spec.ts
    gateway.module.ts
  config/
    configuration.ts
    configuration.schema.ts
  main.ts
  app.module.ts
```

Never create files outside this structure without updating this document first.
If a new concern does not fit an existing folder, create a new named folder —
do not dump files in the `gateway/` root.

---

## Module Rules

- `GatewayModule` is the single NestJS module that imports all gateway concerns
- Each subfolder (auth, rate-limit, proxy, logging, metrics, health) exports
  exactly one primary class (middleware, guard, interceptor, service, or controller)
- Cross-subfolder imports are allowed only downward:
  - `proxy` may import from `metrics`
  - `rate-limit` may import from `metrics`
  - `logging` may import from `metrics`
  - Nothing imports from `proxy`, `logging`, or `auth` except `gateway.module.ts`
- Circular imports are a hard error — if you need shared state between two
  subfolders, it belongs in a new `shared/` subfolder with its own service

---

## Middleware Pipeline Order

The pipeline order in `main.ts` or `app.module.ts` must always be:

```
1. JwtMiddleware        (attaches req.user, never blocks)
2. RateLimitGuard       (reads req.user to determine tier)
3. LoggingInterceptor   (wraps full request lifecycle)
4. ProxyMiddleware      (forwards to downstream)
```

This order is load-bearing:
- RateLimitGuard must run after JwtMiddleware so it can read `req.user`
  for authenticated tier assignment
- LoggingInterceptor must wrap ProxyMiddleware so downstream latency
  is captured in the log entry
- Never insert a new middleware/guard/interceptor without specifying
  its position relative to this pipeline in the PR description

---

## Naming Conventions

| Concern         | File suffix              | Class suffix         |
|-----------------|--------------------------|----------------------|
| Guard           | `.guard.ts`              | `Guard`              |
| Middleware      | `.middleware.ts`         | `Middleware`         |
| Interceptor     | `.interceptor.ts`        | `Interceptor`        |
| Service         | `.service.ts`            | `Service`            |
| Controller      | `.controller.ts`         | `Controller`         |
| Config schema   | `.schema.ts`             | `Schema`             |
| Unit test       | `.spec.ts`               | (same as source)     |

- All file names are kebab-case
- All class names are PascalCase
- All NestJS injectable classes use `@Injectable()` — no exceptions
- Environment variable names are SCREAMING_SNAKE_CASE
- All config keys accessed via `ConfigService` are typed — no `config.get<any>()`

---

## Configuration Rules

All runtime config lives in `config/configuration.ts` and is validated
by `config/configuration.schema.ts` using Joi on startup.

```typescript
// configuration.ts — shape reference
export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  redis: {
    url: process.env.REDIS_URL,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
  },
  proxy: {
    timeout: parseInt(process.env.PROXY_TIMEOUT_MS, 10) || 10000,
    services: [
      // { name, targetUrl, pathPrefix } entries only
    ],
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    unauthMax: parseInt(process.env.RATE_LIMIT_UNAUTH_MAX, 10) || 100,
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) || 500,
  },
});
```

Rules:
- Never read `process.env` directly outside of `configuration.ts`
- Never hardcode threshold numbers, URLs, or secrets in guard/service/middleware files
- Adding a new config key requires a corresponding Joi rule in `configuration.schema.ts`
- Adding a new environment variable requires updating `.env.example` and the README table

---

## Error Response Shape

All error responses from the gateway (not from downstream services) must
follow this exact shape:

```json
{
  "error": "ERROR_CODE",
  "message": "Human readable description",
  "requestId": "uuid-v4"
}
```

Defined error codes:
| Code                    | HTTP status | Trigger                                      |
|-------------------------|-------------|----------------------------------------------|
| `TOKEN_EXPIRED`         | 401         | JWT present but expired                      |
| `TOKEN_INVALID`         | 401         | JWT present but malformed or bad signature   |
| `RATE_LIMIT_EXCEEDED`   | 429         | Sliding window limit hit                     |
| `DOWNSTREAM_TIMEOUT`    | 504         | Proxy upstream did not respond within limit  |
| `DOWNSTREAM_ERROR`      | 502         | Proxy upstream returned 5xx                  |
| `SERVICE_NOT_FOUND`     | 404         | No downstream service matches the path       |

Never return a raw NestJS `HttpException` message to clients — always
map to the above shape via an exception filter.

---

## Dependency Rules

Allowed production dependencies (do not add others without discussion):
- `@nestjs/*` — core framework
- `ioredis` — Redis client (not `redis` npm package)
- `prom-client` — Prometheus metrics
- `http-proxy-middleware` — reverse proxy
- `jsonwebtoken` + `@types/jsonwebtoken` — JWT verification
- `joi` — config validation
- `uuid` — request ID generation

Allowed test dependencies:
- `ioredis-mock` — Redis mock for unit tests
- `nock` — HTTP mock for downstream services
- `autocannon` — load testing (CLI only, not imported in code)
- `supertest` — E2E HTTP assertions

If a new dependency is needed, state the package name, version, and
justification before installing — do not run `npm install` speculatively.