# @api-gateway/shared-types

Single source of truth for all TypeScript interfaces shared across the monorepo.
**Change order is non-negotiable:** update this library first, then the sender, then the receiver.

This private workspace package exports TypeScript source for both server and browser
bundlers. Relative imports use the actual `.ts` filenames so Turbopack, Webpack,
and Jest resolve the same files. The base TypeScript configuration enables
`allowImportingTsExtensions`; TypeScript emits declarations only (or checks without
emitting), while application bundlers produce runnable JavaScript.

Issue #65 adds alert rule/channel/event contracts in `src/lib/alerts.ts`. Rule
limits and metric/operator names are shared between admin and dashboard. Channel
read responses contain display-safe destinations and secret-presence flags; full
webhook URLs and signing credentials are write-only. Rule updates carry a revision,
evaluation distinguishes missing evidence from healthy/violating windows, and
delivery history retains meaningful terminal/retry/cancellation states.

## Key types

### `TenantConfig`

The full configuration pushed from the control plane to the gateway.

```typescript
interface TenantConfig {
  routes: RouteConfig[];
  services: ServiceConfig[];
  consumers: ConsumerConfig[];
  rateLimit: { windowMs: number; unauthMax: number; authMax: number };
}
```

### `ServiceConfig`

Represents a downstream service with one or more load-balanced targets.

```typescript
interface ServiceConfig {
  id: string;
  name: string;
  targets: ServiceTarget[]; // one entry = single target; multiple = load balanced
  healthCheckPath: string;
  timeoutMs: number;
}

interface ServiceTarget {
  url: string;
  weight: number; // 1–100; equal weights = even distribution
}
```

### `RouteConfig`

An HTTP route with optional Phase 0 features.

```typescript
interface RouteConfig {
  id: string;
  method: string; // HTTP verb or 'ANY'
  pathPattern: string; // prefix match, e.g. '/api/users'
  serviceId: string;
  authRequired: boolean;
  rateLimitOverride?: number;
  enabled: boolean;

  // Phase 0 — Load balancing & resilience
  retry?: {
    attempts: number; // number of retries (total attempts = attempts + 1)
    on: number[]; // HTTP status codes to retry on, e.g. [502, 503, 504]
    methods: string[]; // HTTP methods to retry, e.g. ['GET', 'HEAD', 'OPTIONS']
  };

  // Phase 0 — Request size limiting
  maxBodyBytes?: number;

  // Phase 0 — CORS
  cors?: {
    origins: string[]; // ['*'] or specific domains
    methods?: string[];
    headers?: string[]; // extra allowed request headers
    credentials?: boolean;
    maxAge?: number; // preflight cache seconds, default 86400
  };

  // Phase 0 — IP restriction
  ipRestriction?: {
    allow?: string[]; // CIDR notation, e.g. ['10.0.0.0/8']
    deny?: string[]; // deny takes precedence over allow
  };
}
```

### WebSocket message types

All messages exchanged between the gateway and control plane. See `ws-messages.ts` for the full union type and each message payload.

Key flow:

1. Gateway sends `auth` → receives `auth_ok` with initial `TenantConfig`
2. Control plane pushes `config.update` → gateway replies `config.ack`
3. Gateway sends batched `logs`, `health`, `metrics`; sends immediate `errors` (require `ack`)

### Entity types (`entities.ts`)

DB row shapes used by the dashboard API client and admin-api. These are **not** the same as config types — they represent what is stored in PostgreSQL, not what is sent to the gateway.

| Entity                      | Notes                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `TenantEntity`              | Top-level tenant record                                                                                                |
| `RouteEntity`               | Route row in `tenant_<id>.routes`; includes Phase 0 optional fields (`retry`, `cors`, `ipRestriction`, `maxBodyBytes`) |
| `ServiceEntity`             | Service row in `tenant_<id>.services`; `targets` is JSONB array of `{url, weight}`                                     |
| `ConsumerEntity`            | Consumer row in `tenant_<id>.consumers`                                                                                |
| `ApiKeyEntity`              | API key in `public.api_keys`                                                                                           |
| `PendingConfigUpdateEntity` | Queued update for offline gateways                                                                                     |

`RouteEntity` Phase 0 fields mirror `RouteConfig` exactly — the dashboard sends these to the admin-api which stores them as JSONB; the admin-api assembles them into `TenantConfig` and pushes to the gateway unchanged.
