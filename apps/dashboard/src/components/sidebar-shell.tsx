'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  LayoutDashboard,
  Route,
  Server,
  ScrollText,
  AlertTriangle,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  Layers3,
  ArrowUpRight,
} from 'lucide-react';
import { containDialogFocus } from './workspace-dialog';
import { GatewayStatusPill } from './gateway-status-pill';
import { isAuthenticated, useTenantId, clearToken } from '../lib/auth';
import { getGatewayStatus, getTenant } from '../lib/api-client';

const NAV_ITEMS = [
  {
    href: '/dashboard',
    label: 'Overview',
    icon: LayoutDashboard,
    group: 'Workspace',
  },
  { href: '/routes', label: 'Routes', icon: Route, group: 'Configuration' },
  {
    href: '/services',
    label: 'Services',
    icon: Server,
    group: 'Configuration',
  },
  {
    href: '/consumers',
    label: 'Consumers',
    icon: Users,
    group: 'Configuration',
  },
  {
    href: '/logs',
    label: 'Request logs',
    icon: ScrollText,
    group: 'Observability',
  },
  {
    href: '/errors',
    label: 'Errors',
    icon: AlertTriangle,
    group: 'Observability',
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    group: 'Workspace settings',
  },
];
const PROTECTED_PATHS = NAV_ITEMS.map((item) => item.href);
const SWR_OPTS = { refreshInterval: 30000 };

export function SidebarShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const isPublic = !PROTECTED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );

  const tenantId = useTenantId();

  useEffect(() => {
    if (!isPublic && !isAuthenticated()) router.replace('/login');
  }, [isPublic, router, tenantId]);
  useEffect(() => {
    dialog.current?.close();
  }, [pathname]);
  useEffect(() => {
    const closeOnDesktop = () => {
      if (window.innerWidth >= 768) dialog.current?.close();
    };
    window.addEventListener('resize', closeOnDesktop);
    return () => window.removeEventListener('resize', closeOnDesktop);
  }, []);

  const { data: status, error: statusError } = useSWR(
    tenantId && !isPublic ? `gateway-status-${tenantId}` : null,
    () => getGatewayStatus(tenantId as string),
    SWR_OPTS,
  );
  const { data: tenant } = useSWR(
    tenantId && !isPublic ? `tenant-${tenantId}` : null,
    () => getTenant(tenantId as string),
    SWR_OPTS,
  );
  function handleLogout() {
    dialog.current?.close();
    clearToken();
    router.replace('/login');
  }
  const currentPage =
    NAV_ITEMS.find((item) => pathname === item.href)?.label ?? 'Workspace';

  if (isPublic) return <>{children}</>;

  function navigation(mobile = false) {
    return (
      <>
        <Link
          href="/dashboard"
          className="nova-brand"
          aria-label="NovaGate overview"
          onClick={() => dialog.current?.close()}
        >
          <span className="nova-brand-mark" aria-hidden="true">
            <Layers3 size={23} />
          </span>
          <span>
            NovaGate
            <span className="nova-brand-caption">Your API workspace</span>
          </span>
        </Link>
        {mobile && (
          <button
            type="button"
            className="nova-menu-close"
            aria-label="Close navigation"
            onClick={() => dialog.current?.close()}
          >
            <X size={22} />
          </button>
        )}
        <div className="nova-workspace-card">
          <p className="nova-eyebrow">Workspace</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-900">
            {tenant?.name ?? 'Your workspace'}
          </p>
          <div className="mt-3">
            <GatewayStatusPill
              online={status?.online ?? false}
              degraded={false}
              state={
                !status ? (statusError ? 'unknown' : 'loading') : undefined
              }
            />
          </div>
        </div>
        <nav
          className="nova-navigation"
          aria-label={
            mobile ? 'Mobile workspace navigation' : 'Workspace navigation'
          }
        >
          {NAV_ITEMS.map(({ href, label, icon: Icon, group }, index) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <div key={href}>
                {(index === 0 || NAV_ITEMS[index - 1].group !== group) && (
                  <p className="nova-nav-group">{group}</p>
                )}
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => dialog.current?.close()}
                  className={`nova-nav-link ${active ? 'nova-nav-active' : ''}`}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                  {active && (
                    <span className="nova-nav-dot" aria-hidden="true" />
                  )}
                </Link>
              </div>
            );
          })}
        </nav>
        <div className="nova-sidebar-footer">
          <Link href="/api-reference" className="nova-docs-link">
            API documentation
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="nova-nav-link w-full"
          >
            <LogOut size={18} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="nova-workspace">
      <a href="#workspace-content" className="nova-skip-link">
        Skip to content
      </a>
      <aside className="nova-sidebar">{navigation()}</aside>
      <div className="nova-main-column">
        <header className="nova-mobile-header">
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="mobile-workspace-navigation"
            className="nova-menu-button"
            onClick={() => {
              dialog.current?.showModal();
              setMenuOpen(true);
            }}
          >
            <Menu size={22} />
          </button>
          <span className="font-semibold">
            NovaGate{' '}
            <span className="font-normal text-slate-500">/ {currentPage}</span>
          </span>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className="nova-main-content"
        >
          {children}
        </main>
      </div>
      <dialog
        id="mobile-workspace-navigation"
        ref={dialog}
        onKeyDown={containDialogFocus}
        className="nova-mobile-dialog"
        aria-label="Workspace navigation"
        onClose={() => setMenuOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {navigation(true)}
      </dialog>
    </div>
  );
}
