# NovaGate WebAssembly plugins

WebAssembly plugins are installed per workspace from the dashboard's **Plugin
marketplace** (catalog or upload). Gateways run them in a sandbox without
operator involvement (issue #123). For operator-installed npm plugins, see the
[plugin SDK](../README.md).

## Sandbox

- **Isolation:** each module runs in a gateway worker thread. Its instance sees only the host functions below and a memory the host creates.
- **No ambient access:** there is no WASI, no filesystem, no clock or randomness, and no network except `http_get`.
- **Memory:** modules must import their memory as `env.memory`. The host caps it at **160 pages (10 MiB)**, so `memory.grow` beyond that returns -1.
- **Deadline:** each hook call has **50 ms** (`WASM_PLUGIN_TIMEOUT_MS`), including any `http_get` calls. A module that runs longer has its thread terminated, and the request fails closed with `502 PLUGIN_FAILED`.
- **Quarantine:** repeated failures pause the plugin (`503 PLUGIN_UNAVAILABLE`) for `WASM_PLUGIN_QUARANTINE_MS`. Traps and out-of-bounds host calls count as failures.
- **Response hooks:** failures there never alter the response.
- **Checked twice:** the admin API inspects modules at upload and the gateway inspects them again before compiling. A module is refused if it imports anything else, defines its own memory, uses shared or 64-bit memory, or exports neither hook.
- **Distribution by digest:** configuration carries each plugin's SHA-256, and gateways fetch the bytes from the control plane and verify them. Routes naming a plugin that is not yet available fail closed with 503.

## ABI

Export one or both hooks; each returns 0:

| Export        | When                                                  |
| ------------- | ----------------------------------------------------- |
| `on_request`  | Before proxying. Can edit request headers or respond. |
| `on_response` | After the upstream answers. Can set response headers. |

Host functions are imported from the module `novagate`. Strings are a pointer and a byte length in the plugin's memory.

- **Getters** write at most `cap` bytes and return the full length, or -1 when absent.
- **Setters** return 0, or -1 when refused. A setter refuses an invalid or restricted name, a value with CR/LF, more than 64 operations, or a hook where the call is not allowed.

| Function                                      | Notes                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `log(level, ptr, len)`                        | 0 info, 1 warn, 2 error; up to 16 per call, 512 bytes each                                                                                                                           |
| `get_method(out, cap)`, `get_path(out, cap)`  | Path without the query string                                                                                                                                                        |
| `get_header(name, name_len, out, cap)`        | Case-insensitive; repeated headers joined with `, `                                                                                                                                  |
| `get_config(key, key_len, out, cap)`          | Top-level key of the route's plugin `config`; numbers and booleans as text, objects as JSON                                                                                          |
| `get_consumer(out, cap)`                      | Gateway consumer ID of an authenticated consumer key                                                                                                                                 |
| `get_response_status()`                       | In `on_response`                                                                                                                                                                     |
| `set_request_header`, `remove_request_header` | `on_request` only. `host`, `content-length`, `transfer-encoding`, `connection`, `x-request-id`, `forwarded`, `x-forwarded-*` and `proxy-*` are refused                               |
| `set_response_header(name, len, value, len)`  | Both hooks; hop-by-hop, `content-length` and `content-encoding` are refused                                                                                                          |
| `respond(status, body, len)`                  | `on_request` only, once; status 200–599, body up to 64 KiB                                                                                                                           |
| `http_get(url, len, out, cap)`                | HTTPS GET to a host in the plugin's `allowedHosts` (exact `host[:port]`), no redirects; returns the status, -1 when refused, -2 on failure or timeout. Up to 4 per call, 64 KiB body |

## C

[`novagate.h`](novagate.h) declares the imports. Build a single translation unit:

```sh
clang --target=wasm32 -O2 -nostdlib -fno-builtin -Wl,--no-entry \
  -Wl,--import-memory -Wl,--initial-memory=131072 -Wl,--strip-all \
  -o plugin.wasm plugin.c
```

```c
#include "novagate.h"

NG_EXPORT(on_request) int on_request(void) {
  char value[64];
  if (ng_get_header(NG_STR("x-tenant"), value, sizeof value) < 0)
    ng_respond(400, NG_STR("{\"error\":\"MISSING_TENANT\"}"));
  return 0;
}
```

Rust and AssemblyScript work the same way: import the functions from `novagate`, import memory from `env.memory` (for Rust: `-C link-arg=--import-memory`), and export the hooks.

## Using a plugin

1. Install it from the catalog, or upload a `.wasm` file with a name, an exact version and optional allowed hosts.
2. In the route editor's Plugins tab, add `wasm:<name>` with a JSON configuration object. Declarative configuration and Terraform route `plugins` accept the same entry.
3. Plugins → Installed shows each plugin's gateway state and its p99 time per call, measured inside the sandbox.

A plugin that a route still uses cannot be removed.

## Catalog and fixtures

`catalog/` holds the curated plugins (`catalog.json` describes them), and `fixtures/` the sandbox test modules: runaway loop, memory growth, trap, WASI filesystem import, own memory, HTTP and echo. Built `.wasm` files are committed. `node tools/build-wasm-plugins.mjs` rebuilds them with clang and regenerates `apps/admin-api/src/wasm-plugins/catalog.generated.ts`; an admin test checks that the embedded catalog matches the committed modules.
