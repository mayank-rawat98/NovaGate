import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

const USERS_SDL =
  'type Query { users: [User!]! }\ntype User @key(fields: "id") { id: ID! name: String! }';
const REVIEWS_SDL =
  'type Review { body: String! }\ntype User @key(fields: "id") { id: ID! reviews: [Review!]! }';
const CONFLICTING_SDL = REVIEWS_SDL.replace('id: ID!', 'id: Int!');

/** Stateful federation fixture; composition and execution are verified on real processes. */
export function graphqlFederationBrowserFixture(serviceId) {
  const state = {
    graphs: new Map(),
    composes: [],
    saves: [],
    refuseRemove: true,
  };
  const summary = (graph) => ({
    name: graph.name,
    subgraphs: graph.subgraphs.map(({ sdl, ...subgraph }) => ({
      ...subgraph,
      serviceName: subgraph.serviceId === serviceId ? 'Catalog API' : null,
      sdlBytes: Buffer.byteLength(sdl),
      sdlSha256: 'e'.repeat(64),
    })),
    publicSdl: 'type Query {\n  users: [User!]!\n}',
    supergraphSha256: 'f'.repeat(64),
    routes: graph.name === 'storefront' ? ['POST /graphql'] : [],
    updatedAt: '2026-10-26T09:00:00.000Z',
  });
  const compose = (subgraphs) =>
    subgraphs.some((subgraph) => subgraph.sdl.includes('id: Int!'))
      ? {
          ok: false,
          errors: [
            {
              message:
                'Type of field "User.id" is incompatible across subgraphs: it has type "ID!" in subgraph "users" but type "Int!" in subgraph "reviews"',
              code: 'FIELD_TYPE_MISMATCH',
            },
          ],
        }
      : { ok: true, errors: [], publicSdl: 'type Query { users: [User!]! }' };
  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.includes('/graphql-federation')) return false;
    assert.equal(
      request.headers().authorization,
      'Bearer browser-verification-token',
    );
    const reply = (status, body) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (url.pathname.endsWith('/compose')) {
      const { subgraphs } = request.postDataJSON();
      state.composes.push(subgraphs);
      return (await reply(200, compose(subgraphs)), true);
    }
    if (url.pathname.endsWith('/graphs') && request.method() === 'GET')
      return (
        await reply(200, { graphs: [...state.graphs.values()].map(summary) }),
        true
      );
    if (request.method() === 'GET') {
      const graph = state.graphs.get(name);
      return (
        await (graph
          ? reply(200, { ...summary(graph), subgraphs: graph.subgraphs })
          : reply(404, { message: 'Graph not found' })),
        true
      );
    }
    if (request.method() === 'PUT') {
      const { subgraphs } = request.postDataJSON();
      state.saves.push({ name, subgraphs });
      state.graphs.set(name, { name, subgraphs });
      return (
        await reply(200, { ...summary({ name, subgraphs }), subgraphs }),
        true
      );
    }
    if (request.method() === 'DELETE') {
      if (state.refuseRemove) {
        state.refuseRemove = false;
        return (
          await reply(409, {
            message:
              'Remove the graphql-federation plugin for storefront from these routes first: POST /graphql',
          }),
          true
        );
      }
      state.graphs.delete(name);
      return (await reply(200, { success: true }), true);
    }
    return false;
  }
  return { handle, state };
}

