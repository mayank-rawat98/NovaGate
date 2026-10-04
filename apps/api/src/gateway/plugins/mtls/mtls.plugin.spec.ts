import { ConfigService } from '@nestjs/config';
import { MtlsPlugin } from './mtls.plugin';
import type { PluginContext } from '@api-gateway/shared-types';

const context = (required: unknown): PluginContext => ({
  req: {
    headers: { 'x-ssl-client-subject': 'spoofed' },
    rawHeaders: [],
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as PluginContext['req'],
  res: {} as PluginContext['res'],
  service: undefined,
  tenantId: 'tenant',
  requestId: 'request',
  route: {
    id: 'route',
    method: 'GET',
    pathPattern: '/',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: [{ name: 'mtls', config: { required } }],
  },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
});
describe('mTLS policy', () => {
  const plugin = new MtlsPlugin(
    { getConfig: () => ({}) } as never,
    new ConfigService(),
  );
  it('never treats an optional plugin as authentication and strips asserted identity', async () => {
    const ctx = context(false);
    expect(await plugin.onRequest(ctx)).toBeUndefined();
    expect(ctx.authentication).toBeUndefined();
    expect(ctx.req.headers['x-ssl-client-subject']).toBeUndefined();
  });
  it.each([undefined, 'true', 1, null])(
    'rejects invalid required policy %s',
    async (required) =>
      expect((await plugin.onRequest(context(required)))?.status).toBe(500),
  );
  it('rejects missing tenant trust', async () =>
    expect((await plugin.onRequest(context(true)))?.status).toBe(403));
});
