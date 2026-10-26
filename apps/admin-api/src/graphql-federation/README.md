# GraphQL federation

Issue #127 (roadmap 6.7). A workspace combines the GraphQL schemas of several
NovaGate services into one federated graph. Its gateways answer queries on any
route with the `graphql-federation` plugin: they plan each query, call the
subgraphs and merge the results. A separate Apollo Router or GraphQL Mesh
deployment is not needed.

## Defining a graph

Each subgraph is:

- a name (lowercase letters and digits joined by single hyphens, up to 48);
- the NovaGate service that serves it;
- the path on that service (default `/graphql`);
- its SDL, at most 256 KiB, with Apollo Federation v1 or v2 directives (`@key`,
  `@external`, `@requires`, `@provides`, `@shareable`, `@override`...).

A graph has 1–16 subgraphs, and a workspace has at most 8 graphs.

```http
PUT /api/tenants/:tenantId/graphql-federation/graphs/storefront
{ "subgraphs": [
    { "name": "users", "serviceId": "…", "path": "/graphql", "sdl": "…" },
    { "name": "reviews", "serviceId": "…", "path": "/query", "sdl": "…" } ] }
```

- **Composition on save:** saving composes the supergraph with
  `@theguild/federation-composition` (MIT). Graphs that do not compose are refused
  with `422 COMPOSITION_FAILED` and the composition errors (message and code, such
  as `FIELD_TYPE_MISMATCH`). Gateways therefore only receive valid supergraphs.
- **Dry run:** `POST …/graphql-federation/compose` with the same body returns
  `{ ok, errors, publicSdl }` without saving. Use it for editors and CI.
- **Reading graphs:**
  - `GET …/graphs` lists graphs with subgraph sizes and digests, the client-facing
    schema and the routes that serve each graph.
  - `GET …/graphs/:name` returns the stored SDL, for editing.
- **Deleting:** `DELETE …/graphs/:name` soft-deletes a graph. It is refused while a
  route uses the graph.
- **Automation tokens:** reads and dry runs need `routes:read`; saves and deletes
  need `routes:write`.

Requests to these endpoints may be up to 8 MiB (`graphql-federation.body-parser.ts`).
All other JSON endpoints keep Nest's default limit.

## What gateways receive

`TenantConfig.federatedGraphs` holds, for each graph:

- the name;
- the supergraph SDL (at most 1 MiB);
- its SHA-256;
- the subgraph list: name, service ID and path.

The uploaded SDL itself stays in the admin API. The control plane's initial
snapshot reads the same columns (`FEDERATED_GRAPH_CONFIG_COLUMNS`, shared-types).

Subgraph URLs in the supergraph are `novagate://subgraph/<name>`. Gateways resolve
each subgraph to its service's targets and never call a URL written in a schema.

## Serving a graph

Add the plugin as the **last** plugin on a route, for example `ANY /graphql`.
The admin API refuses it anywhere else.

```json
{ "name": "graphql-federation", "config": { "graph": "storefront", "forwardHeaders": ["authorization"] } }
```

- **Request handling:** the route's other plugins, its `authRequired` setting and
  usage metering run first. The gateway then validates the operation against the
  supergraph and executes it. It never forwards the request to the route's service.
- **Forwarded headers:** `forwardHeaders` names request headers copied to every
  subgraph request. Hop-by-hop, framing and `X-Request-ID` headers cannot be
  listed: the gateway always sends its own `X-Request-ID` and trace context.
- **Limits:** add `graphql-guard` before the plugin to set depth, complexity and
  introspection limits. Without it, the gateway's default depth (10) and
  complexity (1000) apply.

See `apps/api/CLAUDE.md` for gateway behaviour and limits. Run
`npm exec nx run @api-gateway/api:graphql-federation-e2e` for the real-process
check.
