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
| `/(dashboard)/billing`   | `app/(dashboard)/billing/page.tsx`   | Plan & usage: meters, suspension, Stripe upgrade       |

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

Usage windows above the raw bound use consumer rollups. Label histogram percentile
upper bounds, retained-observation coverage, late counts, historical backfill and
capacity pressure. UTC chart edges expose actual observed seconds. Preserve prior
same-workspace data on failed refreshes and clear it on workspace changes. High-volume
path groups expose the global top ten and total normalized group count, independent
backfill/capacity coverage and labelled latency upper estimates. Privacy omission
projects group names before publication. Preserve explicit legacy unavailable
responses; do not describe those as zero recorded paths.
The typed filtered-metrics REST contract retains consumerUsage source, sample count,
interval duration and coverage alongside legacy numeric latency fields.

## Settings page

Fetches `getTenant()` to display real tenant ID and config version.
Gateway API key is derived from `tenant.id` and can be revealed/copied.
Docker Compose template and env var reference are static.

Settings also includes `LogExportPanel`: private NDJSON exports with UTC range/status/path filters, durable job states and authenticated downloads. Keep storage credentials and object keys out of the browser. Refresh is 30 seconds; failed reads, queue submissions and downloads must show recovery feedback. The browser verifier covers disabled/enabled storage, job states, failed submissions/downloads and an actual downloaded fixture.

`ConfigImportPanel` downloads YAML and opens a workspace-keyed native dialog for
file/editor input, preview and explicitly reviewed apply. Keep the opaque revision
bound to unchanged editor content; editing or a conflict requires another preview.
Label removal/revocation and queued gateway delivery accurately. Newly created
consumer keys return once and stay only in component memory. Closing or changing
workspaces clears documents/keys and cancels browser work; cancellation does not
undo an admitted import. Preserve the full-height opaque drawer, internal scroll,
native Escape, explicit opener focus restoration and Tab containment. The
production verifier checks download, failure/retry, revision conflict, file input,
one-time keys, mobile contrast and interrupted preview without weakening gates.

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
mobile/desktop accessibility and keyboard controls. Issue #84 adds six stored-metadata selections; arbitrary payload sanitization remains
separate. Raw-log age retention is handled by issue #80.

Issue #80 adds Settings → Log retention through shared retention/coverage/revision
contracts and api-client. Default database request-log lifetime is 30 days, selectable
1–90. Explain receipt-time aging, irreversible expiry, separate archive download TTL,
cleanup retry/pending state and windows outside retained coverage. Preserve selection
on save/revision failures, remount workspace state, cancel admitted mutations on close
or switch and retain 30-second SWR. Use native dialog focus/Escape/Tab behavior and a
labelled bounded numeric input. Browser verification covers mobile/desktop, failed
reads/saves/revisions, workspace resets, disabled object storage and archive/usage
coverage. Recorded-log analytics and archives must not promise complete traffic history.

Issue #84 extends Log privacy with controlled, labelled selections for paths,
service names, request/consumer/trace/span IDs. Preserve checkbox input on failed
saves and revision reload; closing discards unsaved selections. Explain irreversible
metadata erasure and its effect on path filters and consumer attribution. Usage
coverage must distinguish unavailable attribution from no traffic and redacted path
groups from missing totals. Keep shared contracts → typed api-client → UI, legacy
optional coverage, workspace cancellation and mobile/keyboard/accessibility checks.

Issue #91 adds Settings → External export destinations through the existing shared
contracts and typed api-client. Show stored S3-compatible/webhook/Datadog drafts
as **not sending**, never as connected or active. Provider configuration, read-safe
summaries and installation availability are independent of private RustFS archives.
Use complete same-provider credential replacement, metadata-only rename, revision
reload that keeps typed input, removal and saved-credential re-encryption. Mask
all secret fields and the webhook URL; saved connection details are never returned
or prefilled. State remounts per workspace, admitted reads/writes have deadlines,
and closing/switching cancels browser transport without promising server rollback.
Keep 30-second SWR refresh, native Escape/Tab behavior and explicit focus restoration
following successful writes, including a logical target after removal. Production
browser checks cover all providers, failed reads/writes, stale revisions, retained
input, unavailable keys/configuration, capacity, interrupted writes, workspace resets,
mobile/desktop accessibility and absence of secrets in browser persistence/summaries.

