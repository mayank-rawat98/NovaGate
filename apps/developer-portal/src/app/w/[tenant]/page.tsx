'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { getCatalog } from '../../../lib/portal-api';
import { usePortal } from '../../../components/portal-provider';
import {
  AuthList,
  MethodBadge,
  formatLimit,
} from '../../../components/route-details';
import { LoadNotice } from '../../../components/load-notice';

export default function CatalogPage() {
  const { tenant, href } = usePortal();
  const { data, error, mutate } = useSWR(
    ['portal-catalog', tenant],
    () => getCatalog(tenant),
    { refreshInterval: 30000 },
  );
  return (
    <>
      <h1 className="text-3xl font-semibold text-slate-900">
        {data?.title ?? 'APIs'}
      </h1>
      <p className="mt-2 max-w-2xl text-slate-700">
        Browse published endpoints, then create a key to call them.
      </p>
      {error && (
        <LoadNotice
          message={
            error.status === 404
              ? 'This portal is not published.'
              : 'The API catalog could not be loaded.'
          }
          onRetry={error.status === 404 ? undefined : () => mutate()}
        />
      )}
      {!data && !error && (
        <p role="status" className="mt-6 text-slate-700">
          Loading APIs…
        </p>
      )}
      {data && data.routes.length === 0 && (
        <p className="mt-6 text-slate-700">No APIs are published yet.</p>
      )}
      {data && data.routes.length > 0 && (
        <ul className="mt-6 grid gap-3" aria-label="Published APIs">
          {data.routes.map((route) => (
            <li
              key={route.id}
              className="rounded-2xl border border-indigo-100 bg-white p-4 shadow-[0_6px_20px_rgba(70,60,120,0.06)]"
            >
              <div className="flex flex-wrap items-center gap-3">
                <MethodBadge method={route.method} />
                <Link
                  href={href(`/docs/${route.id}`)}
                  className="font-mono text-base font-medium text-indigo-950 underline-offset-4 hover:underline"
                >
                  {route.path}
                  <span className="sr-only">
                    {' '}
                    ({route.method}) documentation
                  </span>
                </Link>
              </div>
              {route.summary && (
                <p className="mt-2 text-slate-700">{route.summary}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-700">
                <AuthList route={route} />
                <span>{formatLimit(route.rateLimit)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
