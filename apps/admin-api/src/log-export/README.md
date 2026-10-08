# Log export destinations

Private RustFS manual and scheduled archives remain the active export product.
The external destination API stores **drafts** for S3-compatible buckets, NDJSON
webhooks and Datadog. It does not send data or contact a provider. Every read
reports `deliveryAvailable: false`, and destination rows remain `state: draft`.
Settings controls, DNS-pinned provider transports, delivery history and activation
follow this foundation; storing a draft is not external export acceptance.

## Encryption configuration

Inject `LOG_EXPORT_DESTINATION_KEYS` as a JSON object mapping up to four key IDs
(1–32 ASCII letters, digits, underscore or hyphen) to canonical base64-encoded
32-byte random keys. Set `LOG_EXPORT_DESTINATION_ACTIVE_KEY` to one of those IDs.
Compose passes both values to admin-api. Omitted/empty pairs disable credential
creation/replacement/rotation; malformed or partial configuration fails startup.
Keys are independent of alert, JWT and platform archive credentials. No fallback
exists. Do not put real keys in source control or request/log output.

All connection details are encrypted using AES-256-GCM with a random 12-byte nonce
and 16-byte authentication tag. Associated data binds the envelope version,
namespace, canonical tenant UUID, destination UUID, provider type and key ID.
Cross-tenant, cross-destination, cross-provider and alert-envelope substitution
fails authentication. Public reads project only name/type/HTTPS origin or Datadog
site; URL paths, queries, keys, session tokens and envelopes are never returned.
`credentialStatus: available` means the stored credential can be decrypted and
parsed with retained keys; it does not mean the provider has accepted it.

## Tenant API

All routes require the existing signed tenant session; a session for another
workspace is rejected before reaching storage. Responses are `no-store`.

Base: `/api/tenants/:tenantId/log-export-destinations`

| Method | Suffix            | Input                                                          |
| ------ | ----------------- | -------------------------------------------------------------- |
| GET    | (base)            | Lists at most ten active drafts and configuration availability |
| POST   | (base)            | `{ name, credentials }`                                        |
| PUT    | `/:id`            | `{ name, expectedRevision, credentials? }`                     |
| POST   | `/:id/rotate-key` | `{ expectedRevision }`                                         |
| DELETE | `/:id`            | `{ expectedRevision }`; returns 204                            |

Credentials use the shared `LogExportDestinationCredentials` discriminated union.
Replacement is complete and retains the provider type. Omit credentials for a
metadata-only update; a corrupt/missing-key draft can be renamed or removed even
if encryption is disabled. Stale revisions return 409. Destination IDs belonging
to a different tenant return 404. Removal clears the live encrypted credential
field and retains a nonsecret identity tombstone for future delivery history.
Backup/WAL retention and restore behavior remain operational recovery work.

S3 drafts accept an HTTPS endpoint origin, ordinary bucket name, region, access
key, secret key, explicit path-style setting and optional session token. Webhooks
accept an HTTPS URL and a 32–256-byte signing secret. Datadog requires one of the
shared site identifiers and a 32-character hexadecimal API key. Validation rejects
extra fields, unsupported activation settings, plaintext/nonstandard-port URLs,
URL user info/fragments, ambiguous whitespace/backslashes and literal
private/reserved/transition addresses. This validation does not resolve DNS;
before sending, the delivery worker must validate all resolved addresses and pin
the connection to that validated destination, forbid redirects and bound all
connection/body/retry phases. These draft APIs perform no network validation.

Provider references: [S3 bucket naming](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html),
[Datadog sites](https://docs.datadoghq.com/getting_started/site/), and
[Node authenticated encryption](https://nodejs.org/docs/latest-v24.x/api/crypto.html#ciphersetaadbuffer-options).

## Key rotation

1. Deploy the old and new keys together, selecting the new active write key.
2. Fetch each tenant's current destination revisions and call `rotate-key` for
   each readable draft. Rotation decrypts privately and rewrites with the active
   key under a row lock; it changes the revision and never returns credentials.
   Retry revision conflicts after fetching current state. Replacement credentials
   can repair drafts whose old key is already lost.
3. Verify all live records use the new key before retiring the old key. Operator
   metadata-only inspection can use:

   ```sql
   SELECT credentials->>'keyId' AS key_id, COUNT(*)
   FROM public.log_export_destinations
   WHERE deleted_at IS NULL
   GROUP BY credentials->>'keyId';
   ```

4. Retain recovery key access for backups that still contain old envelopes under
   the operator's backup/retention policy. Restore drills are still pending.

There are eight admitted operations per admin instance, at most ten active
connections per tenant, three-second SQL and one-second lock budgets, plus the
existing bounded database pool. A tenant advisory transaction lock coordinates
creation across replicas; row locks and exact revisions serialize changes.
Contention returns 503 without changing saved state. Shutdown rejects new work,
drains admitted operations and disposes encryption keys.

## Verification

Run through Nx with local PostgreSQL on OrbStack:

```sh
TEST_DATABASE_URL=postgres://novagate_test:local-verification-only@127.0.0.1:15432/novagate_test \
NX_DAEMON=false NX_NO_CLOUD=true \
npm exec nx run admin-api:test -- --testPathPatterns=export-destination --maxWorkers=2
```

The real HTTP/PostgreSQL suite covers all provider draft types, encrypted storage,
no-store reads, every operation's tenant-session boundary, revision races,
replica capacity, disabled configuration, lock timeout, same-type credential
replacement, key rewrap/retirement, removal and repeated startup upgrades. Cipher
and input cases cover authentication/tampering, namespace isolation, randomized
nonces, key disposal, provider validation and global operation admission/draining.
The packaged `admin-api:runtime-smoke` runs the same draft boundary in the actual
non-root production image alongside retained metrics, alerts, RustFS archives,
privacy/retention and shutdown regressions.
