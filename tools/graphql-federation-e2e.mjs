import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { buildSchema, graphql } from 'graphql';

/**
 * Phase 6.7 exit criterion on real processes: a GraphQL federation query
 * hitting two subgraphs returns a merged response. Two subgraph servers
 * (users and reviews) register their SDL through the admin API, which
 * composes the supergraph; the control plane delivers it to a real gateway
 * whose graphql-federation route plans the query, calls both subgraphs
 * (including _entities lookups) and merges the results. The gateway is then
 * restarted to prove the control plane's initial snapshot carries the
 * graph, and a stopped subgraph yields partial data with a coded error.
 *
 * Requires PostgreSQL (E2E_DATABASE_URL), Redis (E2E_REDIS_URL) and built
 * admin-api, control-plane and api. No containers, no external network.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/14';
const artifacts = resolve('.local-work/graphql-federation-e2e');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const ports = { admin: 3001, planeHttp: 3172, planeWs: 8252, gateway: 3173 };
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'federation-e2e-platform-secret-at-least-32-chars';
const gatewayApiKey = randomUUID();
const database = `novagate_federation_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const children = [];
const evidence = { startedAt: new Date().toISOString(), steps: [] };
const servers = [];
let root;
let db;

// What each team uploads (Apollo Federation 2 directives)...
const USERS_SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
type Query { users: [User!]! user(id: ID!): User }
type User @key(fields: "id") { id: ID! name: String! }
`;
const REVIEWS_SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
type Review { id: ID! body: String! stars: Int! author: User! }
type User @key(fields: "id") { id: ID! reviews: [Review!]! }
type Query { topReviews: [Review!]! }
`;
// ...and what its server executes, with the federation _entities field.
const people = { 1: 'Ada Lovelace', 2: 'Linus Torvalds', 3: 'Grace Hopper' };
const reviews = [
  { id: 'r1', userId: '1', body: 'Elegant engines', stars: 5 },
  { id: 'r2', userId: '2', body: 'Fast kernels', stars: 4 },
  { id: 'r3', userId: '1', body: 'Notes worth reading', stars: 5 },
];
const subgraphs = {
  users: {
    schema: buildSchema(`
      scalar _Any
      union _Entity = User
      type Query { users: [User!]! user(id: ID!): User _entities(representations: [_Any!]!): [_Entity]! }
      type User { id: ID! name: String! }`),
    root: {
      users: () =>
        Object.entries(people).map(([id, name]) => ({
          __typename: 'User',
          id,
          name,
        })),
      user: ({ id }) =>
        people[id] ? { __typename: 'User', id, name: people[id] } : null,
      _entities: ({ representations }) =>
        representations.map(({ id }) => ({
          __typename: 'User',
          id,
          name: people[id],
        })),
    },
    path: '/graphql',
  },
  reviews: {
    schema: buildSchema(`
      scalar _Any
      union _Entity = User
      type Review { id: ID! body: String! stars: Int! author: User! }
      type User { id: ID! reviews: [Review!]! }
      type Query { topReviews: [Review!]! _entities(representations: [_Any!]!): [_Entity]! }`),
    root: {
      topReviews: () =>
        [...reviews]
          .sort((a, b) => b.stars - a.stars)
          .slice(0, 2)
          .map((review) => ({
            __typename: 'Review',
            ...review,
            author: { __typename: 'User', id: review.userId },
          })),
      _entities: ({ representations }) =>
        representations.map(({ id }) => ({
          __typename: 'User',
          id,
          reviews: reviews
            .filter((review) => review.userId === id)
            .map((review) => ({ __typename: 'Review', ...review })),
        })),
    },
    path: '/query',
  },
};
const received = { users: [], reviews: [] };

function step(name, detail = {}) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`✓ ${name}`);
}
async function until(check, label, timeout = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
function start(name, script, env) {
  assert.ok(existsSync(script), `Build ${name} first: ${script} is missing`);
  const log = createWriteStream(resolve(artifacts, `${name}.log`), {
    flags: 'a',
  });
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((done) => setTimeout(done, 10000)),
  ]);
}
async function api(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.admin}/api${path}`, {
    ...init,
    headers: {
      authorization: session,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
async function ok(path, init) {
  const result = await api(path, init);
  if (result.status >= 300)
    throw new Error(
      `${init?.method ?? 'GET'} ${path} → ${result.status} ${JSON.stringify(result.body)}`,
    );
  return result.body;
}
let consumerKey;
async function query(body, headers = {}) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${ports.gateway}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${consumerKey}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text),
    ms: performance.now() - started,
  };
}
function subgraphServer(name) {
  const { schema: executable, root: rootValue, path } = subgraphs[name];
  const server = createServer((request, response) => {
    if (request.url === '/health') return response.end('ok');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      if (request.url !== path) return response.writeHead(404).end();
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received[name].push({
        query: body.query,
        requestId: request.headers['x-request-id'],
        shop: request.headers['x-shop'],
        traceparent: request.headers.traceparent,
      });
      const result = await graphql({
        schema: executable,
        source: body.query,
        variableValues: body.variables,
        operationName: body.operationName,
        rootValue,
      });
      response
        .writeHead(200, { 'content-type': 'application/graphql-response+json' })
        .end(JSON.stringify(result));
    });
  });
  servers.push(server);
  return server;
}

const STOREFRONT = {
  query: `query Storefront {
    users { id name reviews { body stars } }
    topReviews { body author { name } }
  }`,
  operationName: 'Storefront',
};
const EXPECTED = {
  data: {
    users: [
      {
        id: '1',
        name: 'Ada Lovelace',
        reviews: [
          { body: 'Elegant engines', stars: 5 },
          { body: 'Notes worth reading', stars: 5 },
        ],
      },
      {
        id: '2',
        name: 'Linus Torvalds',
        reviews: [{ body: 'Fast kernels', stars: 4 }],
      },
      { id: '3', name: 'Grace Hopper', reviews: [] },
    ],
    topReviews: [
      { body: 'Elegant engines', author: { name: 'Ada Lovelace' } },
      { body: 'Notes worth reading', author: { name: 'Ada Lovelace' } },
    ],
  },
};

try {
  root = new pg.Client({ connectionString: databaseRoot });
  await root.connect();
  await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(databaseRoot);
  url.pathname = `/${database}`;
  const databaseUrl = url.toString();
  db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(readFileSync('docker/postgres-init.sql', 'utf8'));
  await db.query(
    `INSERT INTO public.tenants (id,name,email,"planId","gatewayConfigVersion","emailVerified") VALUES ($1,'Acme','owner@acme.test','free',1,true)`,
    [tenant],
  );
  await db.query(`CREATE SCHEMA ${schema}`);
  const provisioning = readFileSync(
    'apps/admin-api/src/tenants/tenant-provisioning.service.ts',
    'utf8',
  );
  for (const match of provisioning.matchAll(
    /await manager\.query\(`([\s\S]*?)`\)/g,
  ))
    await db.query(match[1].replaceAll('${schemaName}', schema));
  await db.query(
    `INSERT INTO public.api_keys ("tenantId","keyHash",label) VALUES ($1,$2,'E2E gateway')`,
    [tenant, createHash('sha256').update(gatewayApiKey).digest('hex')],
  );

  const targets = {};
  for (const name of ['users', 'reviews']) {
    const server = subgraphServer(name);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    targets[name] = `http://127.0.0.1:${server.address().port}`;
  }

  start('admin-api', 'apps/admin-api/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PLATFORM_JWT_SECRET: secret,
    OBJECT_STORAGE_ENABLED: 'false',
  });
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.admin}/api/health`)).ok,
    'admin-api startup',
  );
  start('control-plane', 'apps/control-plane/dist/main.js', {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PORT: String(ports.planeHttp),
    WS_PORT: String(ports.planeWs),
  });
  await until(
    async () =>
      (await fetch(`http://127.0.0.1:${ports.planeHttp}/api/health`)).ok,
    'control-plane startup',
  );
  const gatewayEnv = {
    PORT: String(ports.gateway),
    REDIS_URL: redisUrl,
    JWT_SECRET: secret,
    GATEWAY_API_KEY: gatewayApiKey,
    CONTROL_PLANE_URL: `ws://127.0.0.1:${ports.planeWs}`,
    GRPC_ENABLED: 'false',
  };
  let gatewayProcess = start('gateway', 'apps/api/dist/main.js', gatewayEnv);
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.gateway}/health`)).ok,
    'gateway startup',
  );
  step('started admin-api, control-plane, gateway and two subgraph servers');

  // Register the subgraphs' services and schemas.
  const services = {};
  for (const name of ['users', 'reviews'])
    services[name] = await ok(`/tenants/${tenant}/services`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        targets: [{ url: targets[name], weight: 100 }],
        timeoutMs: 2000,
      }),
    });
  consumerKey = (
    await ok(`/tenants/${tenant}/consumers`, {
      method: 'POST',
      body: JSON.stringify({ name: 'storefront-app' }),
    })
  ).apiKey;
  const definition = (reviewsSdl) => [
    {
      name: 'users',
      serviceId: services.users.id,
      path: '/graphql',
      sdl: USERS_SDL,
    },
    {
      name: 'reviews',
      serviceId: services.reviews.id,
      path: '/query',
      sdl: reviewsSdl,
    },
  ];
  const conflicting = await ok(
    `/tenants/${tenant}/graphql-federation/compose`,
    {
      method: 'POST',
      body: JSON.stringify({
        subgraphs: definition(
          REVIEWS_SDL.replace('id: ID! reviews', 'id: Int! reviews'),
        ),
      }),
    },
  );
  assert.equal(conflicting.ok, false);
  assert.ok(
    conflicting.errors.some((error) => error.code === 'FIELD_TYPE_MISMATCH'),
  );
  const refused = await api(
    `/tenants/${tenant}/graphql-federation/graphs/storefront`,
    {
      method: 'PUT',
      body: JSON.stringify({
        subgraphs: definition(
          REVIEWS_SDL.replace('id: ID! reviews', 'id: Int! reviews'),
        ),
      }),
    },
  );
  assert.equal(refused.status, 422);
  step('subgraphs that do not compose were refused with their errors', {
    errors: conflicting.errors,
  });
  const saved = await ok(
    `/tenants/${tenant}/graphql-federation/graphs/storefront`,
    {
      method: 'PUT',
      body: JSON.stringify({ subgraphs: definition(REVIEWS_SDL) }),
    },
  );
  await ok(`/tenants/${tenant}/routes`, {
    method: 'POST',
    body: JSON.stringify({
      method: 'ANY',
      pathPattern: '/graphql',
      serviceId: services.users.id,
      authRequired: true,
      plugins: [
        {
          name: 'graphql-federation',
          config: { graph: 'storefront', forwardHeaders: ['x-shop'] },
        },
      ],
    }),
  });
  step('composed the storefront supergraph and served it on POST /graphql', {
    supergraphSha256: saved.supergraphSha256,
  });

  // The exit criterion: one query, two subgraphs, one merged response.
  const requestId = randomUUID();
  const first = await until(async () => {
    const result = await query(STOREFRONT, {
      'x-request-id': requestId,
      'x-shop': 'acme',
    });
    return result.status === 200 && result.body.data ? result : null;
  }, 'federated query through the gateway');
  assert.deepEqual(first.body, EXPECTED);
  const plan = {
    users: received.users.map((call) => call.query.replace(/\s+/g, ' ')),
    reviews: received.reviews.map((call) => call.query.replace(/\s+/g, ' ')),
  };
  assert.ok(plan.users.some((q) => q.includes('users')));
  assert.ok(plan.reviews.some((q) => q.includes('_entities')));
  assert.ok(plan.users.some((q) => q.includes('_entities')));
  for (const call of [...received.users, ...received.reviews]) {
    assert.equal(call.requestId, requestId);
    assert.equal(call.shop, 'acme');
  }
  step('a query hitting two subgraphs returned one merged response', {
    response: first.body,
    subgraphRequests: plan,
  });

  // Route authentication applies before the graph is touched.
  const before = received.users.length + received.reviews.length;
  const anonymous = await fetch(`http://127.0.0.1:${ports.gateway}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(STOREFRONT),
  });
  assert.equal(anonymous.status, 401);
  assert.equal(received.users.length + received.reviews.length, before);
  const invalid = await query({ query: '{ users { nam } }' });
  assert.equal(invalid.status, 200);
  assert.match(invalid.body.errors[0].message, /Cannot query field "nam"/);
  assert.equal(received.users.length + received.reviews.length, before);
  step('anonymous and invalid queries never reached a subgraph');

  const timings = [];
  for (let i = 0; i < 20; i++) {
    const result = await query(STOREFRONT);
    assert.deepEqual(result.body, EXPECTED);
    timings.push(result.ms);
  }
  timings.sort((a, b) => a - b);
  step('measured the merged query through the gateway', {
    p50Ms: Number(timings[9].toFixed(1)),
    p95Ms: Number(timings[18].toFixed(1)),
  });

  // A fresh gateway gets the graph from the control plane's snapshot.
  await stop(gatewayProcess);
  const { default: Redis } = await import('ioredis');
  const cache = new Redis(redisUrl);
  await cache.del('cfg:default');
  cache.disconnect();
  gatewayProcess = start('gateway', 'apps/api/dist/main.js', gatewayEnv);
  await until(
    async () => (await fetch(`http://127.0.0.1:${ports.gateway}/health`)).ok,
    'gateway restart',
  );
  const restarted = await until(async () => {
    const result = await query(STOREFRONT);
    return result.status === 200 && result.body.data ? result : null;
  }, 'federated query after restart');
  assert.deepEqual(restarted.body, EXPECTED);
  step('a restarted gateway served the graph from the control plane snapshot');

  // A stopped subgraph gives partial data and a coded error, not a leak.
  const reviewsServer = servers[1];
  reviewsServer.closeAllConnections();
  await new Promise((done) => reviewsServer.close(done));
  const partial = await query({ query: '{ users { name reviews { body } } }' });
  assert.equal(partial.status, 200);
  const codes = partial.body.errors.map((error) => error.extensions?.code);
  assert.ok(
    codes.includes('SUBGRAPH_UNAVAILABLE'),
    JSON.stringify(partial.body),
  );
  assert.ok(!JSON.stringify(partial.body).includes('127.0.0.1'));
  const usersOnly = await query({ query: '{ users { name } }' });
  assert.deepEqual(usersOnly.body, {
    data: { users: Object.values(people).map((name) => ({ name })) },
  });
  step(
    'with the reviews subgraph down, users still resolved and the error was coded',
    {
      errors: partial.body.errors,
    },
  );
  assert.equal(gatewayProcess.exitCode, null);
  evidence.passed = true;
  console.log('GraphQL federation end-to-end verification passed.');
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(
    resolve(artifacts, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  for (const { child } of children.reverse()) await stop(child);
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await db?.end().catch(() => undefined);
  if (root) {
    await root
      .query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      .catch(() => undefined);
    await root.end();
  }
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis
    .connect()
    .then(() => redis.flushdb())
    .catch(() => undefined);
  redis.disconnect();
}
