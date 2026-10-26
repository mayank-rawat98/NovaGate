'use strict';

/**
 * Adds x-plugin-stamp to the upstream request and the client response.
 * Route config: { "value": "<text>" }. Requests without a valid value fail
 * closed, so misconfiguration is visible.
 */
function stampFor(ctx) {
  const entry = (ctx.route.plugins || []).find(
    (plugin) => plugin.name === '@novagate-examples/header-stamp',
  );
  const value = entry && entry.config && entry.config.value;
  return typeof value === 'string' && /^[\w.-]{1,64}$/.test(value)
    ? value
    : undefined;
}

module.exports = {
  name: '@novagate-examples/header-stamp',
  protocols: ['http'],
  async onRequest(ctx) {
    const stamp = stampFor(ctx);
    if (!stamp)
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'STAMP_NOT_CONFIGURED',
          requestId: ctx.requestId,
        }),
      };
    ctx.req.headers['x-plugin-stamp'] = stamp;
    ctx.logger.info('stamped request', { stamp });
  },
  async onResponse(ctx) {
    const stamp = stampFor(ctx);
    if (stamp) ctx.res.setHeader('x-plugin-stamp', stamp);
  },
};
