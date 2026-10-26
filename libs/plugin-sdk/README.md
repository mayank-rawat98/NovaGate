# NovaGate plugin SDK

`@api-gateway/plugin-sdk` is for writing and testing third-party gateway
plugins: npm packages that a gateway operator installs next to the gateway and
attaches to routes, like the built-in `cors` or `oidc` plugins.

## Trust model

Third-party plugins run inside the gateway process with full access. They are
**trusted code**, not a sandbox. For untrusted code, workspaces install
[WebAssembly plugins](wasm/README.md), which run in a sandbox. The safeguards
for npm plugins are:

- **Operator opt-in.** The gateway loads only the packages its operator lists in
  `THIRD_PARTY_PLUGINS`, each pinned to an exact version. The installed
  `package.json` must match that name and version.
- **Scoped names.** A plugin's name is its scoped package name, such as
  `@acme/saml-auth`, so it can never shadow a built-in plugin.
- **Bounded hooks.** Every hook has a deadline
  (`THIRD_PARTY_PLUGIN_HOOK_TIMEOUT_MS`, default 2000 ms).
- **Fail closed.** If a request hook throws, rejects or times out, the request
  is refused with `502 PLUGIN_FAILED`. Response and error hooks are skipped on
  failure.
- **Quarantine.** After `THIRD_PARTY_PLUGIN_FAILURE_THRESHOLD` consecutive
  failures (default 5), the plugin is paused for
  `THIRD_PARTY_PLUGIN_QUARANTINE_MS` (default 30 s). An uncaught exception or
  unhandled rejection whose stack points into the plugin's installed directory
  pauses it immediately, and the gateway keeps running. Routes using a paused
  plugin answer `503 PLUGIN_UNAVAILABLE`, as do routes naming a package the
  gateway did not load.
- **Kill switch.** Workspace owners can disable a plugin in **Settings → Gateway
  plugins**. Its routes then answer `503 PLUGIN_DISABLED`.
- **Visibility.** The gateway reports each plugin's version, state, failure
  count and last error (one line, with no stack or request data) to the control
  plane every 60 seconds and on every change.

Plugin configuration is stored with the route and appears in configuration
exports. Never put secrets in it. Read them from the plugin's own environment
on the gateway instead.

## Writing a plugin

```ts
import { definePlugin } from '@api-gateway/plugin-sdk';

export default definePlugin({
  name: '@acme/tenant-header', // must equal the package name
  protocols: ['http'], // optional; http, websocket, grpc
  async onRequest(ctx) {
    const entry = ctx.route.plugins?.find((p) => p.name === '@acme/tenant-header');
    const value = entry?.config.value;
    if (typeof value !== 'string') return { status: 500, body: 'tenant-header is not configured' };
    ctx.req.headers['x-tenant'] = value;
    return undefined; // continue to the next plugin
  },
  async onResponse(ctx) {
    ctx.res.setHeader('x-served-by', 'acme');
  },
});
```

Hooks run in the gateway's order: `prepareRequest`, `onRequest`,
`validateRequest`, then `onResponse` (or `onError` when the upstream fails).
Returning a `PluginShortCircuit` (`{ status, headers?, body? }`) from a request
hook stops the chain and sends that response. `definePlugin` applies the same
checks the gateway loader does, so mistakes show up in your tests.

Publish CommonJS or ESM that the gateway's Node.js version can `require` (the
gateway image runs Node.js 26). The package's `main`/`exports` must resolve to
the plugin object, as `module.exports` or a default export.

## Testing a plugin

`createMockContext` builds a `PluginContext` from real Node HTTP objects, and
`runPlugin` runs your hooks in gateway order:

```ts
import { createMockContext, runPlugin } from '@api-gateway/plugin-sdk';
import plugin from './index';

it('stamps the tenant', async () => {
  const ctx = createMockContext({
    route: { plugins: [{ name: '@acme/tenant-header', config: { value: 'blue' } }] },
  });
  const result = await runPlugin(plugin, ctx, { statusCode: 200 });
  expect(result.shortCircuit).toBeUndefined();
  expect(ctx.req.headers['x-tenant']).toBe('blue');
  expect(ctx.res.getHeader('x-served-by')).toBe('acme');
});
```

`ctx.logs` records what the plugin wrote through `ctx.logger`.

## Installing plugins on a gateway

```sh
mkdir -p /srv/novagate-plugins && cd /srv/novagate-plugins
npm init -y
npm install --ignore-scripts --save-exact @acme/tenant-header@1.4.2
```

Mount that directory into the gateway container and pin each package:

```yaml
services:
  gateway:
    image: ghcr.io/mayank-rawat98/novagate/api:latest
    volumes:
      - /srv/novagate-plugins:/plugins:ro
    environment:
      THIRD_PARTY_PLUGIN_DIR: /plugins
      THIRD_PARTY_PLUGINS: '[{"package":"@acme/tenant-header","version":"1.4.2"}]'
```

Then add the plugin to a route in the dashboard (Routes → Plugins → Third-party
plugins) or through the API, CLI, declarative configuration or Terraform:

```json
{ "name": "@acme/tenant-header", "config": { "value": "blue" } }
```

A route may list up to 32 plugins. Each third-party configuration must be a JSON
object of at most 16 KiB.

## Examples

`examples/header-stamp` stamps a configured value on the request and response.
`examples/crash-on-request` misbehaves on purpose (throws, hangs, crashes from a
timer, or leaves an unhandled rejection) so the gateway's isolation can be
tested. `tools/third-party-plugins-e2e.mjs` packs both with `npm pack`, installs
them with npm and drives a real gateway, control plane and admin API.
