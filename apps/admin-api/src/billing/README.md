# Quotas, plans and billing (issue #119)

Roadmap 6.4. Requests are metered on the gateway, which customers run, so the
SaaS servers never see request traffic.

## Metering

The gateway counts every proxied request in its own Redis, after
authentication and before the upstream (CORS preflights are not counted). The
keys are in [REDIS_KEY_DESIGN.md](../../../../REDIS_KEY_DESIGN.md):

- one counter per UTC month for the workspace;
- one per identified consumer, plus a set of the consumers counted that month;
- `meter:source`, a random ID for this Redis.

Counters are cumulative. Every 30 seconds, and after each `auth_ok`, the gateway
sends one transient `usage.report` frame per month (the current month and,
until it expires, the previous one) with the totals and up to 1000 consumers.
The control plane validates each report (`parseUsageReport`). It keeps the
largest value per (workspace, month, source) in `public.usage_meters` and
`public.consumer_usage_meters`.

Because reports carry totals, a dropped, repeated or reordered report never
changes the result. The next report repairs it. Gateways sharing one Redis
share a source; gateways with separate Redis instances are summed.

Redis failures fail open: the request is admitted, uncounted, and
`gateway_metering_redis_errors_total` increases. Refusals count in
`gateway_quota_rejections_total{scope="consumer"|"workspace"}`.

## Quotas

- **Consumer quota:** `consumers."monthlyQuota"` (1 to 2,000,000,000, or null).
  It is set through the consumers API, declarative config (`monthlyQuota`,
  absent or null means none) or the Consumers page. The gateway enforces it
  atomically in a Lua script that refuses without counting. A consumer at its
  quota gets `429 QUOTA_EXCEEDED` with `Retry-After`, `X-Quota-Limit`,
  `X-Quota-Remaining: 0` and `X-Quota-Reset`. WebSocket upgrades get 429 and
  gRPC gets `RESOURCE_EXHAUSTED`. Consumer quotas are always enforced, because
  the workspace owner sets them.
- **Workspace plan:** `public.plans` rows set `requestsPerMonth`,
  `consumersMax`, `routesMax` and `logRetentionDays`; null means unlimited.
  Free, Pro and Enterprise are seeded, and operators edit the rows. A workspace
  with an unknown `planId` gets the free plan's limits.

Plan limits are enforced only when `BILLING_QUOTAS_ENABLED=true`. Otherwise the
Billing page shows them as informational.

When limits are enforced:

- A worker on the admin API (`BILLING_ENFORCEMENT_INTERVAL_MS`, default 60000)
  suspends a workspace whose summed usage reaches `requestsPerMonth`. It sets
  `tenants."quotaSuspendedUntil"` to the next UTC month start and pushes
  configuration with `suspended`.
- While suspended, the gateway answers every route with `429 QUOTA_EXCEEDED`
  and a `Retry-After` until the reset, without counting.
- The worker clears the suspension at the reset, after an upgrade, or when
  enforcement is turned off. The gateway also ignores an expired suspension on
  its own, so the reset needs no push.
- Usage reaches the admin API within about 30 seconds, plus the worker
  interval, so a workspace can overshoot its plan by that much traffic.
- Creating consumers (dashboard, API, declarative import, developer-portal
  keys) or routes past the plan's cap returns `402 PLAN_LIMIT`. A downgraded
  workspace keeps what it has; only growth is refused. Log retention cannot be
  set above the plan's `logRetentionDays`.

## Stripe

Stripe is optional. With `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
`STRIPE_PRICES` (JSON `{"pro":"price_..."}`), the Billing page offers
self-service upgrades.

- `POST /api/tenants/:id/billing/checkout {planId}` is session-only. It creates
  a Stripe Checkout subscription session with `metadata[tenantId]` and
  `metadata[planId]`, then returns its URL.
- Stripe calls `POST /api/billing/stripe/webhook`. It needs no session: the
  `Stripe-Signature` (HMAC-SHA256 over the raw body, 300-second tolerance) is
  the authentication.
- Each event ID is applied once (`public.stripe_events`).
- `checkout.session.completed` sets the plan and lifts a suspension in the same
  transaction as the configuration push. So does
  `customer.subscription.updated` with an active price.
- Cancellation (`customer.subscription.deleted`, or an `unpaid`/`canceled`
  status) returns the workspace to the free plan.
- The checkout redirect itself never changes the plan.

`STRIPE_API_BASE` (default `https://api.stripe.com`) must be HTTPS except on
localhost, which the tests use. `DASHBOARD_URL` sets the return links.
Subscription events are applied in arrival order. Stripe does not guarantee
ordering, so a stale `subscription.updated` arriving last could restore an
older price; a later event corrects it.

## API

| Method | Path                                       | Scope            |
| ------ | ------------------------------------------ | ---------------- |
| GET    | `/api/tenants/:id/billing`                 | `workspace:read` |
| GET    | `/api/tenants/:id/billing/consumer-quotas` | `consumers:read` |
| POST   | `/api/tenants/:id/billing/checkout`        | session only     |
| POST   | `/api/billing/stripe/webhook`              | Stripe signature |

## Verification

- `billing.integration.spec.ts` (PostgreSQL, Redis, HTTP, fake Stripe) covers
  overview, summed meters, consumer quotas, concurrent cap enforcement, route
  and retention caps, suspension and stability, signed and unsigned webhooks,
  idempotency, cancellation, monthly reset, checkout form fields and turning
  enforcement off.
- The control-plane integration spec covers keeping the largest total, invalid
  reports and suspensions in `auth_ok`.
- The gateway specs cover the Lua admission and fail-open path, and quotas and
  suspension through the real proxy.
- `npm exec nx run @api-gateway/api:billing-e2e` runs the built admin API,
  control plane and gateway. It checks a consumer 429, workspace suspension
  with a 12-request plan, and an upgrade through a signed webhook that resumes
  traffic.
