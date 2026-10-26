/**
 * Multi-region control planes (roadmap 6.3). Gateways hold an ordered list of
 * control plane endpoints, optionally labelled with their region, and fail
 * over between them; live traffic never depends on which one is reachable.
 */

/** Lowercase region label, e.g. "us-east" or "eu-west-1". */
export const CONTROL_PLANE_REGION_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_CONTROL_PLANE_ENDPOINTS = 8;
export const MAX_GATEWAY_INSTANCE_NAME_LENGTH = 64;
/** Instances not seen for this long are shown offline. */
export const GATEWAY_INSTANCE_STALE_MS = 120000;

export interface ControlPlaneEndpoint {
  region: string | null;
  url: string;
}

export function isControlPlaneRegion(value: unknown): value is string {
  return typeof value === 'string' && CONTROL_PLANE_REGION_PATTERN.test(value);
}

/**
 * Parses `wss://a,eu-west=wss://b`: comma-separated WebSocket URLs in
 * priority order, each optionally prefixed by `region=`. Throws on anything
 * invalid so a misconfigured gateway fails at startup.
 */
export function parseControlPlaneEndpoints(
  value: string,
): ControlPlaneEndpoint[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length || entries.length > MAX_CONTROL_PLANE_ENDPOINTS)
    throw new Error(
      `Configure 1 to ${MAX_CONTROL_PLANE_ENDPOINTS} control plane endpoints`,
    );
  const endpoints: ControlPlaneEndpoint[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const labelled = separator > 0 && !entry.slice(0, separator).includes(':');
    const region = labelled ? entry.slice(0, separator) : null;
    const raw = labelled ? entry.slice(separator + 1) : entry;
    if (region !== null && !CONTROL_PLANE_REGION_PATTERN.test(region))
      throw new Error(`Invalid control plane region "${region.slice(0, 40)}"`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('Control plane endpoints must be ws:// or wss:// URLs');
    }
    if (
      (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Control plane endpoints must be ws:// or wss:// URLs');
    if (endpoints.some((endpoint) => endpoint.url === url.toString()))
      throw new Error('Control plane endpoints must be unique');
    if (region && endpoints.some((endpoint) => endpoint.region === region))
      throw new Error(`Control plane region "${region}" is listed twice`);
    endpoints.push({ region, url: url.toString() });
  }
  return endpoints;
}

/**
 * Connection order: the preferred region first when the gateway knows it,
 * then the configured order.
 */
export function orderControlPlaneEndpoints(
  endpoints: ControlPlaneEndpoint[],
  preferredRegion: string | null | undefined,
): ControlPlaneEndpoint[] {
  const preferred = preferredRegion
    ? endpoints.find((endpoint) => endpoint.region === preferredRegion)
    : undefined;
  return preferred
    ? [preferred, ...endpoints.filter((endpoint) => endpoint !== preferred)]
    : [...endpoints];
}

/** A gateway process as last seen by any control plane region. */
export interface GatewayInstance {
  instanceId: string;
  name: string;
  /** Control plane region it is (or was last) connected to. */
  region: string | null;
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
  /** Last configuration version the gateway installed (acknowledged). */
  configVersion: number | null;
  online: boolean;
}

export interface ControlPlaneRegionsState {
  /** Regions this installation runs, from CONTROL_PLANE_REGIONS. */
  regions: string[];
  preferredRegion: string | null;
  /** The workspace's current configuration version. */
  configVersion: number;
  gateways: GatewayInstance[];
}

export interface SavePreferredRegion {
  preferredRegion: string | null;
}
