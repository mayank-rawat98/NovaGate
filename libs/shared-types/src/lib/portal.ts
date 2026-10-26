/**
 * Developer portal contracts. A workspace publishes selected routes to its
 * own API consumers ("developers"), who register, create their own gateway
 * keys and read their own usage. Developers never receive workspace access.
 */

/** Route metadata stored with the route; the gateway ignores it. */
export interface RoutePortalMetadata {
  visible: boolean;
  /** One-line summary shown in the catalog. */
  summary?: string;
  /** Plain-text documentation; rendered as text, never HTML. */
  description?: string;
}
export const PORTAL_SUMMARY_MAX = 160;
export const PORTAL_DESCRIPTION_MAX = 4000;
export const PORTAL_TITLE_MAX = 80;
export const MAX_PORTAL_KEYS_PER_DEVELOPER = 25;
export const DEFAULT_PORTAL_KEYS_PER_DEVELOPER = 5;
export const MAX_PORTAL_DEVELOPERS = 10000;
export const PORTAL_DEVELOPER_SESSION_HOURS = 12;

export type PortalSignup = 'open' | 'closed';

export interface PortalSettings {
  enabled: boolean;
  title: string;
  /** Lowercase host such as portal.example.com; null uses the shared portal host. */
  customDomain: string | null;
  /** Public HTTPS origin of the workspace's gateway, used in examples. */
  apiBaseUrl: string | null;
  signup: PortalSignup;
  /** Consumer groups given to every developer key (feeds the acl plugin). */
  defaultGroups: string[];
  maxKeysPerDeveloper: number;
  revision: string;
  updatedAt: string | null;
}
export type SavePortalSettings = Omit<
  PortalSettings,
  'revision' | 'updatedAt'
> & {
  expectedRevision: string;
};

/** How a caller authenticates, derived from the route's enforced policy. */
export type PortalAuthMethod =
  | 'api-key'
  | 'basic'
  | 'oidc'
  | 'oauth2'
  | 'hmac'
  | 'mtls';

export interface PortalCatalogRoute {
  id: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  auth: PortalAuthMethod[];
  /** Effective enforced per-client limit, or null when none is configured. */
  rateLimit: { requests: number; windowMs: number } | null;
  /** True when an acl plugin restricts access by consumer group. */
  groupRestricted: boolean;
}
export interface PortalCatalog {
  tenantId: string;
  title: string;
  apiBaseUrl: string | null;
  signup: PortalSignup;
  routes: PortalCatalogRoute[];
}

export type PortalDeveloperStatus = 'pending' | 'active' | 'suspended';
export interface PortalDeveloper {
  id: string;
  email: string;
  name: string;
  status: PortalDeveloperStatus;
  createdAt: string;
  lastLoginAt: string | null;
  activeKeys: number;
}
export interface PortalDeveloperProfile {
  id: string;
  email: string;
  name: string;
}
export interface PortalDeveloperSession {
  token: string;
  expiresAt: string;
  developer: PortalDeveloperProfile;
}
export interface PortalKey {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}
/** Returned once from creation; the key is never stored or shown again. */
export interface CreatedPortalKey extends PortalKey {
  apiKey: string;
}
