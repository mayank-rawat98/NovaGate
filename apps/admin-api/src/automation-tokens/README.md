# Automation tokens

Workspace automation tokens authenticate the `gwx` CLI, the Terraform provider and
CI against the admin API without a password or browser session.

## Endpoints

Only an interactive tenant session can manage tokens. A request authenticated by a
token receives 403 on all of these, whatever scopes it holds.

| Method   | Path                                       | Result                                                                |
| -------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `GET`    | `/tenants/:tenantId/automation-tokens`     | Up to 200 most recent tokens, without secrets                         |
| `POST`   | `/tenants/:tenantId/automation-tokens`     | `{ name, scopes, expiresInDays? }` → summary plus `token`, shown once |
| `DELETE` | `/tenants/:tenantId/automation-tokens/:id` | Idempotent revocation; returns the first revocation time              |

Names are 1–64 printable characters. Scopes are a nonempty distinct list from
`AUTOMATION_TOKEN_SCOPES` in shared-types. Expiry is a whole number of days from
1 to 365 (default 90). A workspace can hold 50 active (unrevoked, unexpired) tokens;
creation serializes on the workspace row, so concurrent creates cannot exceed it.

## Secrets

Tokens are `ngat_` followed by 32 random bytes in base64url. Only the SHA-256 digest
is stored. High-entropy random secrets do not need a slow password hash, and each
request verifies with one indexed lookup. The first 11 characters are stored as a
display prefix so people can recognise a token in their secret store.

## Authorization

`TenantAuthGuard` treats a bearer value starting with `ngat_` as a token. The
endpoint must declare `@AutomationScope(...)`; endpoints without it accept only
sessions (default deny), and the guard rejects them before touching the database.
Unknown, malformed, expired and revoked tokens all return the same 401. A token for
another workspace returns 403, as does a missing scope. Granting `<area>:write`
also grants `<area>:read`.

| Scope                                | Endpoints                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `workspace:read`                     | `GET /tenants/:id`                                                             |
| `routes:read` / `routes:write`       | Route list / create, update, delete                                            |
| `services:read` / `services:write`   | Service list / create, update, delete                                          |
| `consumers:read` / `consumers:write` | Consumer list / create (returns a new key once), update, revoke                |
| `config:read`                        | `GET export`, and `POST import` previews (`dryRun` absent or `true`)           |
| `config:write`                       | `POST import?dryRun=false` (complete replacement apply)                        |
| `logs:read`                          | `GET logs`, `GET logs/stream`                                                  |
| `analytics:read`                     | Health, errors, metrics, metric stream, consumer stats, gateway status, traces |
| `analytics:write`                    | `PATCH errors/:errorId`                                                        |
| `alerts:read` / `alerts:write`       | Alert configuration and history / rule create, update, delete                  |

Session-only areas: token management, gateway key rotation, the mTLS CA bundle, log
privacy, log retention, private archives, external export destinations and delivery,
and alert channels (which carry delivery credentials). `config:write` and
`consumers:write` can mint consumer gateway keys; grant them deliberately.

Last use is written at most once a minute per token. Token-authenticated SSE
streams close within 60 seconds (or at expiry) and reconnect through the guard, so
revocation reaches long-lived streams. Lookups share a bounded admission of 64
concurrent verifications; management operations admit 8. Each transaction uses
3-second statement and 1-second lock timeouts.

Tokens are removed with their workspace. Team members, per-person RBAC and
immutable audit history remain separate work.

## Verification

```sh
TEST_DATABASE_URL=postgres://… npx jest apps/admin-api/src/automation-tokens apps/admin-api/src/auth
```

The integration suite uses actual PostgreSQL and HTTP: one-time secrets and digest
storage, scope enforcement including write-implies-read and session-only endpoints,
read-scoped import previews, cross-workspace/revoked/expired/unknown rejection,
idempotent revocation, last-use throttling, validation, the concurrent active-token
limit and workspace deletion.
