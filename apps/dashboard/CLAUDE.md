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
- `hmac-auth` — explicit GitHub/generic or Stripe format, signature header, algorithm (Stripe fixed SHA-256), rotation secrets, signed custom timestamp and freshness window. Explain body-only replay limitations and handler event-ID deduplication; preserve format on edit.
- `acl` — allow/deny group lists (comma-sep); groups assigned per consumer
- `mtls` — require a verified TLS client certificate; public CA trust bundle uploaded in Settings. Explain native listener/operator setup and explicit proxy trust. Save failure preserves input; blank input cannot remove trust, and removal uses a named explicit control.

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

GraphQL editing reads legacy route policy and explicit plugin configuration, displays their effective bounds, and saves one `graphql-guard` plugin with `graphql: null` to clear the legacy column. Always send `plugins: []` when all plugins are disabled. Preserve saved plugin order and expose depth, complexity and introspection controls with visible labels.

Service editing persists `loadBalancing` through the typed API client. Legacy services default to weighted round robin; least connections uses weighted active upstream work per gateway, including long-lived gRPC and WebSocket tunnels. Preserve the visible selector label and explanatory text. Browser verification saves both policies, reloads/reopens the form, and checks failed saves retain the selection.

Issue #61 adds `/traces`: sampled trace search by bounded time preset, exact trace/request IDs, route and error outcome; keyset pagination; an inline span waterfall with accessible timing text, span attributes and partial/truncated feedback. Refresh at 30 seconds. Use the shared trace responses through api-client, keep workspace identity in SWR keys, and allow log-to-trace links without exposing storage details. Browser verification must cover filter submission, pagination, detail, errors, empty results and mobile accessibility.

Issue #63 adds `src/lib/use-live-metrics.ts`. Load bounded metric history once per stream connection and use authenticated fetch-based SSE through api-client. Keep parsing/frame/history bounds, cancel fetches on workspace changes or unmount, and use bounded reconnect backoff with manual retry. Retain same-workspace samples during reconnect and mark stale data; clear cross-workspace samples synchronously in render. Percentiles are fixed histogram upper estimates for HTTP completions. Unrelated SWR resource lists retain 30-second refresh. Verify streaming, reconnect, malformed/oversized input, cancellation and desktop/mobile accessibility.

Issue #65 adds `/alerts` through shared alert contracts and api-client. Expose rule
conditions in percent/ms/RPS, request minimums, channel selection and history-only
rules. Channel reads contain only origin/recipient; metadata writes omit credentials
and replacement requires an explicit complete same-type credential write. Keep
secrets masked, retain input on failures and remount workspace state by tenant ID
to clear unsaved secrets during switches. Distinguish paused, stale, no-data, firing
and healthy states; no-data preserves the last notified state. Show actual cooldown
deadlines, operator delivery availability, delivery attempts and accepted-versus-inbox
semantics. The browser verifier covers real forms/revision errors, capacity limits,
secret replacement, workspace changes, keyboard navigation and mobile accessibility.

Issue #72 adds Automatic log archives to Settings through shared schedule contracts
and api-client. Expose minute/hour cadence, receipt-time semantics, start-from-save,
status/literal-prefix/consumer filters, pause/resume without cursor reset, revision
conflicts, backlog/failure counts and retained-history removal confirmation. Failed
unexpired jobs can retry the same immutable window/filter; show requested retry
count. Keep receipt metadata and storage credentials out of browser records. Native
dialogs and workspace-keyed state cancel mutations when closed/switched; SWR lists
stay at 30 seconds. The production browser verifier covers failed saves/revisions,
input preservation, pause/resume, backlog, removal focus/Escape, job retry and
disabled storage with desktop/mobile accessibility checks.

Issue #74 adds ConsumerUsagePanel through shared consumer usage contracts and
api-client. Hour/day/week presets report recorded-log counts, window-average RPS,
server errors, interpolated latency and top paths. Keep missing latency distinct
from zero, small nonzero rates visible, stale data labelled and workspace selection
cleared on remount. Use the native dialog, keyboard interval inspection and
30-second refresh; cancel admitted fetches on unmount. Browser checks must retain
consumer CRUD/one-time keys and cover retry, empty/stale, mobile/desktop, focus and
workspace changes. Do not present recorded-log figures as billing accounting.

Issue #78 adds Settings → Log privacy through shared policy/revision contracts and
api-client. Default IP/user-agent omission must remain explicit; show irreversible
historical cleanup, retained-field limits, gateway confirmation and archive recreation.
Use workspace-keyed state and abort admitted mutations on close/switch. Preserve inputs
on failures and revision reload; invalidate archive views after a changed save. Retain
30-second SWR refresh, native focus/Escape/Tab behavior and labelled selects. Browser
checks cover failed reads/saves/revisions, workspace resets, disabled object storage,
mobile/desktop accessibility and keyboard controls. Broader field sanitization and
raw-log age retention are not implemented by this panel.
