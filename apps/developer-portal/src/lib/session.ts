import { useSyncExternalStore } from 'react';
import type { PortalDeveloperSession } from '@api-gateway/shared-types';

const EVENT = 'novagate-portal-session';
const key = (tenant: string) => `novagate.portal.session.${tenant}`;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Sessions are per workspace portal and expire with the server session. */
export function getSession(tenant: string): PortalDeveloperSession | null {
  return safe(() => {
    const raw = localStorage.getItem(key(tenant));
    if (!raw) return null;
    const session = JSON.parse(raw) as PortalDeveloperSession;
    if (
      typeof session.token !== 'string' ||
      !(Date.parse(session.expiresAt) > Date.now())
    ) {
      localStorage.removeItem(key(tenant));
      return null;
    }
    return session;
  }, null);
}

export function saveSession(tenant: string, session: PortalDeveloperSession) {
  safe(
    () => localStorage.setItem(key(tenant), JSON.stringify(session)),
    undefined,
  );
  window.dispatchEvent(new Event(EVENT));
}

export function clearSession(tenant: string) {
  safe(() => localStorage.removeItem(key(tenant)), undefined);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(EVENT, listener);
  };
}

/**
 * Server and first client render agree on "signed out"; the stored session is
 * read after hydration. Snapshots are compared by token string.
 */
export function useSessionToken(tenant: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => getSession(tenant)?.token ?? null,
    () => null,
  );
}
export function useSession(tenant: string): PortalDeveloperSession | null {
  const token = useSessionToken(tenant);
  return token ? getSession(tenant) : null;
}
