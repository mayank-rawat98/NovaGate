//@ts-check

const { composePlugins, withNx } = require('@nx/next');

/**
 * @type {import('@nx/next/plugins/with-nx').WithNxOptions}
 **/
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:3001';

const nextConfig = {
  output: 'standalone',
  nx: {},
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${ADMIN_API_URL}/api/:path*`,
      },
    ];
  },
};

const plugins = [
  // Add more Next.js plugins to this list if needed.
  withNx,
];

module.exports = composePlugins(...plugins)(nextConfig);
