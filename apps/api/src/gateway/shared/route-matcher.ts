import type { RouteConfig } from '@api-gateway/shared-types';

export function matchRoute(
  method: string,
  path: string,
  routes: RouteConfig[],
): RouteConfig | undefined {
  return routes.find((route) => {
    if (!route.enabled) return false;
    const methodMatches =
      route.method.toUpperCase() === 'ANY' ||
      route.method.toUpperCase() === method.toUpperCase();
    if (!methodMatches) return false;
    const pattern = route.pathPattern;
    if (pattern === '/') return true;
    return path === pattern || path.startsWith(`${pattern}/`);
  });
}
