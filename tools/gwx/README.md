# gwx — NovaGate CLI

The CLI calls the tenant admin API and uses the same declarative configuration
contract as Settings. Requires Node.js 24 or newer. The local Nx workspace package
is `@api-gateway/gwx`, with a `gwx` executable. It is private and has not been
published; npm distribution and registry ownership remain release work.

From the repository:

```sh
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run gwx:build
node tools/gwx/dist/main.js --help
npm pack ./tools/gwx --pack-destination /YOUR/OUTPUT/DIRECTORY
npm install /YOUR/OUTPUT/DIRECTORY/api-gateway-gwx-0.0.1.tgz
```

The tarball contains the bundled executable and this guide. It needs no repository
checkout or runtime npm dependencies. Use the installed `gwx` binary in subsequent
examples.

## Authentication

```sh
gwx login --api-url https://YOUR-ADMIN-HOST/api
gwx routes list
gwx logout
```

Login prompts for an email and a hidden password. `--email`, `GW_EMAIL` and
`GW_PASSWORD` allow noninteractive login; a password command-line flag is not
supported. Sessions are saved atomically in `~/.gwx/credentials`, owned by the
current user with file mode 600 and directory mode 700. `GWX_CONFIG_DIR` can select
another private directory. Symlink files/directories, nonregular files and foreign ownership are
refused. Named pipes are opened without blocking and refused before use. Failed login leaves a previous credential file intact. Logout removes
that local credential file; it does not revoke the server-issued JWT.

For automation, provide `GW_API_URL`, `GW_TENANT_ID` and `GW_API_TOKEN`. Environment
authentication does not read or write the saved credential store. Empty
`GW_API_TOKEN` falls back to a saved session. `--api-url` and `--tenant` override
configuration, but a saved session cannot be sent to another API origin or
workspace. API credentials travel in the Authorization header. HTTPS is required
except for loopback HTTP development. URL credentials, query strings, fragments
and redirects are refused.

The current credential is the existing tenant session JWT, with the same tenant
permissions as the dashboard. Operation-scoped automation tokens, revocation and
enterprise RBAC remain required before declaring phase 5.2 complete. Consumer API
keys authenticate gateway traffic and cannot authorize admin commands.

## Commands

```sh
gwx routes list --json
gwx routes export --output gateway.yml
gwx routes apply gateway.yml --dry-run --json
gwx routes apply gateway.yml
gwx routes apply gateway.yml --yes --json
gwx consumers create --name ci-bot --json
gwx alerts list --json
gwx logs tail
gwx logs tail --once
```

`routes export` writes secret-free YAML to stdout or a **new** mode-600 file;
existing files and symlinks are refused. `routes apply` accepts a nonempty regular
UTF-8 YAML/JSON file up to 64 KiB; symlinks and nonregular files are refused
without waiting for a named-pipe writer. The default is `gateway.yml`.
All parsing and semantic validation run on the admin API.

Every apply first obtains a preview, displays its changes, then submits the exact
reviewed bytes with that preview's revision in `If-Match`. A maximum-size
replacement can contain 400 preview actions (200 additions and 200 removals). This is a complete
replacement: omitted services/routes are removed, omitted consumers revoked.
Matching IDs/keys survive; omitted credentials on an existing matching plugin
remain private and unchanged. See the admin API's
[configuration contract](../../apps/admin-api/src/config-import/README.md).

`--dry-run` performs only the write-free preview. Interactive apply requires
confirmation (default no); automation requires `--yes`. A conflict or expired
preview stops the command; rerun to review current state. Apply reports `queued`
for durable gateway delivery, not a gateway ACK. No mutating command retries.
A timeout or broken output can happen after a server commit; inspect current
configuration before creating another consumer or repeating an apply.

Consumer creation and apply print newly created keys once. Save them in your own
secret store. They are not persisted in the CLI credential directory. Route,
alert and log output projects public metadata and excludes plugin credentials,
channel configuration, hashes and internal receipt/rollup columns. JSON results
use stdout; review text, key-save notices and errors use stderr. Log output is
newline-delimited JSON even without `--json`.

## Live logs

`logs tail` reads the newest 50 retained request-log observations, then polls for
new receipts through authenticated `/tenants/:tenantId/logs/stream`. It follows
receipt order, so late request timestamps are still included. This is a sampled
starting point and recorded-log feed, not a complete archive or traffic guarantee.
`--once` exits after the first nonempty batch; an empty workspace waits for a new
record. Ctrl-C exits 130; SIGTERM exits 143.

The CLI reconnects after normal EOF using the last fully printed batch's encrypted
cursor. It keeps that cursor only in process memory. Interrupted output can replay
a batch; deduplicate by log `id` when consuming the output. A retention gap prints
a warning; expired records are never returned. Active streams reapply current
privacy and retention policy on each read. Authentication/read/protocol failures
stop the command with a fixed error; reinvoke after addressing the cause. The CLI
bounds HTTP responses, stream frames, output waits and heartbeat silence.

## Verification

```sh
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run gwx:test --runInBand
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run-many -t lint typecheck -p gwx
NX_DAEMON=false NX_NO_CLOUD=true npm exec -- nx run gwx:tty-smoke
```

The CLI tests execute the built entry in a disposable directory against actual
HTTP sockets, credential files and process signals. `GWX_TEST_NODE_EXECUTABLE`
can select the child Node executable to verify the declared Node 24 minimum
while workspace tasks run on Node 26.11.1. `admin-api:runtime-smoke`
installs a local tarball outside the checkout and verifies its real binary against
packaged admin, collector and gateway applications. No package is published by
these checks.

`tty-smoke` uses Python 3's standard-library POSIX pseudo terminal on macOS/Linux
to verify immediate password input is not echoed and declining an apply submits
no mutation. Python is a verification dependency only. Current private credential
storage is verified with POSIX ownership/permissions; Windows ACL acceptance
remains release work.
