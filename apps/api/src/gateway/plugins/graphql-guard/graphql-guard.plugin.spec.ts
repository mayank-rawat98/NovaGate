import type { ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { GraphqlGuardPlugin } from './graphql-guard.plugin';
import type { PluginContext, RouteConfig } from '@api-gateway/shared-types';

function makeCtx(
  body: string,
  graphqlConfig?: RouteConfig['graphql'],
  method = 'POST',
  contentType = 'application/json',
): PluginContext {
  const reqEmitter = new EventEmitter();
  const req = Object.assign(reqEmitter, {
    method,
    headers: { 'content-type': contentType },
    requestId: 'test-req-id',
  });

  // Simulate streaming body
  process.nextTick(() => {
    reqEmitter.emit('data', Buffer.from(body));
    reqEmitter.emit('end');
  });

  return {
    req: req as unknown as PluginContext['req'],
    res: {} as ServerResponse,
    route: {
      id: 'r1',
      method: 'POST',
      pathPattern: '/graphql',
      serviceId: 's1',
      authRequired: false,
      enabled: true,
      graphql: graphqlConfig,
    },
    service: undefined,
    tenantId: 'tenant-1',
    requestId: 'test-req-id',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('GraphqlGuardPlugin', () => {
  let plugin: GraphqlGuardPlugin;

  beforeEach(() => {
    plugin = new GraphqlGuardPlugin();
  });

  it('passes through when route has no graphql config', async () => {
    const ctx = makeCtx('{"query":"{ users { id } }"}', undefined);
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through for non-POST requests', async () => {
    const ctx = makeCtx('', { maxDepth: 5 }, 'GET');
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through for non-JSON content-type', async () => {
    const ctx = makeCtx('', { maxDepth: 5 }, 'POST', 'text/plain');
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('allows a query within depth limit', async () => {
    const body = JSON.stringify({ query: '{ users { id name } }' });
    const ctx = makeCtx(body, { maxDepth: 5 });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('blocks a query exceeding depth limit', async () => {
    const body = JSON.stringify({ query: '{ a { b { c { d { e } } } } }' });
    const ctx = makeCtx(body, { maxDepth: 3 });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(result?.status).toBe(400);
    const parsed = JSON.parse(result?.body as string);
    expect(parsed.error).toBe('GRAPHQL_DEPTH_EXCEEDED');
  });

  it('blocks a query exceeding complexity limit', async () => {
    // 10 fields at depth 2 = complexity 20; limit 5
    const fields = Array.from({ length: 10 }, (_, i) => `field${i}`).join(' ');
    const body = JSON.stringify({ query: `{ parent { ${fields} } }` });
    const ctx = makeCtx(body, { maxComplexity: 5 });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(result?.status).toBe(400);
    const parsed = JSON.parse(result?.body as string);
    expect(parsed.error).toBe('GRAPHQL_COMPLEXITY_EXCEEDED');
  });

  it('blocks introspection when introspectionAllowed is false', async () => {
    const body = JSON.stringify({
      query: '{ __schema { types { name } } }',
    });
    const ctx = makeCtx(body, { introspectionAllowed: false });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(result?.status).toBe(400);
    const parsed = JSON.parse(result?.body as string);
    expect(parsed.error).toBe('GRAPHQL_INTROSPECTION_DISABLED');
  });

  it('allows introspection when introspectionAllowed is true', async () => {
    const body = JSON.stringify({
      query: '{ __schema { types { name } } }',
    });
    const ctx = makeCtx(body, { introspectionAllowed: true });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('accepts application/graphql content-type', async () => {
    const ctx = makeCtx(
      '{ users { id } }',
      { maxDepth: 5 },
      'POST',
      'application/graphql',
    );
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('uses pre-buffered rawBody when available', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({ query: '{ a { b { c { d { e } } } } }' }),
    );
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      requestId: 'req-id',
      rawBody,
    };
    const ctx: PluginContext = {
      req: req as unknown as PluginContext['req'],
      res: {} as ServerResponse,
      route: {
        id: 'r1',
        method: 'POST',
        pathPattern: '/graphql',
        serviceId: 's1',
        authRequired: false,
        enabled: true,
        graphql: { maxDepth: 3 },
      },
      service: undefined,
      tenantId: 'tenant-1',
      requestId: 'req-id',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(result?.status).toBe(400);
  });
});
