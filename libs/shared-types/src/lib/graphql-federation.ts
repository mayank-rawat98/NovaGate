/**
 * GraphQL federation (roadmap 6.7): a workspace registers subgraph SDL per
 * NovaGate service; the admin API composes the supergraph when it is saved,
 * and gateways execute queries against it through the `graphql-federation`
 * route plugin, calling each subgraph's service.
 */

export const GRAPHQL_FEDERATION_PLUGIN = 'graphql-federation';
/** Graph and subgraph names: lowercase words joined by single hyphens. */
export const FEDERATED_GRAPH_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_FEDERATED_GRAPH_NAME_LENGTH = 48;
export const MAX_FEDERATED_GRAPHS = 8;
export const MAX_SUBGRAPHS = 16;
export const MAX_SUBGRAPH_SDL_BYTES = 262144;
export const MAX_SUPERGRAPH_SDL_BYTES = 1048576;
export const DEFAULT_SUBGRAPH_PATH = '/graphql';
export const MAX_SUBGRAPH_PATH_LENGTH = 512;
export const SUBGRAPH_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
export const MAX_FEDERATION_FORWARD_HEADERS = 16;
/** Headers never forwarded to subgraphs, whatever the route says. */
export const FEDERATION_RESERVED_HEADERS = [
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'accept',
  'accept-encoding',
  'x-request-id',
];
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** Endpoint written into the supergraph's join__graph(url:) for a subgraph.
 * Gateways resolve it to the subgraph's NovaGate service, never by URL. */
export const SUBGRAPH_ENDPOINT_PREFIX = 'novagate://subgraph/';
export function subgraphEndpoint(name: string): string {
  return SUBGRAPH_ENDPOINT_PREFIX + name;
}
export function subgraphOfEndpoint(endpoint: unknown): string | null {
  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith(SUBGRAPH_ENDPOINT_PREFIX)
  )
    return null;
  const name = endpoint.slice(SUBGRAPH_ENDPOINT_PREFIX.length);
  return isFederatedGraphName(name) ? name : null;
}

export function isFederatedGraphName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_FEDERATED_GRAPH_NAME_LENGTH &&
    FEDERATED_GRAPH_NAME_PATTERN.test(value)
  );
}
export function isSubgraphPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SUBGRAPH_PATH_LENGTH &&
    SUBGRAPH_PATH_PATTERN.test(value) &&
    !value.split('/').some((segment) => segment === '..' || segment === '.')
  );
}
export function isForwardableHeader(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    HEADER_NAME_PATTERN.test(value) &&
    !FEDERATION_RESERVED_HEADERS.includes(value) &&
    !value.startsWith('sec-websocket-')
  );
}

export interface FederatedSubgraphConfig {
  name: string;
  serviceId: string;
  /** Path on the service's targets, such as /graphql. */
  path: string;
}

/** What gateways receive in `TenantConfig.federatedGraphs`. */
export interface FederatedGraphConfig {
  name: string;
  /** Composed supergraph SDL (join/link directives), at most 1 MiB. */
  supergraphSdl: string;
  /** SHA-256 of supergraphSdl; gateways rebuild only when it changes. */
  sha256: string;
  subgraphs: FederatedSubgraphConfig[];
}

/** Columns both configuration assemblers select from `federated_graphs`. */
export const FEDERATED_GRAPH_CONFIG_COLUMNS = `name, "supergraphSdl", sha256, subgraphs`;
/** Database rows → gateway configuration; the stored SDL stays behind. */
export function federatedGraphConfigs(rows: unknown): FederatedGraphConfig[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: Record<string, unknown>) => ({
    name: row.name as string,
    supergraphSdl: row.supergraphSdl as string,
    sha256: row.sha256 as string,
    subgraphs: (
      (Array.isArray(row.subgraphs) ? row.subgraphs : []) as Array<
        Record<string, unknown>
      >
    ).map((subgraph) => ({
      name: subgraph.name as string,
      serviceId: subgraph.serviceId as string,
      path: subgraph.path as string,
    })),
  }));
}

/** `graphql-federation` route plugin configuration. */
export interface GraphqlFederationPluginConfig {
  graph: string;
  /** Lowercase request header names copied to every subgraph request. */
  forwardHeaders?: string[];
}

/** Validates route plugin configuration; returns a reason or null. */
export function graphqlFederationConfigProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'configuration must be an object';
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some(
      (key) => !['graph', 'forwardHeaders'].includes(key),
    )
  )
    return 'only graph and forwardHeaders are allowed';
  if (!isFederatedGraphName(config.graph))
    return 'graph must name a federated graph';
  const headers = config.forwardHeaders;
  if (headers === undefined) return null;
  if (
    !Array.isArray(headers) ||
    headers.length > MAX_FEDERATION_FORWARD_HEADERS ||
    !headers.every(isForwardableHeader) ||
    new Set(headers).size !== headers.length
  )
    return `forwardHeaders lists up to ${MAX_FEDERATION_FORWARD_HEADERS} unique lowercase header names (not hop-by-hop, framing or X-Request-ID)`;
  return null;
}

/** Admin API views. */
export interface FederatedSubgraphSummary extends FederatedSubgraphConfig {
  serviceName: string | null;
  sdlBytes: number;
  sdlSha256: string;
}
export interface FederatedGraphSummary {
  name: string;
  subgraphs: FederatedSubgraphSummary[];
  /** The client-facing schema (federation directives removed). */
  publicSdl: string;
  supergraphSha256: string;
  /** Routes using the graph, as "METHOD /path". */
  routes: string[];
  updatedAt: string;
}
export interface FederationCompositionError {
  message: string;
  code?: string;
}
export interface FederationCompositionResult {
  ok: boolean;
  errors: FederationCompositionError[];
  publicSdl?: string;
}
