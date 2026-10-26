import type {
  ConsumerAnalyticsPeriod,
  ConsumerUsageStats,
  CreatedPortalKey,
  PortalCatalog,
  PortalCatalogRoute,
  PortalDeveloperProfile,
  PortalDeveloperSession,
  PortalKey,
} from '@api-gateway/shared-types';
import { clearSession, getSession } from './session';

export class PortalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/** Same-origin calls; the portal origin proxies only /api/portal/*. */
async function request<T>(
  tenant: string,
  path: string,
  init: RequestInit & { authenticated?: boolean } = {},
): Promise<T> {
  if (!UUID.test(tenant)) throw new PortalApiError('Portal not found', 404);
  const { authenticated, ...rest } = init;
  const session = authenticated ? getSession(tenant) : null;
  if (authenticated && !session)
    throw new PortalApiError('Sign in to continue.', 401);
  const response = await fetch(`/api/portal/${tenant}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...rest.headers,
    },
  });
  if (response.status === 401 && authenticated) clearSession(tenant);
  if (!response.ok) {
    let message = `Request failed (HTTP ${response.status}). Please try again.`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* keep the generic message */
    }
    throw new PortalApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const getCatalog = (tenant: string) =>
  request<PortalCatalog>(tenant, '/catalog');
export const getCatalogEntry = (tenant: string, routeId: string) =>
  request<PortalCatalogRoute>(
    tenant,
    `/catalog/${encodeURIComponent(routeId)}`,
  );
export const register = (
  tenant: string,
  input: { email: string; name: string; password: string },
) =>
  request<{ message: string }>(tenant, '/developers/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const verifyEmail = (tenant: string, token: string) =>
  request<PortalDeveloperSession>(tenant, '/developers/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
export const login = (
  tenant: string,
  input: { email: string; password: string },
) =>
  request<PortalDeveloperSession>(tenant, '/developers/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
export const getProfile = (tenant: string) =>
  request<PortalDeveloperProfile>(tenant, '/me', { authenticated: true });
export const getKeys = (tenant: string) =>
  request<PortalKey[]>(tenant, '/me/keys', { authenticated: true });
export const createKey = (tenant: string, name: string, signal?: AbortSignal) =>
  request<CreatedPortalKey>(tenant, '/me/keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
    authenticated: true,
    signal,
  });
export const revokeKey = (tenant: string, id: string, signal?: AbortSignal) =>
  request<PortalKey>(tenant, `/me/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    authenticated: true,
    signal,
  });
export const getUsage = (
  tenant: string,
  id: string,
  period: ConsumerAnalyticsPeriod,
) =>
  request<ConsumerUsageStats>(
    tenant,
    `/me/keys/${encodeURIComponent(id)}/usage?period=${period}`,
    { authenticated: true },
  );
