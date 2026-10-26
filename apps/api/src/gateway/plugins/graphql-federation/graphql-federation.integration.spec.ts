import { Global, INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import RedisMock from 'ioredis-mock';
import { buildSchema, graphql, parse } from 'graphql';
import { composeServices } from '@theguild/federation-composition';
import {
  subgraphEndpoint,
  type FederatedGraphConfig,
  type TenantConfig,
} from '@api-gateway/shared-types';
import { ProxyController } from '../../proxy/proxy.controller';
import { ProxyMiddleware } from '../../proxy/proxy.middleware';
import { ProxyService } from '../../proxy/proxy.service';
import { LoadBalancerService } from '../../proxy/load-balancer.service';
import { Http2SessionPool } from '../../proxy/http2-session-pool.service';
import { MetricsService } from '../../metrics/metrics.service';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service';
import { ConfigManagerModule } from '../../config-manager/config-manager.module';
import { UpstreamHealthService } from '../../health/upstream-health.service';
import { PluginsModule } from '../plugins.module';
import { REDIS_CLIENT } from '../../shared/redis.tokens';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { RateLimitGuard } from '../../rate-limit/rate-limit.guard';
import { GatewayExceptionFilter } from '../../shared/gateway-exception.filter';
import { GatewayTelemetryService } from '../../telemetry/gateway-telemetry.service';
import { JwtMiddleware } from '../../auth/jwt.middleware';
import { CircuitBreakerService } from '../../circuit-breaker/circuit-breaker.service';
import { GraphqlFederationService } from './graphql-federation.service';

const settings: Record<string, unknown> = {
  jwt: { secret: 'federation-test-secret-with-more-than-32-chars' },
  rateLimit: { windowMs: 60000, authMax: 500, unauthMax: 100 },
  graphqlFederation: {
    maxSubgraphRequests: 4,
    maxSubgraphResponseBytes: 1024,
    maxConcurrentOperations: 8,
  },
};
const configService = { get: (name: string) => settings[name] };

@Global()
@Module({
  providers: [
    { provide: REDIS_CLIENT, useValue: new RedisMock() },
    { provide: ConfigService, useValue: configService },
  ],
  exports: [REDIS_CLIENT, ConfigService],
})
class TestRedisModule {}

// Federation SDL, as a team would upload it.
const USERS_SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
type Query { users: [User!]! user(id: ID!): User }
type User @key(fields: "id") { id: ID! name: String! }
type Mutation { rename(id: ID!, name: String!): User }
`;
const REVIEWS_SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
type Review { id: ID! body: String! author: User! }
type User @key(fields: "id") { id: ID! reviews: [Review!]! }
type Query { topReviews: [Review!]! }
`;
// What each subgraph server executes (federation's _entities included).
const users = buildSchema(`
scalar _Any
union _Entity = User
type Query { users: [User!]! user(id: ID!): User _entities(representations: [_Any!]!): [_Entity]! }
type Mutation { rename(id: ID!, name: String!): User }
type User { id: ID! name: String! }
`);
const reviews = buildSchema(`
scalar _Any
union _Entity = User
type Review { id: ID! body: String! author: User! }
type User { id: ID! reviews: [Review!]! }
type Query { topReviews: [Review!]! _entities(representations: [_Any!]!): [_Entity]! }
`);
const people: Record<string, string> = { '1': 'Ada', '2': 'Linus' };
const usersRoot = {
  users: () =>
    Object.entries(people).map(([id, name]) => ({
      __typename: 'User',
      id,
      name,
    })),
  user: ({ id }: { id: string }) =>
    people[id] ? { __typename: 'User', id, name: people[id] } : null,
  rename: ({ id, name }: { id: string; name: string }) => ({
    __typename: 'User',
    id,
    name,
  }),
  _entities: ({
    representations,
  }: {
    representations: Array<{ id: string }>;
  }) =>
    representations.map((r) => ({
      __typename: 'User',
      id: r.id,
      name: people[r.id],
    })),
};
const reviewsRoot = {
  topReviews: () => [
    {
      __typename: 'Review',
      id: 'r1',
      body: 'Brilliant',
      author: { __typename: 'User', id: '2' },
    },
  ],
  _entities: ({
    representations,
  }: {
    representations: Array<{ id: string }>;
  }) =>
    representations.map((r) => ({
      __typename: 'User',
      id: r.id,
      reviews: [
        {
          __typename: 'Review',
          id: `r-${r.id}`,
          body: `Review of ${people[r.id]}`,
        },
      ],
    })),
};

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  query: string;
}
function subgraphServer(
  schema: ReturnType<typeof buildSchema>,
  rootValue: object,
  received: Received[],
  behaviour: { delayMs?: number; huge?: boolean } = {},
) {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        query: body.query,
      });
      if (behaviour.delayMs)
        await new Promise((done) => setTimeout(done, behaviour.delayMs));
      if (behaviour.huge) {
        res.setHeader('content-type', 'application/json');
        res.end(`{"data":{"pad":"${'x'.repeat(4096)}"}}`);
        return;
      }
      const result = await graphql({
        schema,
        source: body.query,
        variableValues: body.variables,
        operationName: body.operationName,
        rootValue,
      });
      res.setHeader('content-type', 'application/graphql-response+json');
      res.end(JSON.stringify(result));
    });
  });
}

