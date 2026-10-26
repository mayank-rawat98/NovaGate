import { ConfigService } from '@nestjs/config';
import type { PluginContext, GraphqlPolicy } from '@api-gateway/shared-types';
import { GraphqlGuardPlugin } from './graphql-guard.plugin';

function context(
  payload: unknown,
  policy: GraphqlPolicy | undefined = {},
  method = 'POST',
  contentType = 'application/json',
): PluginContext {
  return {
    req: {
      method,
      url: '/graphql',
      headers: { 'content-type': contentType },
      rawBody: Buffer.from(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      ),
      requestId: 'fixture',
    } as unknown as PluginContext['req'],
    res: {} as PluginContext['res'],
    route: {
      id: 'route',
      method: 'ANY',
      pathPattern: '/graphql',
      serviceId: 'service',
      enabled: true,
      authRequired: false,
      graphql: policy,
    },
    tenantId: 'tenant',
    requestId: 'fixture',
    service: undefined,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}
const code = (result: { body: string | Buffer } | void) =>
  result && JSON.parse(result.body.toString()).error;
describe('GraphQL guard policies and transports', () => {
  let plugin: GraphqlGuardPlugin;
  beforeEach(() => {
    plugin = new GraphqlGuardPlugin(new ConfigService({}));
  });
  it('passes ordinary routes and accepts valid depth/cost bounded queries', async () => {
    const ordinary = context({ query: '{ user { id } }' });
    ordinary.route.graphql = undefined;
    expect(await plugin.onRequest(ordinary)).toBeUndefined();
    expect(
      await plugin.onRequest(
        context(
          { query: '{ user { id } }' },
          { maxDepth: 2, maxComplexity: 3 },
        ),
      ),
    ).toBeUndefined();
  });
  it('guards plugin-only policies rather than silently ignoring them', async () => {
    const ctx = context({ query: '{ a { b { c } } }' });
    ctx.route.graphql = undefined;
    ctx.route.plugins = [{ name: 'graphql-guard', config: { maxDepth: 2 } }];
    expect(code(await plugin.onRequest(ctx))).toBe('GRAPHQL_DEPTH_EXCEEDED');
  });
  it('honors explicit larger limits without weakening them through the auto-injected empty plugin', async () => {
    const ctx = context(
      { query: '{ a { b { c } } }' },
      { maxDepth: 20, maxComplexity: 2000 },
    );
    ctx.route.plugins = [{ name: 'graphql-guard', config: {} }];
    expect(await plugin.onRequest(ctx)).toBeUndefined();
  });
  it('applies the stricter explicit route/plugin policy', async () => {
    const ctx = context({ query: '{ a { b { c } } }' }, { maxDepth: 10 });
    ctx.route.plugins = [{ name: 'graphql-guard', config: { maxDepth: 2 } }];
    expect(code(await plugin.onRequest(ctx))).toBe('GRAPHQL_DEPTH_EXCEEDED');
  });
  it('blocks nested fragments, aliases and expanded cost', async () => {
    expect(
      code(
        await plugin.onRequest(
          context(
            {
              query: '{ root { ...A } } fragment A on Node { child { value } }',
            },
            { maxDepth: 2 },
          ),
        ),
      ),
    ).toBe('GRAPHQL_DEPTH_EXCEEDED');
    expect(
      code(
        await plugin.onRequest(
          context(
            { query: '{ one: user { id } two: user { id } }' },
            { maxComplexity: 5 },
          ),
        ),
      ),
    ).toBe('GRAPHQL_COMPLEXITY_EXCEEDED');
  });
  it('blocks actual introspection but permits __typename and introspection-like aliases', async () => {
    expect(
      code(
        await plugin.onRequest(
          context({
            query:
              '{ ...A } fragment A on Query { hidden: __schema { types { name } } }',
          }),
        ),
      ),
    ).toBe('GRAPHQL_INTROSPECTION_DISABLED');
    expect(
      await plugin.onRequest(
        context({ query: '{ __schema: user { __typename id } }' }),
      ),
    ).toBeUndefined();
    expect(
      await plugin.onRequest(
        context(
          { query: '{ __schema { types { name } } }' },
          { introspectionAllowed: true },
        ),
      ),
    ).toBeUndefined();
  });
  it('analyzes GET operations and rechecks after later query transformations', async () => {
    const ctx = context('', { maxDepth: 2 }, 'GET');
    ctx.req.url = '/graphql?query=' + encodeURIComponent('{ user { id } }');
    expect(await plugin.onRequest(ctx)).toBeUndefined();
    ctx.req.url =
      '/graphql?query=' + encodeURIComponent('{ user { child { id } } }');
    expect(code(await plugin.validateRequest(ctx))).toBe(
      'GRAPHQL_DEPTH_EXCEEDED',
    );
  });
  it('rejects mutation through GET and ambiguous or duplicate GET parameters', async () => {
    const ctx = context('', {}, 'GET');
    ctx.req.url = '/graphql?query=' + encodeURIComponent('mutation { update }');
    expect((await plugin.onRequest(ctx))?.status).toBe(405);
    ctx.req.url = '/graphql?query=%7Ba%7D&query=%7Bb%7D';
    expect((await plugin.onRequest(ctx))?.status).toBe(400);
    ctx.req.url = '/graphql';
    expect((await plugin.onRequest(ctx))?.status).toBe(400);
  });
  it.each([
    null,
    [],
    [{ query: '{ a }' }],
    {},
    { query: '' },
    { query: '{' },
    { query: '{ a }', variables: [] },
    { query: '{ a }', operationName: 3 },
    {
      query: '{ a }',
      extensions: { persistedQuery: { sha256Hash: 'fixture' } },
    },
  ])('rejects malformed/batch/persisted payload: %j', async (payload) => {
    expect((await plugin.onRequest(context(payload)))?.status).toBe(400);
  });
  it('requires a selected operation when multiple operations exist', async () => {
    const query = 'query A { a } query B { b }';
    expect(code(await plugin.onRequest(context({ query })))).toBe(
      'GRAPHQL_OPERATION_INVALID',
    );
    expect(
      await plugin.onRequest(
        context({ query, operationName: 'A', variables: {} }),
      ),
    ).toBeUndefined();
  });
  it('accepts raw GraphQL and rejects unsupported media/encoding/methods', async () => {
    expect(
      await plugin.onRequest(
        context('{ user { id } }', {}, 'POST', 'application/graphql'),
      ),
    ).toBeUndefined();
    expect(
      (await plugin.onRequest(context('{ a }', {}, 'POST', 'text/plain')))
        ?.status,
    ).toBe(415);
    expect((await plugin.onRequest(context('{ a }', {}, 'PUT')))?.status).toBe(
      405,
    );
    const ctx = context({ query: '{ a }' });
    ctx.req.headers['content-encoding'] = 'gzip';
    expect((await plugin.onRequest(ctx))?.status).toBe(415);
  });
  it('fails closed on invalid policies instead of disabling protection', async () => {
    for (const bad of [
      { maxDepth: 0 },
      { maxDepth: -1 },
      { maxDepth: '10' },
      { maxComplexity: 0 },
      { introspectionAllowed: 'false' },
    ])
      expect(
        (
          await plugin.onRequest(
            context({ query: '{ a }' }, bad as GraphqlPolicy),
          )
        )?.status,
      ).toBe(500);
  });
});
