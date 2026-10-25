# NovaGate Terraform provider

Manage NovaGate services, routes, consumers and alert rules as code. The provider
is built on the Terraform Plugin Framework and calls the same admin API endpoints
as the dashboard and `gwx`.

## Authentication

Create a workspace automation token in Settings → Automation tokens or with
`gwx tokens create`, granting only the scopes your configuration needs:

| Object                   | Scope             |
| ------------------------ | ----------------- |
| `novagate_service`       | `services:write`  |
| `novagate_route`         | `routes:write`    |
| `novagate_consumer`      | `consumers:write` |
| `novagate_alert_rule`    | `alerts:write`    |
| `data.novagate_tenant`   | `workspace:read`  |
| `data.novagate_consumer` | `consumers:read`  |

```hcl
provider "novagate" {
  api_url   = "https://admin.example.com/api" # or NOVAGATE_API_URL
  tenant_id = "…workspace UUID…"             # or NOVAGATE_TENANT_ID
  token     = var.novagate_token             # or NOVAGATE_API_TOKEN (sensitive)
}
```

HTTPS is required except for loopback development servers. Redirects are never
followed, so the token cannot reach another origin. Writes are not retried; a
timeout can happen after a server commit, so refresh before re-applying.

## Resources

See [`examples/main.tf`](examples/main.tf).

- **`novagate_service`**: `name`, `targets` (`url`, `weight` 1–100, default 100),
  health check settings, `h2`, `supports_websocket`, `load_balancing`. Destroy
  soft-deletes the service.
- **`novagate_route`**: `method`, `path_pattern`, `service_id`, `auth_required`,
  `enabled`, `rate_limit_override`, `retry`, `plugins` (ordered JSON; sensitive,
  compared semantically) and `portal` (developer portal publication). Removing an
  optional setting clears it. Destroy soft-deletes the route.
- **`novagate_consumer`**: `name` and `rate_limit_tier` (changes replace the
  consumer and issue a new key) and `groups`. `api_key` is returned once at
  creation and kept in state as a sensitive value; imported consumers have no
  key. Destroy revokes the key.
- **`novagate_alert_rule`**: `name`, `metric`, `operator`, `threshold`,
  `window_minutes`, `min_requests`, `channel_ids`, `enabled`. Updates and deletes
  use the server revision, so changes made elsewhere since the last refresh fail
  instead of being overwritten. Delivery channels hold credentials and stay in
  the dashboard.

All four resources import by ID: `terraform import novagate_route.example <uuid>`.
State holds consumer keys and plugin credentials; protect it accordingly.

Developer-portal keys belong to developers and are not managed here. Declarative
`gwx routes apply` and Terraform should not both own the same workspace objects.

## Development

```sh
npm exec nx run-many -t lint test build -p terraform-provider
npm exec nx run terraform-provider:acceptance   # needs Go, Terraform, PostgreSQL, Redis
```

`acceptance` provisions a disposable workspace on PostgreSQL (`E2E_DATABASE_URL`),
starts the built admin API with Redis (`E2E_REDIS_URL`) and mints scoped tokens.
It then runs the acceptance tests with the real Terraform CLI: create, in-place
updates, clearing optional settings, import of every resource, a scope-denial
case and destroy. Finally it confirms in SQL that destroy soft-deleted the route
and service and revoked the consumer.

Registry publication (signing keys and the GitHub release workflow) is release
work; until then use a [development override](https://developer.hashicorp.com/terraform/cli/config/config-file#development-overrides-for-provider-developers)
pointing at `integrations/terraform-provider/dist`.