function compose(subgraphs: Array<{ name: string; sdl: string }>): string {
  const result = composeServices(
    subgraphs.map((s) => ({
      name: s.name,
      typeDefs: parse(s.sdl),
      url: subgraphEndpoint(s.name),
    })),
  );
  if (result.errors)
    throw new Error(result.errors.map((e) => e.message).join('; '));
  return result.supergraphSdl;
}

describe('GraphQL federation through the real proxy and subgraph servers', () => {
  let app: INestApplication;
  let url: string;
  let config: TenantConfig;
  const servers: http.Server[] = [];
  const usersReceived: Received[] = [];
  const reviewsReceived: Received[] = [];
  const slowReceived: Received[] = [];
  const consumerKey = 'federation-consumer-key';
  let graph: FederatedGraphConfig;

  const listen = async (server: http.Server) => {
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    const usersUrl = await listen(
      subgraphServer(users, usersRoot, usersReceived),
    );
    const reviewsUrl = await listen(
      subgraphServer(reviews, reviewsRoot, reviewsReceived),
    );
    const slowUrl = await listen(
      subgraphServer(reviews, reviewsRoot, slowReceived, { delayMs: 600 }),
    );
    const hugeUrl = await listen(
      subgraphServer(reviews, reviewsRoot, slowReceived, { huge: true }),
    );
    const supergraphSdl = compose([
      { name: 'users', sdl: USERS_SDL },
      { name: 'reviews', sdl: REVIEWS_SDL },
    ]);
    graph = {
      name: 'storefront',
      supergraphSdl,
      sha256: createHash('sha256').update(supergraphSdl).digest('hex'),
      subgraphs: [
        { name: 'users', serviceId: 'users-svc', path: '/graphql' },
        { name: 'reviews', serviceId: 'reviews-svc', path: '/query' },
      ],
    };
    const service = (id: string, target: string, timeoutMs = 1000) => ({
      id,
      name: id,
      targets: [{ url: target, weight: 1 }],
      timeoutMs,
      healthCheckPath: '/health',
    });
    const route = (
      id: string,
      pathPattern: string,
      plugins: Array<{ name: string; config: Record<string, unknown> }>,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      serviceId: 'users-svc',
      method: 'ANY',
      pathPattern,
      enabled: true,
      authRequired: false,
      plugins,
      ...extra,
    });
    config = {
      routes: [
        route('open', '/graphql', [
          {
            name: 'graphql-federation',
            config: { graph: 'storefront', forwardHeaders: ['x-shop'] },
          },
        ]),
        route(
          'private',
          '/private/graphql',
          [{ name: 'graphql-federation', config: { graph: 'storefront' } }],
          { authRequired: true },
        ),
        route('guarded', '/guarded/graphql', [
          { name: 'graphql-guard', config: { maxDepth: 2 } },
          { name: 'graphql-federation', config: { graph: 'storefront' } },
        ]),
        route('missing', '/missing/graphql', [
          { name: 'graphql-federation', config: { graph: 'nothing' } },
        ]),
        route('slow', '/slow/graphql', [
          { name: 'graphql-federation', config: { graph: 'slow' } },
        ]),
        route('huge', '/huge/graphql', [
          { name: 'graphql-federation', config: { graph: 'huge' } },
        ]),
        route('down', '/down/graphql', [
          { name: 'graphql-federation', config: { graph: 'down' } },
        ]),
      ],
      services: [
        service('users-svc', usersUrl),
        service('reviews-svc', reviewsUrl),
        service('slow-svc', slowUrl, 300),
        service('huge-svc', hugeUrl),
        // Nothing listens on port 9 (discard) here.
        service('down-svc', 'http://127.0.0.1:9'),
      ],
      consumers: [
        {
          id: randomUUID(),
          name: 'shop',
          keyHash: createHash('sha256').update(consumerKey).digest('hex'),
          rateLimitTier: 'authenticated',
        },
      ],
      rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
      federatedGraphs: [
        graph,
        ...['slow', 'huge', 'down'].map((name) => ({
          ...graph,
          name,
          subgraphs: [
            graph.subgraphs[0],
            { name: 'reviews', serviceId: `${name}-svc`, path: '/graphql' },
          ],
        })),
      ],
    };
    const module = await Test.createTestingModule({
      imports: [TestRedisModule, ConfigManagerModule, PluginsModule],
      controllers: [ProxyController],
      providers: [
        ProxyService,
        ProxyMiddleware,
        LoadBalancerService,
        Http2SessionPool,
        JwtMiddleware,
        CircuitBreakerService,
        GraphqlFederationService,
        { provide: ConfigService, useValue: configService },
        {
          provide: MetricsService,
          useValue: new Proxy(
            {},
            // Any counter is a no-op; not thenable, or Nest would await it.
            { get: (_, key) => (key === 'then' ? undefined : jest.fn()) },
          ),
        },
        {
          provide: UpstreamHealthService,
          useValue: {
            getHealthyUrls: (targets: Array<{ url: string }>) =>
              new Set(targets.map((t) => t.url)),
          },
        },
        {
          provide: GatewayTelemetryService,
          useValue: { sendError: jest.fn(), logRequest: jest.fn() },
        },
        { provide: APP_FILTER, useClass: GatewayExceptionFilter },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        RateLimitService,
      ],
    })
      .overrideProvider(GatewayConfigManagerService)
      .useValue({
        getConfig: () => config,
        getTenantId: () => 'tenant',
        subscribeConfig: () => () => undefined,
      })
      .overrideProvider(RateLimitService)
      .useValue({
        check: jest
          .fn()
          .mockResolvedValue({ allowed: true, retryAfterMs: null }),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    const jwt = module.get(JwtMiddleware);
    app.use(jwt.use.bind(jwt));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    await app?.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  beforeEach(() => {
    usersReceived.length = 0;
    reviewsReceived.length = 0;
    slowReceived.length = 0;
  });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('merges a query that needs both subgraphs into one response', async () => {
    const requestId = randomUUID();
    const response = await post(
      '/graphql',
      {
        query:
          'query Storefront { users { id name reviews { body } } topReviews { body author { name } } }',
        operationName: 'Storefront',
      },
      { 'x-request-id': requestId, 'x-shop': 'acme', 'x-secret': 'no' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      data: {
        users: [
          { id: '1', name: 'Ada', reviews: [{ body: 'Review of Ada' }] },
          { id: '2', name: 'Linus', reviews: [{ body: 'Review of Linus' }] },
        ],
        topReviews: [{ body: 'Brilliant', author: { name: 'Linus' } }],
      },
    });
    // The planner fetched users, then their reviews by entity, and the
    // review authors' names from the users subgraph.
    expect(reviewsReceived.some((r) => r.query.includes('_entities'))).toBe(
      true,
    );
    expect(usersReceived.some((r) => r.query.includes('_entities'))).toBe(true);
    expect(reviewsReceived.every((r) => r.path === '/query')).toBe(true);
    expect(usersReceived.every((r) => r.path === '/graphql')).toBe(true);
    for (const received of [...usersReceived, ...reviewsReceived]) {
      expect(received.headers['x-request-id']).toBe(requestId);
      expect(received.headers['x-shop']).toBe('acme');
      expect(received.headers['x-secret']).toBeUndefined();
    }
  });

  it('answers GET queries, refuses GET mutations and runs POST mutations', async () => {
    const get = await fetch(
      `${url}/graphql?query=${encodeURIComponent('{ user(id: "1") { name reviews { body } } }')}`,
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      data: { user: { name: 'Ada', reviews: [{ body: 'Review of Ada' }] } },
    });
    const mutation = 'mutation { rename(id: "1", name: "Grace") { name } }';
    const refused = await fetch(
      `${url}/graphql?query=${encodeURIComponent(mutation)}`,
    );
    expect(refused.status).toBe(405);
    const posted = await post('/graphql', { query: mutation });
    expect(await posted.json()).toEqual({
      data: { rename: { name: 'Grace' } },
    });
  });

  it('reports validation errors without suggestions or subgraph calls', async () => {
    const plain = await post('/graphql', { query: '{ users { nam } }' });
    expect(plain.status).toBe(200);
    const body = (await plain.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0].message).toContain('Cannot query field "nam"');
    expect(body.errors[0].message).not.toContain('Did you mean');
    const typed = await post(
      '/graphql',
      { query: '{ users { nam } }' },
      { accept: 'application/graphql-response+json' },
    );
    expect(typed.status).toBe(400);
    expect(typed.headers.get('content-type')).toContain(
      'application/graphql-response+json',
    );
    const malformed = await post('/graphql', '{"query":');
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: string }).error).toBe(
      'GRAPHQL_QUERY_INVALID',
    );
    expect(usersReceived).toHaveLength(0);
  });

  it('applies route authentication before validation or execution', async () => {
    const anonymous = await post('/private/graphql', {
      query: '{ users { nam } }',
    });
    expect(anonymous.status).toBe(401);
    expect(usersReceived).toHaveLength(0);
    const authenticated = await post(
      '/private/graphql',
      { query: '{ users { id } }' },
      { authorization: `Bearer ${consumerKey}` },
    );
    expect(authenticated.status).toBe(200);
    expect(usersReceived).toHaveLength(1);
  });

  it('lets a graphql-guard policy on the route bound the operation', async () => {
    const deep = await post('/guarded/graphql', {
      query: '{ users { reviews { author { name } } } }',
    });
    expect(deep.status).toBe(400);
    expect(((await deep.json()) as { error: string }).error).toBe(
      'GRAPHQL_DEPTH_EXCEEDED',
    );
    expect(usersReceived).toHaveLength(0);
    const shallow = await post('/guarded/graphql', {
      query: '{ users { id } }',
    });
    expect(shallow.status).toBe(200);
  });

  it('returns partial data with coded errors when a subgraph fails', async () => {
    const query = { query: '{ users { name reviews { body } } }' };
    for (const [path, code] of [
      ['/down/graphql', 'SUBGRAPH_UNAVAILABLE'],
      ['/slow/graphql', 'SUBGRAPH_TIMEOUT'],
      ['/huge/graphql', 'SUBGRAPH_RESPONSE_TOO_LARGE'],
    ]) {
      const response = await post(path, query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { users: unknown[] | null } | null;
        errors: Array<{ message: string; extensions: { code: string } }>;
      };
      expect(body.errors.map((error) => error.extensions.code)).toContain(code);
      // Targets never leak into client errors.
      expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    }
  });

  it('bounds subgraph requests per operation', async () => {
    // Each aliased root field is its own users request: 5 > the limit of 4.
    const response = await post('/graphql', {
      query:
        '{ a: user(id: "1") { name } b: user(id: "2") { name } c: user(id: "1") { id } d: user(id: "2") { id } e: user(id: "1") { name } }',
    });
    const body = (await response.json()) as {
      data: Record<string, unknown>;
      errors: Array<{ path: string[]; extensions: { code: string } }>;
    };
    expect(usersReceived).toHaveLength(4);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].extensions.code).toBe('SUBGRAPH_REQUEST_LIMIT');
    expect(Object.values(body.data).filter(Boolean)).toHaveLength(4);
  });

  it('fails closed when the graph is not in configuration', async () => {
    const response = await post('/missing/graphql', {
      query: '{ users { id } }',
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
      'GRAPH_UNAVAILABLE',
    );
  });

  it('rebuilds the schema when a new supergraph arrives', async () => {
    const supergraphSdl = compose([{ name: 'users', sdl: USERS_SDL }]);
    const previous = config.federatedGraphs;
    config.federatedGraphs = [
      {
        name: 'storefront',
        supergraphSdl,
        sha256: createHash('sha256').update(supergraphSdl).digest('hex'),
        subgraphs: [graph.subgraphs[0]],
      },
    ];
    try {
      const response = await post('/graphql', {
        query: '{ topReviews { body } }',
      });
      const body = (await response.json()) as {
        errors: Array<{ message: string }>;
      };
      expect(body.errors[0].message).toContain(
        'Cannot query field "topReviews"',
      );
    } finally {
      config.federatedGraphs = previous;
    }
  });
});
