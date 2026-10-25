'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { BookOpen, KeyRound, LineChart, LogOut } from 'lucide-react';
import { getCatalog } from '../lib/portal-api';
import { clearSession, useSession } from '../lib/session';
import { usePortal } from './portal-provider';

export function PortalShell({ children }: { children: React.ReactNode }) {
  const { tenant, href } = usePortal();
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession(tenant);
  const { data } = useSWR(
    ['portal-catalog', tenant],
    () => getCatalog(tenant),
    {
      refreshInterval: 30000,
    },
  );
  const links = [
    { path: '/', label: 'APIs', icon: BookOpen },
    { path: '/keys', label: 'Keys', icon: KeyRound },
    { path: '/usage', label: 'Usage', icon: LineChart },
  ];
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-xl focus:bg-white focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-indigo-100 bg-white/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Link
            href={href('/')}
            className="text-lg font-semibold text-indigo-950"
          >
            {data?.title ?? 'Developer portal'}
          </Link>
          <nav
            aria-label="Portal"
            className="flex flex-wrap items-center gap-1"
          >
            {links.map(({ path, label, icon: Icon }) => {
              const target = href(path);
              const current =
                path === '/'
                  ? pathname === target || pathname.includes('/docs/')
                  : pathname === target;
              return (
                <Link
                  key={path}
                  href={target}
                  aria-current={current ? 'page' : undefined}
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium ${
                    current
                      ? 'bg-indigo-100 text-indigo-950'
                      : 'text-slate-700 hover:bg-indigo-50'
                  }`}
                >
                  <Icon aria-hidden="true" size={16} />
                  {label}
                </Link>
              );
            })}
            {session ? (
              <button
                type="button"
                onClick={() => {
                  clearSession(tenant);
                  router.push(href('/'));
                }}
                className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50"
              >
                <LogOut aria-hidden="true" size={16} />
                Sign out
                <span className="sr-only"> {session.developer.email}</span>
              </button>
            ) : (
              <Link
                href={href('/login')}
                className="rounded-xl bg-indigo-700 px-3 py-2 text-sm font-medium text-white"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        {children}
      </main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 text-sm text-slate-600">
        Powered by NovaGate. Usage shows recorded request logs, not billing.
      </footer>
    </div>
  );
}
