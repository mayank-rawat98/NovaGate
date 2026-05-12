'use client';

import { useEffect } from 'react';
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
} from 'lucide-react';
import { GatewayStatusPill } from './gateway-status-pill';
import { isAuthenticated, getTenantId, clearToken } from '../lib/auth';
import { getGatewayStatus } from '../lib/api-client';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/routes', label: 'Routes', icon: Route },
  { href: '/services', label: 'Services', icon: Server },
  { href: '/logs', label: 'Logs', icon: ScrollText },
  { href: '/errors', label: 'Errors', icon: AlertTriangle },
  { href: '/consumers', label: 'Consumers', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

// Paths that require authentication — everything else is public
const PROTECTED_PATHS = ['/dashboard', '/routes', '/services', '/logs', '/errors', '/consumers', '/settings'];

export function SidebarShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = !PROTECTED_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  useEffect(() => {
    if (!isPublic && !isAuthenticated()) {
      router.replace('/login');
    }
  }, [isPublic, router]);

  const tenantId = getTenantId();
  const { data: status } = useSWR(
    tenantId && !isPublic ? `gateway-status-${tenantId}` : null,
    () => getGatewayStatus(tenantId!),
    { refreshInterval: 10000 },
  );

  function handleLogout() {
    clearToken();
    router.replace('/login');
  }

  if (isPublic) return <>{children}</>;

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
        <div className="flex flex-col gap-2 border-b border-gray-200 px-4 py-4">
          <span className="text-sm font-semibold text-gray-900">API Gateway</span>
          <GatewayStatusPill online={status?.online ?? false} degraded={false} />
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-gray-200 px-2 py-3">
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-red-50 hover:text-red-700"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
