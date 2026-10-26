'use strict';

/**
 * Deliberately misbehaving plugin used to verify gateway isolation.
 * x-crash-mode: timer  -> throws from a timer after the hook returns
 *               reject -> leaves an unhandled rejection behind
 *               throw  -> throws inside the hook
 *               hang   -> never settles
 */
module.exports = {
  name: '@novagate-examples/crash-on-request',
  async onRequest(ctx) {
    const mode = ctx.req.headers['x-crash-mode'];
    if (mode === 'timer')
      setTimeout(() => {
        throw new Error('plugin timer crash');
      }, 5);
    if (mode === 'reject')
      Promise.reject(new Error('plugin unhandled rejection'));
    if (mode === 'throw') throw new Error('plugin hook failure');
    if (mode === 'hang') return new Promise(() => undefined);
  },
};
