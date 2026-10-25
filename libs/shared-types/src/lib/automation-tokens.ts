/**
 * Workspace automation tokens authenticate the CLI, Terraform and CI against
 * the admin API. A token carries explicit operation scopes; `<area>:write`
 * also grants `<area>:read`. Tokens never manage tokens, workspace keys,
 * privacy/retention, export destinations or alert channel credentials.
 */
export const AUTOMATION_TOKEN_SCOPES = [
  'workspace:read',
  'routes:read',
  'routes:write',
  'services:read',
  'services:write',
  'consumers:read',
  'consumers:write',
  'config:read',
  'config:write',
  'logs:read',
  'analytics:read',
  'analytics:write',
  'alerts:read',
  'alerts:write',
] as const;
export type AutomationTokenScope = (typeof AUTOMATION_TOKEN_SCOPES)[number];

/** Opaque bearer prefix; the remainder is 32 random bytes in base64url. */
export const AUTOMATION_TOKEN_PREFIX = 'ngat_';
export const AUTOMATION_TOKEN_NAME_MAX = 64;
export const MAX_ACTIVE_AUTOMATION_TOKENS = 50;
export const DEFAULT_AUTOMATION_TOKEN_DAYS = 90;
export const MAX_AUTOMATION_TOKEN_DAYS = 365;

export interface AutomationTokenSummary {
  id: string;
  name: string;
  scopes: AutomationTokenScope[];
  /** First characters of the secret, for recognising a token in a store. */
  displayPrefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateAutomationToken {
  name: string;
  scopes: AutomationTokenScope[];
  /** Whole days until expiry; defaults to 90, at most 365. */
  expiresInDays?: number;
}

/** Returned once from creation; the secret is never stored or shown again. */
export interface CreatedAutomationToken extends AutomationTokenSummary {
  token: string;
}

export function isAutomationTokenScope(
  value: unknown,
): value is AutomationTokenScope {
  return (
    typeof value === 'string' &&
    (AUTOMATION_TOKEN_SCOPES as readonly string[]).includes(value)
  );
}

/** True when granted scopes satisfy the required one (write implies read). */
export function automationScopeAllows(
  granted: readonly string[],
  required: AutomationTokenScope,
): boolean {
  if (granted.includes(required)) return true;
  const [area, action] = required.split(':');
  return action === 'read' && granted.includes(`${area}:write`);
}
