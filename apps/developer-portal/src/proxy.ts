import { NextResponse, type NextRequest } from 'next/server';

/** Header the tenant layout reads to build links; never trusted from clients. */
export const MODE_HEADER = 'x-novagate-portal-mode';

const SHARED_HOSTS = new Set(
  (process.env.PORTAL_SHARED_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const ADMIN_API_URL = (
  process.env.ADMIN_API_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');
const CACHE_LIMIT = 1000;
const cache = new Map<string, { tenant: string | null; expires: number }>();

async function resolve(host: string): Promise<string | null> {
  const cached = cache.get(host);
  if (cached && cached.expires > Date.now()) return cached.tenant;
  let tenant: string | null = null;
  try {
    const response = await fetch(
      `${ADMIN_API_URL}/api/portal/resolve?host=${encodeURIComponent(host)}`,
      { signal: AbortSignal.timeout(2000), cache: 'no-store' },
    );
    if (response.ok) {
      const body = (await response.json()) as { tenantId?: unknown };
      if (
        typeof body.tenantId === 'string' &&
        /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(body.tenantId)
      )
        tenant = body.tenantId;
    } else if (response.status !== 404) {
      // Do not cache transient failures as "unknown portal".
      return null;
    }
  } catch {
    return null;
  }
  if (cache.size >= CACHE_LIMIT)
    cache.delete(cache.keys().next().value as string);
  cache.set(host, {
    tenant,
    expires: Date.now() + (tenant ? 60000 : 30000),
  });
  return tenant;
}

/**
 * Custom portal domains serve one workspace at their root. The shared portal
 * host serves every workspace under /w/:tenantId.
 */
export async function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(MODE_HEADER);
  const host = (request.headers.get('host') ?? '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  const { pathname } = request.nextUrl;
  if (SHARED_HOSTS.has(host))
    return NextResponse.next({ request: { headers } });
  // A custom domain never exposes other workspaces' shared-host paths.
  const tenant = pathname.startsWith('/w/') ? null : await resolve(host);
  if (!tenant)
    return NextResponse.rewrite(new URL('/portal-not-found', request.url), {
      request: { headers },
    });
  // Empty header values do not survive the rewrite, so send an explicit mode.
  headers.set(MODE_HEADER, 'domain');
  const target = new URL(
    `/w/${tenant}${pathname === '/' ? '' : pathname}${request.nextUrl.search}`,
    request.url,
  );
  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
};
