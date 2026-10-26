# Developer portal — apps/developer-portal

Next.js 16 app router site where a workspace's API consumers ("developers")
browse published routes, create their own gateway keys and read their usage. It
is separate from `apps/dashboard` (workspace operators) and calls only the
public `/api/portal/*` admin endpoints described in
[the portal API contract](../admin-api/src/portal/README.md).

## Hosting

- Shared host: `/w/:tenantId/...` (for example `portal.novagate.dev/w/<id>`).
  Hosts in `PORTAL_SHARED_HOSTS` (default `localhost,127.0.0.1`) are served
  this way.
- Custom domain: any other host is resolved through `GET /api/portal/resolve`
  (cached 60 s; misses 30 s; transient failures not cached). `src/proxy.ts`
  rewrites `/x` to `/w/<tenant>/x` and sets `x-novagate-portal-mode: domain`
  (client-supplied values are removed). The tenant layout then builds
  root-relative links. `/w/*` paths are refused on custom domains, so a domain
  never exposes another workspace.
- `next.config.js` sets `skipProxyUrlNormalize: true`. Without it Next gives the
  proxy a `localhost` URL that differs from the bound `HOSTNAME` (`0.0.0.0` in
  containers), and every rewrite becomes an HTTP self-proxy that drops the
  original `Host`.
- Only `/api/portal/:path*` is rewritten to `ADMIN_API_URL`. Rewrites are fixed
  at build time; the domain proxy reads `ADMIN_API_URL` at runtime.

## Pages

| Route                                       | Purpose                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/w/[tenant]`                               | Catalog: method, path, summary, auth methods, enforced rate limit                       |
| `/w/[tenant]/docs/[routeId]`                | Plain-text docs, auth/limit details, curl example using the workspace's gateway address |
| `/w/[tenant]/register`, `/verify`, `/login` | Developer accounts; verification tokens are submitted once                              |
| `/w/[tenant]/keys`                          | Create (shown once), list and revoke own keys                                           |
| `/w/[tenant]/usage`                         | Per-key recorded requests, errors, p95, interval table and top paths                    |

## Guardrails

- Never render route descriptions as HTML; they are plain text (`whitespace-pre-wrap`).
- Developer sessions live in `localStorage` under
  `novagate.portal.session.<tenant>` and are dropped at expiry or on any 401.
  Gateway keys stay only in component memory.
- `useSessionToken` returns `null` on the server and the first client render, so
  hydration matches.
- Strict CSP: same-origin resources only, no framing, `no-referrer`. Inline
  scripts are allowed because app-router hydration needs them.
- Native `<dialog>` modals, visible labels, keyboard-scrollable tables, axe WCAG
  A/AA clean on desktop and mobile; usage is labelled as recorded logs, not
  billing.
- Import only from `@api-gateway/shared-types`, never from other apps.

## Verification

```sh
npm exec nx run-many -t lint typecheck test -p developer-portal
npm exec nx run developer-portal:ui-smoke     # production build + Chromium + axe
npm exec nx run developer-portal:gateway-e2e  # real admin-api, control-plane, gateway, portal
```

`ui-smoke` starts the standalone server against a stateful fixture admin API. It
covers the catalog, docs, registration and verification, keys, usage, sign-in,
custom domains (via Chromium host mapping), security headers and mobile layout.
`gateway-e2e` needs PostgreSQL (`E2E_DATABASE_URL`) and Redis (`E2E_REDIS_URL`).
It registers through the real portal, creates a key, calls the real gateway,
waits for the recorded usage, then revokes the key and checks that the gateway
refuses it.
