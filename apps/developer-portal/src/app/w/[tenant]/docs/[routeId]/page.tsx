'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { getCatalog, getCatalogEntry } from '../../../../../lib/portal-api';
import { usePortal } from '../../../../../components/portal-provider';
import {
  AUTH_LABELS,
  AuthList,
  MethodBadge,
  formatLimit,
} from '../../../../../components/route-details';
import { LoadNotice } from '../../../../../components/load-notice';

/** Gateway route patterns use :name segments; examples show them as placeholders. */
function examplePath(path: string) {
  return path.replace(/:([A-Za-z_][\w]*)/g, '{$1}');
}

export default function RouteDocsPage() {
  const { tenant, href } = usePortal();
  const { routeId } = useParams<{ routeId: string }>();
  const {
    data: route,
    error,
    mutate,
  } = useSWR(['portal-route', tenant, routeId], () =>
    getCatalogEntry(tenant, routeId),
  );
  const { data: catalog } = useSWR(['portal-catalog', tenant], () =>
    getCatalog(tenant),
  );
  const origin = catalog?.apiBaseUrl ?? 'https://YOUR-GATEWAY';
  return (
    <>
      <Link
        href={href('/')}
        className="text-sm font-medium text-indigo-800 underline"
      >
        ← All APIs
      </Link>
      {error && (
        <LoadNotice
          message={
            error.status === 404
              ? 'This API is not published.'
              : 'This API could not be loaded.'
          }
          onRetry={error.status === 404 ? undefined : () => mutate()}
        />
      )}
      {!route && !error && (
        <p role="status" className="mt-6 text-slate-700">
          Loading documentation…
        </p>
      )}
      {route && (
        <article className="mt-4">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-slate-900">
            <MethodBadge method={route.method} />
            <span className="font-mono">{route.path}</span>
          </h1>
          {route.summary && (
            <p className="mt-3 text-lg text-slate-700">{route.summary}</p>
          )}
          {route.description && (
            <p className="mt-4 whitespace-pre-wrap text-slate-800">
              {route.description}
            </p>
          )}
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-white p-4">
              <dt className="text-sm text-slate-600">Authentication</dt>
              <dd className="mt-2">
                <AuthList route={route} />
              </dd>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <dt className="text-sm text-slate-600">Rate limit</dt>
              <dd className="mt-2 text-slate-900">
                {formatLimit(route.rateLimit)}
              </dd>
            </div>
          </dl>
          {route.groupRestricted && (
            <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              Access depends on your key&apos;s groups. If calls are refused
              with 403, ask the API provider to grant access.
            </p>
          )}
          <h2 className="mt-8 text-lg font-semibold text-slate-900">
            Example request
          </h2>
          <pre
            className="mt-3 overflow-x-auto rounded-2xl bg-slate-900 p-4 text-sm text-slate-50"
            tabIndex={0}
          >
            <code>
              {`curl -X ${route.method === 'ANY' ? 'GET' : route.method} '${origin}${examplePath(route.path)}'`}
              {route.auth.includes('api-key')
                ? ` \\\n  -H 'Authorization: Bearer YOUR_API_KEY'`
                : ''}
            </code>
          </pre>
          {route.auth.includes('api-key') && (
            <p className="mt-3 text-sm text-slate-700">
              Create a key on the{' '}
              <Link href={href('/keys')} className="font-medium underline">
                Keys
              </Link>{' '}
              page and send it as a bearer token.
            </p>
          )}
          {route.auth
            .filter((method) => method !== 'api-key')
            .map((method) => (
              <p key={method} className="mt-2 text-sm text-slate-700">
                Also requires: {AUTH_LABELS[method]}. Your API provider supplies
                these credentials separately.
              </p>
            ))}
        </article>
      )}
    </>
  );
}
