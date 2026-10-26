# Redis Key Design

## Rate Limiting Keys

| Purpose                 | Key Pattern      | TTL                              |
| ----------------------- | ---------------- | -------------------------------- |
| Sliding window counters | `rl:{clientKey}` | `windowMs` rounded up to seconds |

### clientKey

- Unauthenticated: `ip`
- Authenticated: `userId:ip`

The sliding window stores timestamps as sorted set members (`{timestamp}-{random}`) with the score set to the timestamp in milliseconds. Keys are automatically expired using `EXPIRE` with the configured window size.

## Remote authentication

`oauth2:introspect:v2:<sha256>` hashes tenant, provider endpoint, client credentials, scope/header/issuer/audience configuration and the incoming token. Values use a versioned envelope that binds the cache scope and absolute expiration to the active normalized provider result. Redis uses millisecond `PX` expiration capped by the token expiration and `IDENTITY_PROVIDER_INTROSPECTION_CACHE_TTL_MS` (30 seconds by default). Legacy token-only entries are ignored. No tokens or secrets appear literally in keys. Cache failures require remote verification rather than granting access.

## Usage metering (gateway Redis)

Issue #119. One workspace per gateway, so there is no tenant prefix. `<YYYYMM>` is the UTC month.

| Purpose                             | Key Pattern                     | TTL     |
| ----------------------------------- | ------------------------------- | ------- |
| Workspace requests this month       | `meter:<YYYYMM>:requests`       | 40 days |
| Consumer requests this month        | `meter:<YYYYMM>:c:<consumerId>` | 40 days |
| Consumers counted this month (set)  | `meter:<YYYYMM>:consumers`      | 40 days |
| Counter source ID reported upstream | `meter:source`                  | none    |

Counters are cumulative and only increase. One Lua script checks the consumer's
quota and increments all three keys atomically, refusing at the quota without
counting. The 40-day TTL lets the next month still report the previous
month's final totals. Gateways sharing a Redis share `meter:source`, so the
admin API never double counts them.

## WebAssembly plugin modules (gateway Redis)

Issue #123.

| Purpose                        | Key Pattern     | TTL     |
| ------------------------------ | --------------- | ------- |
| Verified module bytes (base64) | `wasm:<sha256>` | 30 days |

The gateway checks the bytes against the digest from configuration and against the sandbox rules before storing them. A gateway that restarts while the control plane is unreachable runs its plugins from this cache.

The control plane keeps the gateway's last runtime report in its own Redis under `gw:wasm:<tenantId>`, with a TTL of 180 s.
