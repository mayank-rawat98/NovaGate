const TOKEN_KEY = 'gw_token';
const TENANT_KEY = 'gw_tenant_id';

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export function getToken(): string | null {
  return safe(() => localStorage.getItem(TOKEN_KEY), null);
}

export function setToken(token: string): void {
  safe(() => localStorage.setItem(TOKEN_KEY, token), undefined);
}

export function clearToken(): void {
  safe(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TENANT_KEY);
  }, undefined);
}

export function getTenantId(): string | null {
  return safe(() => localStorage.getItem(TENANT_KEY), null);
}

export function setTenantId(id: string): void {
  safe(() => localStorage.setItem(TENANT_KEY, id), undefined);
}

export function isAuthenticated(): boolean {
  return getToken() !== null && getTenantId() !== null;
}
