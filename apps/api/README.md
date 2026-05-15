# API Gateway (NestJS)

## Architecture

```
Client
  |
  v
API Gateway (NestJS)
  - JwtMiddleware
  - RateLimitGuard (Redis sliding window)
  - LoggingInterceptor
  - ProxyMiddleware
  - Metrics (/metrics)
  - Health (/health)
  |
  +--> Redis (rate limit storage)
  |
  +--> Downstream services (users/products)
```

## Run locally

### Option 1: Docker Compose (gateway + Redis + mock downstream)

```sh
docker compose up --build
```

The mock downstream exposes:

- `http://localhost:3001/users`
- `http://localhost:3001/products`

The gateway proxies:

- `http://localhost:3000/users`
- `http://localhost:3000/products`

### Option 2: Run with Node + Nx

```sh
npm install
cp .env.example .env
```

Set `PROXY_SERVICES` to point at the local downstream:

```sh
export PROXY_SERVICES='[{"name":"users","targetUrl":"http://localhost:3001","pathPrefix":"/users"},{"name":"products","targetUrl":"http://localhost:3001","pathPrefix":"/products"}]'
```

Then build and run:

```sh
npm exec nx build @api-gateway/api
node apps/apps/api/dist/main.js
```

## Load test

```sh
autocannon -c 50 -d 10 http://localhost:3000/users
```

## Environment variables

| Variable                | Description                                     | Default    |
| ----------------------- | ----------------------------------------------- | ---------- |
| `PORT`                  | Gateway port                                    | `3000`     |
| `REDIS_URL`             | Redis connection URL                            | _required_ |
| `JWT_SECRET`            | JWT verification secret (min 32 chars)          | _required_ |
| `PROXY_TIMEOUT_MS`      | Downstream timeout in ms                        | `10000`    |
| `PROXY_SERVICES`        | JSON array of `{ name, targetUrl, pathPrefix }` | `[]`       |
| `RATE_LIMIT_WINDOW_MS`  | Sliding window size in ms                       | `60000`    |
| `RATE_LIMIT_UNAUTH_MAX` | Max requests per window (unauth)                | `100`      |
| `RATE_LIMIT_AUTH_MAX`   | Max requests per window (auth)                  | `500`      |
