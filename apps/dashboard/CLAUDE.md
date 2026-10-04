# Dashboard — apps/dashboard

Next.js 16 app-router frontend consumed by tenants. All data fetching goes through
`src/lib/api-client.ts` which proxies to the admin-api. No direct DB or gateway
connections.

## Stack

- Next.js 16 (app router, `'use client'` for all interactive pages)
- Tailwind CSS — no component library, all classes inline
- SWR for data fetching and auto-refresh
- `lucide-react` icons only — do not add other icon packages

## Pages

| Route                    | File                                 | Purpose                                                |
| ------------------------ | ------------------------------------ | ------------------------------------------------------ |
| `/login`                 | `app/login/page.tsx`                 | Email + password auth                                  |
| `/register`              | `app/register/page.tsx`              | Tenant signup                                          |
| `/setup`                 | `app/setup/page.tsx`                 | 3-step onboarding wizard                               |
| `/dashboard`             | `app/dashboard/page.tsx`             | Metrics overview, gateway status                       |
| `/(dashboard)/services`  | `app/(dashboard)/services/page.tsx`  | Service CRUD with targets[] and health                 |
| `/(dashboard)/routes`    | `app/(dashboard)/routes/page.tsx`    | Route CRUD — three-tab panel: Basic, Advanced, Plugins |
| `/(dashboard)/consumers` | `app/(dashboard)/consumers/page.tsx` | API key consumers; group assignment for ACL plugin     |
| `/(dashboard)/logs`      | `app/(dashboard)/logs/page.tsx`      | Filterable request logs                                |
| `/(dashboard)/errors`    | `app/(dashboard)/errors/page.tsx`    | Error tracking and resolution                          |
| `/(dashboard)/settings`  | `app/(dashboard)/settings/page.tsx`  | Tenant info, API key, Docker Compose                   |

## API client (`src/lib/api-client.ts`)

Single file. All types are imported from `@api-gateway/shared-types`. All HTTP calls
go through the `request()` helper which attaches `Authorization: Bearer <token>` and
handles 401 by redirecting to `/login`.

**Change order is non-negotiable:** update `shared-types` first, then `api-client.ts`,
then the page that uses it.

## Services page

- `targets` replaces the old `targetUrl` field (array of `{url, weight}`)
- Dynamic target rows in the form: add/remove with weight input
- Edit + delete both supported
- Table shows first target URL + "+N more" for multi-target services
- Health is per-service (from `health_snapshots`), not per-target
- Service controls expose HTTP/2 upstreams, WebSocket upgrades, HTTP or native gRPC health protocol, an optional registered health service name, cadence and explicit unhealthy fallback
- Native health mode hides the HTTP path input, preserves saved settings on edit and explains the standard health RPC requirement

## Routes page

The slide-over panel fills narrow viewports and is capped at 600px, with three tabs:

**Basic tab** — method (GET/POST/PUT/PATCH/DELETE/ANY), path pattern, service, auth required,
enabled toggle, rate limit override.

**Advanced tab** — optional fields:

- Max body size (`maxBodyBytes` in bytes)
- Retry policy (`attempts`, `on` status codes, `methods`)
- CORS (`origins`, `methods`, `headers`, `credentials`, `maxAge`)
- IP restriction (`allow` and `deny` CIDR lists, one per line)

**Plugins tab** — per-route plugin pipeline (executed in listed order):

- `cors` — origins, methods, headers, credentials, maxAge
- `ip-restriction` — allow/deny CIDR lists
- `rate-limit` — maxRequests, windowMs
- `request-size-limit` — maxBytes
- `request-transform` — addHeaders (JSON), removeHeaders (comma-list), addQueryParams (JSON), removeQueryParams (comma-list)
- `response-transform` — addHeaders (JSON), removeHeaders (comma-list), statusOverride
- `basic-auth` — realm, credentials (username:password pairs, one per line; stored as SHA-256 hashes)
- `oauth2-client-credentials` — explicit inbound introspection or outbound service-token mode; endpoint, client ID and password-masked client secret; optional issuer/audience or scopes/header. Outbound mode must explain that it does not authenticate clients. Preserve original plugin order and unmodeled configurations on edit.
- `oidc` — jwksUri, issuer, audience (optional), claimsToForward (comma-sep, optional)
- `hmac-auth` — header name, algorithm (sha256/sha512), secrets (one per line for rotation), timestampHeader + maxClockSkewSeconds (optional)
- `acl` — allow/deny group lists (comma-sep); groups assigned per consumer
- `mtls` — required toggle; CA cert uploaded in Settings

Only enabled plugins are serialized to `route.plugins[]`. If no plugins are enabled, the field is omitted.

Feature badges in the routes table: Retry badge and a Plugins count badge when `plugins.length > 0`. A muted background means `enabled: false`.

## Consumers page

- Groups field in the create panel (comma-separated)
- Edit button (pencil icon) opens panel in edit mode — only groups can be changed
- Groups displayed as indigo badge chips in the table
- Groups feed the `acl` plugin on routes

## Settings page

Fetches `getTenant()` to display real tenant ID and config version.
Gateway API key is derived from `tenant.id` and can be revealed/copied.
Docker Compose template and env var reference are static.

Settings also includes `LogExportPanel`: private NDJSON exports with UTC range/status/path filters, durable job states and authenticated downloads. Keep storage credentials and object keys out of the browser. Refresh is 30 seconds; failed reads, queue submissions and downloads must show recovery feedback. The browser verifier covers disabled/enabled storage, job states, failed submissions/downloads and an actual downloaded fixture.

## Testing

- Jest with `next/jest` transformer (`jest.config.cts`)
- Specs live in `specs/` at the app root
- Run via `npm exec nx test dashboard`
- `next/navigation` must be mocked in every spec that renders a component using `useRouter` / `usePathname` / `useSearchParams`
- `IntersectionObserver` must be mocked globally (not in jsdom)
- `dir: __dirname` in `jest.config.cts` — do NOT change to `'./'`; Nx runs from workspace root so `process.cwd()` would resolve incorrectly

## Typecheck

- Runs `tsc --noEmit` via `nx:run-commands` target (defined in `package.json`)
- Run via `npm exec nx typecheck dashboard`

## Guardrails

- Never call `process.env` outside `api-client.ts` (`NEXT_PUBLIC_ADMIN_API_URL`)
- SWR `refreshInterval` is 30 000ms on all lists; do not go lower
- All forms use controlled inputs — no uncontrolled refs
- Use `WorkspaceDialog` for modal forms and one-time keys. Panels fill the viewport width up to 480px (simple forms) or 600px (routes). Preserve native Escape behavior, focus restoration, and explicit Tab wrapping.
- Associate visible labels with controls. Name icon buttons and make horizontally scrolling tables keyboard accessible.
- Use `useTenantId()` in React renders so server and initial browser snapshots agree. Use imperative session getters in the API client.
- Browser API calls default to same-origin; both API-origin settings must remain in the Nx build inputs.
- Run `dashboard:ui-smoke` after UI changes; it exercises the standalone production build with fixture APIs and axe checks. See the root README for local browser configuration.
- Never import from `apps/api` or `apps/admin-api` — only `@api-gateway/shared-types`
- Branding is **NovaGate** — never use "GatewayX" anywhere
