import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { PortalProvider } from '../src/components/portal-provider';
import CatalogPage from '../src/app/w/[tenant]/page';
import KeysPage from '../src/app/w/[tenant]/keys/page';
import { saveSession, clearSession } from '../src/lib/session';

const tenant = '12345678-1234-1234-1234-123456789abc';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => `/w/${tenant}`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ tenant }),
}));

const catalog = {
  tenantId: tenant,
  title: 'Acme API',
  apiBaseUrl: 'https://api.acme.test',
  signup: 'open',
  routes: [
    {
      id: '23456789-1234-1234-1234-123456789abc',
      method: 'GET',
      path: '/users',
      summary: 'List users',
      description: null,
      auth: ['api-key'],
      rateLimit: { requests: 30, windowMs: 60000 },
      groupRestricted: false,
    },
  ],
};

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

function wrap(node: React.ReactNode, base = `/w/${tenant}`) {
  return render(
    <PortalProvider tenant={tenant} base={base}>
      {node}
    </PortalProvider>,
  );
}

describe('developer portal pages', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    clearSession(tenant);
  });

  it('renders published routes with auth and limits, linking under the base', async () => {
    fetchMock.mockImplementation(() => respond(catalog));
    wrap(<CatalogPage />);
    const link = await screen.findByRole('link', { name: /\/users/ });
    expect(link.getAttribute('href')).toBe(
      `/w/${tenant}/docs/23456789-1234-1234-1234-123456789abc`,
    );
    expect(screen.getByText('List users')).toBeTruthy();
    expect(screen.getByText('API key')).toBeTruthy();
    expect(screen.getByText('30 requests per minute')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/portal/${tenant}/catalog`,
      expect.anything(),
    );
  });

  it('builds root-relative links on a custom domain', async () => {
    fetchMock.mockImplementation(() => respond(catalog));
    wrap(<CatalogPage />, '');
    const link = await screen.findByRole('link', { name: /\/users/ });
    expect(link.getAttribute('href')).toBe(
      '/docs/23456789-1234-1234-1234-123456789abc',
    );
  });

  it('asks signed-out developers to sign in before showing keys', () => {
    wrap(<KeysPage />);
    expect(
      screen.getByRole('heading', { name: 'Sign in to continue' }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists keys with the developer session and never shows key secrets', async () => {
    saveSession(tenant, {
      token: 'developer-session',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      developer: { id: 'd', email: 'dev@example.test', name: 'Dev' },
    });
    fetchMock.mockImplementation(() =>
      respond([
        {
          id: 'k1',
          name: 'Mobile app',
          createdAt: '2026-10-25T00:00:00.000Z',
          revokedAt: null,
        },
      ]),
    );
    wrap(<KeysPage />);
    expect(
      await screen.findByRole('button', { name: 'Revoke Mobile app' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/portal/${tenant}/me/keys`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer developer-session',
          }),
        }),
      ),
    );
  });

  it('drops an expired stored session', () => {
    saveSession(tenant, {
      token: 'expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      developer: { id: 'd', email: 'dev@example.test', name: 'Dev' },
    });
    wrap(<KeysPage />);
    expect(
      screen.getByRole('heading', { name: 'Sign in to continue' }),
    ).toBeTruthy();
  });
});
