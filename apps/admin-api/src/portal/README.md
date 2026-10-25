# Developer portal API

A workspace publishes selected routes to its own API consumers ("developers").
Developers register, confirm their email, create gateway keys for themselves and
read their own recorded usage. They never receive any workspace access.

## Data

- `public.portal_settings`: per workspace. Holds `enabled`, `title`, a unique
  lowercase `custom_domain`, an `https` `api_base_url` used in examples,
  open/closed `signup`, `default_groups` for new keys, `max_keys_per_developer`
  (1–25) and a `revision`. Missing rows read as disabled defaults with the zero
  revision.
- `tenant_<id>.portal_developers`: email (unique, case-insensitive), name, bcrypt
  password hash (cost 10), `pending`/`active`/`suspended` status,
  `session_version`, a SHA-256 digest of the email-verification token (24 hours),
  and failed sign-in counters with lockout.
- `tenant_<id>.consumers` gains `portalDeveloperId` and `portalKeyName`. A
  developer key is an ordinary consumer, so the gateway authenticates it as
  `Authorization: Bearer gw_…` with no gateway changes. Both columns are
  stripped from gateway payloads.
- `tenant_<id>.routes.portal` holds `{ visible, summary?, description? }`.
  Summary is at most 160 characters on one line; description is plain text, at
  most 4000 characters. The column is stripped from gateway payloads.

## Workspace endpoints (tenant session only)

| Method      | Path                                       | Notes                                                                                                                 |
| ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET`/`PUT` | `/tenants/:tenantId/portal-settings`       | `PUT` takes every field plus `expectedRevision`; stale revisions get 409; a domain used by another workspace gets 409 |
| `GET`       | `/tenants/:tenantId/portal/routes`         | Catalog preview, even while unpublished                                                                               |
| `GET`       | `/tenants/:tenantId/portal/developers`     | Up to 500 developers with active key counts; no hashes                                                                |
| `PUT`       | `/tenants/:tenantId/portal/developers/:id` | `{ status: 'active' \| 'suspended' }`                                                                                 |

Suspension bumps `session_version` (ending sessions) and revokes every active key
of that developer in the same transaction as the gateway outbox write.
Activation restores sign-in only. It also confirms a pending account without
email verification. Routes are published through the existing route
create/update endpoints and through declarative import (`portal` on each route).

## Public endpoints

`TenantAuthGuard` skips controllers under `portal`. Developer endpoints use
`PortalDeveloperGuard`.

| Method       | Path                                                        | Notes                                                          |
| ------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `GET`        | `/portal/resolve?host=`                                     | Enabled custom domain → `{ tenantId }`, else 404               |
| `GET`        | `/portal/:tenantId/catalog`                                 | 404 unless enabled; cacheable for 30 s                         |
| `GET`        | `/portal/:tenantId/catalog/:routeId`                        | One published route                                            |
| `POST`       | `/portal/:tenantId/developers/register`                     | `{ email, name, password }` → always 202 with the same message |
| `POST`       | `/portal/:tenantId/developers/verify`                       | `{ token }` → session                                          |
| `POST`       | `/portal/:tenantId/developers/login`                        | `{ email, password }` → session                                |
| `GET`        | `/portal/:tenantId/me`                                      | Profile                                                        |
| `GET`/`POST` | `/portal/:tenantId/me/keys`                                 | List own keys / `{ name }` → key with `apiKey`, shown once     |
| `DELETE`     | `/portal/:tenantId/me/keys/:keyId`                          | Idempotent revocation                                          |
| `GET`        | `/portal/:tenantId/me/keys/:keyId/usage?period=1h\|24h\|7d` | Recorded-log usage for an owned key                            |

The catalog lists enabled, undeleted routes whose `portal.visible` is true, in
configuration order (at most 500). Each entry shows only method, path, summary,
description, authentication methods and the enforced rate limit. Methods come
from the route's policy: `authRequired` means a gateway API key, plus `basic`,
`oidc`, `hmac`, `mtls`, and `oauth2` (introspection mode only; outbound
client-credentials authenticates the gateway, not callers). The rate limit is
the `rate-limit` plugin's `max` and `windowMs`, or else `rateLimitOverride` over
the default 60-second gateway window. `groupRestricted` flags an `acl` plugin.
Upstream services, targets and plugin configuration are never included.

## Security

- **Sessions.** Developer sessions are HS256 JWTs signed with
  `HMAC-SHA256(PLATFORM_JWT_SECRET, "novagate-portal-developer-session-v1")`.
  They carry audience `novagate-portal`, subject = developer, `tid` = workspace
  and `ver` = session version, and last 12 hours. Every request re-reads the
  developer row and requires an enabled portal. A workspace session is never
  accepted for developer endpoints, and a developer session is never accepted
  for workspace endpoints.
- **Registration.** Enumeration-safe. Existing active or suspended addresses get
  the same 202 and no email. A pending address gets a fresh link, and its new
  password replaces the old one. Closed signup returns 403, and at most 10,000
  developers exist per workspace. Passwords are 10 characters to 72 bytes
  (bcrypt's limit; longer input is refused rather than truncated).
- **Sign-in.** Unknown accounts are compared against a fixed bcrypt hash, so
  timing does not reveal them. Ten consecutive failures lock the account for
  15 minutes; locked and wrong-password attempts return the same 401. At most
  8 bcrypt operations run concurrently.
- **Verification emails** link to `https://<customDomain>/verify?token=…`, or
  `${PORTAL_URL}/w/<tenantId>/verify?token=…` (default
  `http://localhost:3004`). The workspace-chosen title is HTML-escaped. A failed
  send is logged; registering again resends the link.
- **Keys.** Creating a key locks the developer row and enforces the workspace
  limit. The key gets the workspace's default groups and is written with the
  durable gateway outbox in one transaction.
- **Declarative config.** Import/export ignores developer-owned consumers, so a
  complete-replacement apply never revokes developer keys. Route `portal`
  metadata round-trips, and removing it shows as a `portal` field change in
  the preview.

Unpublishing the portal hides the catalog and ends developer sessions. Existing
developer keys keep working at the gateway until revoked or the developer is
suspended. Usage figures come from retained request logs under the workspace's
privacy and retention policies; they are not billing records.

## Verification

```sh
TEST_DATABASE_URL=postgres://… npx jest apps/admin-api/src/portal
```

The integration suite runs on actual PostgreSQL and HTTP. It covers settings
revisions, validation and unique domains; catalog projection and leaks;
registration, verification, enumeration-safe responses and lockout;
session/audience isolation; key limits, isolation, revocation and gateway
payloads; usage; suspension; and declarative round trips.
`developer-portal:gateway-e2e` runs the full journey against real processes.
