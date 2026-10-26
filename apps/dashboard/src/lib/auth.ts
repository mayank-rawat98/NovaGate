import { useSyncExternalStore } from 'react';

const TOKEN_KEY = 'gw_token';
const TENANT_KEY = 'gw_tenant_id';
const SESSION_EVENT = 'novagate-session-change';

function notifySessionChange() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(SESSION_EVENT));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getToken(): string | null {
  return safe(() => localStorage.getItem(TOKEN_KEY), null);
}

export function setToken(token: string): void {
  safe(() => localStorage.setItem(TOKEN_KEY, token), undefined);
  notifySessionChange();
}

export function clearToken(): void {
  safe(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TENANT_KEY);
  }, undefined);
  notifySessionChange();
}

export function getTenantId(): string | null {
  return safe(() => localStorage.getItem(TENANT_KEY), null);
}

export function setTenantId(id: string): void {
  safe(() => localStorage.setItem(TENANT_KEY, id), undefined);
  notifySessionChange();
}

export function isAuthenticated(): boolean {
  return getToken() !== null && getTenantId() !== null;
}

function subscribeSession(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(SESSION_EVENT, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(SESSION_EVENT, listener);
  };
}

/** Keep server and hydration snapshots identical; read the saved session only
 * after hydration and react to sign-in/out or changes from another tab. */
export function useTenantId(): string | null {
  return useSyncExternalStore(subscribeSession, getTenantId, () => null);
}
