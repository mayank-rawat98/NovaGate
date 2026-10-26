'use client';
import Link from 'next/link';
import { useSessionToken } from '../lib/session';
import { usePortal } from './portal-provider';

export function RequireSession({ children }: { children: React.ReactNode }) {
  const { tenant, href } = usePortal();
  const token = useSessionToken(tenant);
  if (!token)
    return (
      <section className="mx-auto max-w-md rounded-3xl border border-indigo-100 bg-white p-6">
        <h1 className="text-2xl font-semibold text-slate-900">
          Sign in to continue
        </h1>
        <p className="mt-3 text-slate-700">
          Keys and usage belong to your developer account.
        </p>
        <div className="mt-4 flex gap-3">
          <Link
            href={href('/login')}
            className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white"
          >
            Sign in
          </Link>
          <Link
            href={href('/register')}
            className="rounded-xl border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-900"
          >
            Create account
          </Link>
        </div>
      </section>
    );
  return <>{children}</>;
}
