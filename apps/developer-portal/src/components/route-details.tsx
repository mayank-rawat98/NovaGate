import type {
  PortalAuthMethod,
  PortalCatalogRoute,
} from '@api-gateway/shared-types';

export const AUTH_LABELS: Record<PortalAuthMethod, string> = {
  'api-key': 'API key',
  basic: 'HTTP Basic',
  oidc: 'OpenID Connect token',
  oauth2: 'OAuth 2.0 access token',
  hmac: 'HMAC signature',
  mtls: 'Client certificate',
};

export function MethodBadge({ method }: { method: string }) {
  return (
    <span className="inline-block min-w-16 rounded-lg bg-indigo-900 px-2 py-1 text-center font-mono text-xs font-semibold text-white">
      {method}
    </span>
  );
}

export function formatLimit(limit: PortalCatalogRoute['rateLimit']) {
  if (!limit) return 'No route-specific limit published';
  const seconds = limit.windowMs / 1000;
  const window =
    seconds === 60
      ? 'minute'
      : seconds === 3600
        ? 'hour'
        : seconds === 1
          ? 'second'
          : `${seconds} seconds`;
  return `${limit.requests.toLocaleString()} requests per ${window}`;
}

export function AuthList({ route }: { route: PortalCatalogRoute }) {
  if (!route.auth.length)
    return <span className="text-slate-700">No authentication</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {route.auth.map((method) => (
        <li
          key={method}
          className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900"
        >
          {AUTH_LABELS[method]}
        </li>
      ))}
    </ul>
  );
}
