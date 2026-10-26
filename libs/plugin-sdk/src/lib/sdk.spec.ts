import { createMockContext, definePlugin, runPlugin } from '../index.ts';

describe('plugin SDK', () => {
  it('validates plugins with the gateway loader rules', () => {
    expect(() =>
      definePlugin({ name: 'cors', onRequest: async () => undefined }),
    ).toThrow('scoped npm package name');
    expect(() => definePlugin({ name: '@acme/no-hooks' })).toThrow(
      'at least one hook',
    );
    expect(() =>
      definePlugin({
        name: '@acme/bad-hook',
        onRequest: 'yes' as never,
      }),
    ).toThrow('onRequest must be a function');
    expect(() =>
      definePlugin({
        name: '@acme/bad-protocol',
        protocols: ['smtp' as never],
        onRequest: async () => undefined,
      }),
    ).toThrow('protocols');
    const plugin = definePlugin({
      name: '@acme/ok',
      onRequest: async () => undefined,
    });
    expect(plugin.name).toBe('@acme/ok');
  });

  it('builds contexts from real HTTP objects with readable bodies', async () => {
    const ctx = createMockContext({
      method: 'post',
      url: '/users?limit=1',
      headers: { 'X-Api-Version': '2' },
      body: '{"name":"Dana"}',
      route: {
        pathPattern: '/users',
        plugins: [{ name: '@acme/x', config: { a: 1 } }],
      },
    });
    expect(ctx.req.method).toBe('POST');
    expect(ctx.req.headers['x-api-version']).toBe('2');
    expect(ctx.route.plugins?.[0].config).toEqual({ a: 1 });
    let body = '';
    for await (const chunk of ctx.req) body += chunk;
    expect(body).toBe('{"name":"Dana"}');
    ctx.res.setHeader('x-test', '1');
    expect(ctx.res.getHeader('x-test')).toBe('1');
    expect(ctx.requestId).toMatch(/^[\da-f-]{36}$/);
  });

  it('runs hooks in gateway order and stops at a short-circuit', async () => {
    const calls: string[] = [];
    const plugin = definePlugin({
      name: '@acme/guard',
      async prepareRequest() {
        calls.push('prepare');
      },
      async onRequest(ctx) {
        calls.push('request');
        ctx.logger.info('checking', { path: ctx.req.url });
        if (!ctx.req.headers['x-key'])
          return { status: 401, body: 'missing key' };
        return undefined;
      },
      async validateRequest() {
        calls.push('validate');
      },
      async onResponse(ctx) {
        ctx.res.setHeader('x-guarded', String(ctx.statusCode));
      },
    });
    const denied = createMockContext();
    const result = await runPlugin(plugin, denied);
    expect(result).toEqual({
      shortCircuit: { status: 401, body: 'missing key' },
      phase: 'onRequest',
      ran: ['prepareRequest', 'onRequest'],
    });
    expect(denied.logs).toEqual([
      { level: 'info', msg: 'checking', meta: { path: '/test' } },
    ]);
    const allowed = createMockContext({ headers: { 'x-key': 'k' } });
    const passed = await runPlugin(plugin, allowed, { statusCode: 204 });
    expect(passed.ran).toEqual([
      'prepareRequest',
      'onRequest',
      'validateRequest',
      'onResponse',
    ]);
    expect(allowed.res.getHeader('x-guarded')).toBe('204');
    expect(calls).toEqual([
      'prepare',
      'request',
      'prepare',
      'request',
      'validate',
    ]);
  });

  it('runs onError instead of onResponse for upstream failures', async () => {
    const plugin = definePlugin({
      name: '@acme/errors',
      async onResponse() {
        throw new Error('should not run');
      },
      async onError(ctx) {
        return { status: 503, body: `unavailable: ${ctx.error.message}` };
      },
    });
    const result = await runPlugin(plugin, createMockContext(), {
      error: new Error('timeout'),
      statusCode: 200,
    });
    expect(result).toMatchObject({
      phase: 'onError',
      shortCircuit: { status: 503, body: 'unavailable: timeout' },
    });
  });
});
