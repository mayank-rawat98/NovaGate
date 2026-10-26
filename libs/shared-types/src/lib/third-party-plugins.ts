/**
 * Third-party gateway plugins are npm packages an operator installs next to
 * the gateway (trust-based: the operator names each package and exact
 * version). Their names are scoped package names, so they can never collide
 * with first-party plugin names.
 */
export const THIRD_PARTY_PLUGIN_NAME_PATTERN =
  /^@[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9._-]{0,99}$/;
/** Exact versions only: the operator pins what is trusted. */
export const THIRD_PARTY_PLUGIN_VERSION_PATTERN =
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
export const MAX_THIRD_PARTY_PLUGINS = 16;
/** Serialized route configuration bound for one third-party plugin. */
export const MAX_THIRD_PARTY_PLUGIN_CONFIG_BYTES = 16384;
export const MAX_PLUGIN_STATUS_ERROR_LENGTH = 200;
/** Longest scoped name the pattern admits (@ + 63 + / + 100). */
export const MAX_THIRD_PARTY_PLUGIN_NAME_LENGTH = 165;
/** Built-in plugins plus third-party plugins one route may list. */
export const MAX_ROUTE_PLUGINS = 32;

export function isThirdPartyPluginName(name: unknown): name is string {
  return typeof name === 'string' && THIRD_PARTY_PLUGIN_NAME_PATTERN.test(name);
}

export type ThirdPartyPluginState =
  /** Loaded and running. */
  | 'active'
  /** Loaded, but paused after repeated failures; requests fail closed. */
  | 'quarantined'
  /** Not loadable (missing, wrong version, invalid export or load error). */
  | 'failed'
  /** Disabled by the workspace; requests on routes using it fail closed. */
  | 'disabled';

export interface ThirdPartyPluginStatus {
  /** Plugin name used in route configuration (the scoped package name). */
  name: string;
  package: string;
  /** Exact version the operator configured. */
  version: string;
  state: ThirdPartyPluginState;
  protocols: Array<'http' | 'websocket' | 'grpc'>;
  hooks: Array<
    | 'prepareRequest'
    | 'onRequest'
    | 'validateRequest'
    | 'onResponse'
    | 'onError'
  >;
  /** Consecutive failures since the last success. */
  failures: number;
  /** Bounded message without stack or request data. */
  lastError: string | null;
  quarantinedUntil: string | null;
}

/** Gateway → control plane report, sent after authentication and on change. */
export interface GatewayPluginReport {
  plugins: ThirdPartyPluginStatus[];
}

/** Admin view of what the workspace's gateway last reported. */
export interface GatewayPluginState {
  reportedAt: string | null;
  plugins: ThirdPartyPluginStatus[];
  /** Workspace-level disabled plugin names (applies to every gateway). */
  disabled: string[];
}
export interface SaveDisabledPlugins {
  disabled: string[];
}

const STATES: readonly ThirdPartyPluginState[] = [
  'active',
  'quarantined',
  'failed',
  'disabled',
];
const PROTOCOLS = ['http', 'websocket', 'grpc'] as const;
const HOOKS = [
  'prepareRequest',
  'onRequest',
  'validateRequest',
  'onResponse',
  'onError',
] as const;

/**
 * Checks a gateway plugin report field by field and returns a copy holding
 * only known keys, or null when anything is out of bounds. Both the control
 * plane (on receipt) and the admin API (on read) apply it.
 */
export function parsePluginStatuses(
  value: unknown,
): ThirdPartyPluginStatus[] | null {
  if (!Array.isArray(value) || value.length > MAX_THIRD_PARTY_PLUGINS)
    return null;
  const parsed: ThirdPartyPluginStatus[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (
      !isThirdPartyPluginName(item.name) ||
      !isThirdPartyPluginName(item.package) ||
      names.has(item.name) ||
      typeof item.version !== 'string' ||
      !THIRD_PARTY_PLUGIN_VERSION_PATTERN.test(item.version) ||
      !STATES.includes(item.state as ThirdPartyPluginState) ||
      !Array.isArray(item.protocols) ||
      !item.protocols.every((protocol) =>
        (PROTOCOLS as readonly unknown[]).includes(protocol),
      ) ||
      !Array.isArray(item.hooks) ||
      !item.hooks.every((hook) =>
        (HOOKS as readonly unknown[]).includes(hook),
      ) ||
      !Number.isSafeInteger(item.failures) ||
      (item.failures as number) < 0 ||
      !(
        item.lastError === null ||
        (typeof item.lastError === 'string' &&
          item.lastError.length <= MAX_PLUGIN_STATUS_ERROR_LENGTH)
      ) ||
      !(
        item.quarantinedUntil === null ||
        (typeof item.quarantinedUntil === 'string' &&
          item.quarantinedUntil.length <= 40 &&
          !Number.isNaN(Date.parse(item.quarantinedUntil)))
      )
    )
      return null;
    names.add(item.name);
    parsed.push({
      name: item.name,
      package: item.package,
      version: item.version,
      state: item.state as ThirdPartyPluginState,
      protocols: [
        ...new Set(item.protocols),
      ] as ThirdPartyPluginStatus['protocols'],
      hooks: [...new Set(item.hooks)] as ThirdPartyPluginStatus['hooks'],
      failures: item.failures as number,
      lastError: item.lastError as string | null,
      quarantinedUntil: item.quarantinedUntil as string | null,
    });
  }
  return parsed;
}

/**
 * Normalizes a stored or received disabled-plugin list: valid scoped names
 * only, unique, sorted and bounded. Anything else yields an empty list.
 */
export function disabledPluginList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isThirdPartyPluginName))]
    .sort()
    .slice(0, MAX_THIRD_PARTY_PLUGINS);
}