export async function verifyGraphqlFederationDashboard({
  page,
  context,
  base,
  audit,
  fixture,
  serviceId,
}) {
  const banner = () => page.getByRole('alert').filter({ hasText: /\S/ });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/graphql`);
  await expect(
    page.getByRole('heading', { name: 'GraphQL federation', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No federated graphs yet.')).toBeVisible();
  await audit('graphql federation empty');

  // Two subgraphs that do not compose show every composition error.
  await page.getByRole('button', { name: 'New graph' }).click();
  await expect(page.getByRole('heading', { name: 'New graph' })).toBeFocused();
  await page.getByLabel('Graph name').fill('storefront');
  const first = page.getByRole('group', { name: 'Subgraph 1' });
  await first.getByLabel('Name', { exact: true }).fill('users');
  await first.getByLabel('Service', { exact: true }).selectOption(serviceId);
  await first.getByLabel('Schema (SDL)').fill(USERS_SDL);
  await page.getByRole('button', { name: 'Add subgraph' }).click();
  const second = page.getByRole('group', { name: 'Subgraph 2' });
  await second.getByLabel('Name', { exact: true }).fill('reviews');
  await second.getByLabel('Service', { exact: true }).selectOption(serviceId);
  await second.getByLabel('Path on the service').fill('/query');
  await second.getByLabel('Schema (SDL)').fill(CONFLICTING_SDL);
  await page.getByRole('button', { name: 'Check composition' }).click();
  await expect(banner()).toContainText('FIELD_TYPE_MISMATCH');
  await audit('graphql federation composition errors');
  // Saving composes first and refuses without sending the graph.
  await page.getByRole('button', { name: 'Save graph' }).click();
  await expect(banner()).toContainText('do not compose');
  assert.equal(fixture.state.saves.length, 0);

  await second.getByLabel('Schema (SDL)').fill(REVIEWS_SDL);
  await page.getByRole('button', { name: 'Save graph' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'storefront is saved' }),
  ).toBeVisible();
  assert.deepEqual(fixture.state.saves.at(-1), {
    name: 'storefront',
    subgraphs: [
      { name: 'users', serviceId, path: '/graphql', sdl: USERS_SDL },
      { name: 'reviews', serviceId, path: '/query', sdl: REVIEWS_SDL },
    ],
  });
  const table = page.getByRole('region', { name: 'storefront subgraphs' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(page.getByText('Served on POST /graphql')).toBeVisible();

  // Editing loads the saved SDL; the name stays fixed.
  await page.getByRole('button', { name: 'Edit storefront' }).click();
  await expect(page.getByLabel('Graph name')).toBeDisabled();
  await expect(
    page.getByRole('group', { name: 'Subgraph 2' }).getByLabel('Schema (SDL)'),
  ).toHaveValue(REVIEWS_SDL);
  await page.getByRole('button', { name: 'Close editor' }).click();

  // Route editor: the plugin picks a saved graph and is saved last.
  const listed = {
    id: 'g1',
    method: 'POST',
    pathPattern: '/graphql',
    serviceId,
    authRequired: false,
    enabled: true,
    plugins: [
      { name: 'cors', config: { origins: ['https://app.example.test'] } },
    ],
    createdAt: '2026-10-26T09:00:00.000Z',
  };
  let saved;
  const list = async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([listed]),
    });
  };
  const put = async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saved = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...listed, ...saved }),
    });
  };
  await context.route('**/api/tenants/*/routes', list);
  await context.route('**/api/tenants/*/routes/g1', put);
  try {
    await page.goto(`${base}/routes`);
    await page.getByRole('button', { name: 'Edit POST /graphql' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByRole('button', { name: 'plugins' }).click();
    await editor
      .getByRole('switch', { name: 'GraphQL federation plugin' })
      .click();
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(
      page.getByText('Choose the federated graph to serve.'),
    ).toBeVisible();
    assert.equal(saved, undefined, 'A plugin without a graph is not sent');
    await editor.getByLabel('Federated graph').selectOption('storefront');
    await editor
      .getByLabel('Headers to forward to subgraphs (comma-sep, optional)')
      .fill('Authorization, x-tenant');
    await audit('route graphql federation plugin');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor).toBeHidden();
  } finally {
    await context.unroute('**/api/tenants/*/routes', list);
    await context.unroute('**/api/tenants/*/routes/g1', put);
  }
  assert.deepEqual(saved.plugins, [
    { name: 'cors', config: { origins: ['https://app.example.test'] } },
    {
      name: 'graphql-federation',
      config: {
        graph: 'storefront',
        forwardHeaders: ['authorization', 'x-tenant'],
      },
    },
  ]);

  // Removal is confirmed; a refusal names the routes that serve the graph.
  await page.goto(`${base}/graphql`);
  await page.getByRole('button', { name: 'Remove storefront' }).click();
  await page.getByRole('button', { name: 'Remove storefront' }).click();
  await expect(banner()).toContainText('POST /graphql');
  await page.getByRole('button', { name: 'Remove storefront' }).click();
  await page.getByRole('button', { name: 'Remove storefront' }).click();
  await expect(page.getByText('No federated graphs yet.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await audit('graphql federation mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  return {
    compositionErrorsShown: true,
    saveComposesFirst: true,
    editLoadsSdl: true,
    routePluginSavedLast: true,
    confirmedRemovalWithRefusal: true,
    desktopMobileAccessibility: true,
  };
}
