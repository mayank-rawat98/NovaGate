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
