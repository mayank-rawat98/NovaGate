# Redis Key Design

## Rate Limiting Keys

| Purpose | Key Pattern | TTL |
| --- | --- | --- |
| Sliding window counters | `rl:{clientKey}` | `windowMs` rounded up to seconds |

### clientKey

- Unauthenticated: `ip`
- Authenticated: `userId:ip`

The sliding window stores timestamps as sorted set members (`{timestamp}-{random}`) with the score set to the timestamp in milliseconds. Keys are automatically expired using `EXPIRE` with the configured window size.
