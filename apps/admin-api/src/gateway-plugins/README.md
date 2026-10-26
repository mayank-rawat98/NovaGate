# Gateway plugins API

Third-party gateway plugins are npm packages pinned by the gateway operator (see
[the plugin SDK guide](../../../../libs/plugin-sdk/README.md)). The admin API
stores their route configuration, shows what the gateway reported and holds the
workspace kill switch.

| Method | Path                                 | Auth                              | Purpose                                   |
| ------ | ------------------------------------ | --------------------------------- | ----------------------------------------- |
| `GET`  | `/tenants/:tenantId/gateway-plugins` | session or `workspace:read` token | Last gateway report and the disabled list |
| `PUT`  | `/tenants/:tenantId/gateway-plugins` | session only                      | Replace the disabled list                 |

`GET` returns `GatewayPluginState`: `reportedAt` and `plugins` come from the
control plane's `gw:plugins:<tenant>` Redis entry (180 s TTL, refreshed by the
gateway every 60 s), re-validated with `parsePluginStatuses`. A missing,
expired, corrupt or unreachable report reads as `{ reportedAt: null, plugins: [] }`.

`PUT` takes exactly `{ "disabled": ["@scope/name", ...] }`: at most 16 unique
scoped names. The sorted list is saved in `public.tenants."disabledPlugins"` and,
when it changed, published as a new configuration version through the durable
`pending_config_updates` outbox in the same transaction. Saving the same set is
a no-op. Both the published snapshot and the control plane's `auth_ok`
snapshot carry `disabledPlugins`.

Routes accept scoped third-party plugin names alongside the built-in ones (up
to 32 plugins per route). Third-party configuration must be a JSON object of at
most 16 KiB; its contents belong to the plugin and are not interpreted here.
Declarative import/export round-trips them unchanged. The developer portal flags
routes that use them (`customPolicies`) instead of guessing their requirements.

Verification: `gateway-plugins.integration.spec.ts` (real PostgreSQL, Redis and
HTTP; set `TEST_DATABASE_URL` and `TEST_REDIS_URL`).
