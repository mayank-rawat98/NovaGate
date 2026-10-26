//@ts-check

const { composePlugins, withNx } = require('@nx/next');

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:3001';

// Developers sign in here with credentials of their own, so the portal uses a
// strict policy: same-origin resources only and no framing.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next.js app-router hydration uses inline bootstrap scripts.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const nextConfig = {
  output: 'standalone',
  nx: {},
  poweredByHeader: false,
  // The proxy rewrites custom domains to /w/:tenant. Without this, Next gives
  // the proxy a localhost URL that differs from the bound HOSTNAME (0.0.0.0 in
  // containers), so every rewrite becomes an HTTP self-proxy that drops Host.
  skipProxyUrlNormalize: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    // Only the public portal API is reachable through this origin.
    return [
      {
        source: '/api/portal/:path*',
        destination: `${ADMIN_API_URL}/api/portal/:path*`,
      },
    ];
  },
};

module.exports = composePlugins(withNx)(nextConfig);
