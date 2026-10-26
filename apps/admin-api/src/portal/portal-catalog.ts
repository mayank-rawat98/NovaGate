import { BadRequestException } from '@nestjs/common';
import {
  PORTAL_DESCRIPTION_MAX,
  isThirdPartyPluginName,
  PORTAL_SUMMARY_MAX,
  type PortalAuthMethod,
  type PortalCatalogRoute,
  type RoutePortalMetadata,
} from '@api-gateway/shared-types';

/** Gateway default for RATE_LIMIT_WINDOW_MS, used by route rate-limit overrides. */
export const DEFAULT_GATEWAY_WINDOW_MS = 60000;

// Line breaks and tabs are allowed in descriptions; other controls are not.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Validates route portal metadata. Returns undefined when absent so callers
 * can distinguish "leave unchanged" from an explicit null (unpublished).
 */
export function validateRoutePortal(
  value: unknown,
): RoutePortalMetadata | null | undefined {
  if (value === undefined || value === null) return value;
  const fail = () => {
    throw new BadRequestException(
      `Portal metadata needs visible (true/false), an optional summary of at most ${PORTAL_SUMMARY_MAX} characters and an optional plain-text description of at most ${PORTAL_DESCRIPTION_MAX} characters`,
    );
  };
  if (typeof value !== 'object' || Array.isArray(value)) fail();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['visible', 'summary', 'description'].includes(key),
    ) ||
    typeof input.visible !== 'boolean'
  )
    fail();
  const metadata: RoutePortalMetadata = { visible: input.visible as boolean };
  for (const [field, max] of [
    ['summary', PORTAL_SUMMARY_MAX],
    ['description', PORTAL_DESCRIPTION_MAX],
  ] as const) {
    const text = input[field];
    if (text === undefined || text === '') continue;
    if (
      typeof text !== 'string' ||
      text.length > max ||
      CONTROL.test(text) ||
      (field === 'summary' && /[\r\n]/.test(text))
    )
      fail();
    metadata[field] = text as string;
  }
  return metadata;
}

interface RouteRow {
  id: string;
  method: string;
  pathPattern: string;
  authRequired: boolean | null;
  rateLimitOverride: number | null;
  plugins: Array<{ name: string; config: Record<string, unknown> }> | null;
  portal: RoutePortalMetadata | null;
}

/**
 * Public projection: describes how to call a route from its enforced policy.
 * Never includes upstream services, plugin configuration or credentials.
 */
export function catalogRoute(row: RouteRow): PortalCatalogRoute {
  const plugins = row.plugins ?? [];
  const auth = new Set<PortalAuthMethod>();
  if (row.authRequired) auth.add('api-key');
  for (const plugin of plugins) {
    if (plugin.name === 'basic-auth') auth.add('basic');
    else if (plugin.name === 'oidc') auth.add('oidc');
    else if (plugin.name === 'hmac-auth') auth.add('hmac');
    else if (plugin.name === 'mtls') auth.add('mtls');
    // Outbound client-credentials mode authenticates the gateway, not callers.
    else if (
      plugin.name === 'oauth2-client-credentials' &&
      typeof plugin.config?.introspectionEndpoint === 'string'
    )
      auth.add('oauth2');
  }
  const limiter = plugins.find((plugin) => plugin.name === 'rate-limit');
  const max = limiter?.config?.max;
  const window = limiter?.config?.windowMs;
  const rateLimit =
    typeof max === 'number' && Number.isSafeInteger(max) && max > 0
      ? {
          requests: max,
          windowMs:
            typeof window === 'number' &&
            Number.isSafeInteger(window) &&
            window >= 1 &&
            window <= 3600000
              ? window
              : DEFAULT_GATEWAY_WINDOW_MS,
        }
      : typeof row.rateLimitOverride === 'number' && row.rateLimitOverride > 0
        ? {
            requests: row.rateLimitOverride,
            windowMs: DEFAULT_GATEWAY_WINDOW_MS,
          }
        : null;
  return {
    id: row.id,
    method: row.method,
    path: row.pathPattern,
    summary: row.portal?.summary ?? null,
    description: row.portal?.description ?? null,
    auth: [...auth],
    rateLimit,
    groupRestricted: plugins.some((plugin) => plugin.name === 'acl'),
    customPolicies: plugins.some((plugin) =>
      isThirdPartyPluginName(plugin.name),
    ),
  };
}

export const CATALOG_COLUMNS = `id,method,"pathPattern","authRequired","rateLimitOverride",plugins,portal`;
export const CATALOG_FILTER = `"deletedAt" IS NULL AND enabled = true AND (portal->>'visible')::boolean IS TRUE`;
export const CATALOG_ORDER = `"configOrder" NULLS LAST,"createdAt",id`;
