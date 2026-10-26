'use client';
import { createContext, useContext } from 'react';

interface Portal {
  tenant: string;
  /** Link prefix: "" on a custom domain, "/w/<tenant>" on the shared host. */
  base: string;
  href: (path: string) => string;
}
const PortalContext = createContext<Portal | null>(null);

export function PortalProvider({
  tenant,
  base,
  children,
}: {
  tenant: string;
  base: string;
  children: React.ReactNode;
}) {
  const href = (path: string) => `${base}${path === '/' ? '' : path}` || '/';
  return (
    <PortalContext.Provider value={{ tenant, base, href }}>
      {children}
    </PortalContext.Provider>
  );
}

export function usePortal(): Portal {
  const portal = useContext(PortalContext);
  if (!portal) throw new Error('usePortal must be used inside PortalProvider');
  return portal;
}