Issue #95's local continuation adds Delivery & history to those destination cards.
Saving credentials keeps an unscheduled destination in draft state; only the explicit
delivery form can enable automatic receipt scheduling. Show enabled/paused as saved
configuration, never provider health or indexing. Expose cadence, status/prefix/consumer
filters, stricter payload omissions, queue/source counters and metadata-only history
with exact decimal workspace compaction coverage. Explain save-time start, retained
resume cursor, queued completion during pause, policy-change revocation, schedule
removal and external copies that cannot be recalled. Pause/removal work without keys.
Keep both revisions, controlled input on failures/reload, workspace-keyed state and
abort reads/writes on close/switch without promising server rollback. Production
browser verification covers all providers' explicit activation, pause/resume,
removal/recreation, read/write failures, stale revisions, unavailable credentials,
exact large coverage counts, interrupted writes, focus/Escape/Tab and mobile/desktop
accessibility. No arbitrary source/payload enqueue is exposed by this UI.

Issue #107 adds Settings → Automation tokens through shared token contracts and
api-client. Create tokens with labelled scope checkboxes and a 1–365 day expiry.
Show the `ngat_` secret once in a native dialog (never persisted), list
prefix/scopes/expiry/last use/status, and confirm revocation. Tokens never manage
tokens; say so in the panel. Restore focus to the opener after creation and to
the list after revocation.

Issue #109 adds Settings → Developer portal (publish, title, custom domain,
gateway address for examples, open/closed signup, default key groups, keys per
developer, developer suspension/activation with revocation counts) and a
Developer portal section in the route editor's Advanced tab (publish toggle,
one-line summary, plain-text description). The route DTO always sends `portal`
(`null` when unpublished and empty). `NEXT_PUBLIC_PORTAL_URL` (build input)
gives the shared portal host. Scroll containers holding tables with
screen-reader-only text must be `relative`, and tables inside the flex main
column must not set a minimum width; either escapes and widens mobile pages.

Issue #117 adds the overview anomaly feed (`AnomalyFeed`: the latest five
anomalies with Active/Resolved state, summary, z-score and links to Logs and
Traces prefilled through `?path=&from=&to=` and `?route=`, which those pages read
after mount) and Alerts → Anomaly detection (`AnomalySettingsPanel`: enabled,
z-score sensitivity, minimum requests and up to five channels, revision-checked
with reload that keeps edits). Alert history shows an anomaly event's summary.

Issue #115 adds circuit breakers to Services: a live Circuit column
(`useLiveCircuits`: one REST snapshot, then the authenticated SSE stream with
bounded reconnect; state keyed by workspace) showing Closed, Probing, Open, Off
or No report (an enabled breaker the gateway has not reported is never shown
as healthy), and a Circuit breaker fieldset in the service form. New services
default to the breaker; services without one start unchecked. Settings are saved
even when turned off, and out-of-range values are refused before saving.

Issue #113 adds Settings → Gateway plugins (the gateway's last third-party plugin
report, state badges, one-line last errors, and a confirmed per-plugin
disable/enable that keeps unreported disabled names reversible) and a
Third-party plugins section at the end of the route editor's Plugins tab. Custom
entries are a scoped package name plus a JSON object; invalid names, duplicates,
invalid JSON and oversized configuration are rejected before the request. Edited
entries keep their saved position; new ones are appended.

Issue #119 adds Plan & usage (`/billing`): request/consumer/route meters and log
retention against the plan, an 80% warning and a 98% critical banner, a paused
banner with the UTC reset date while the workspace is suspended, and plan cards
whose upgrade button sends the browser to the Stripe Checkout URL from
`startCheckout` (session only; the webhook, not the redirect, changes the
plan). `?checkout=` is read after mount. Limits are labelled informational when
the installation does not enforce them. The Consumers page adds a This month
column (`getConsumerQuotas`: usage against each consumer's monthly quota, a
labelled meter, an "Almost exhausted" warning at 98%) and a bounded Monthly
request quota input; blank means no quota. `402 PLAN_LIMIT` messages are shown
as returned.

Issue #121 adds Settings → Control plane regions (`ControlPlaneRegionsPanel`):
every gateway instance any region recorded, with its region, Connected/Offline
(no heartbeat for 2 minutes) and configuration version, flagged "Behind" when it
trails the workspace version; and, when the installation lists two or more
regions, a labelled Preferred region select saved through `savePreferredRegion`
(session only), keeping the choice on failure.
