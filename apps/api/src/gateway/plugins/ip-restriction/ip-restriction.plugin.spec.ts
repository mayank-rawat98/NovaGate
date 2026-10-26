import type { PluginContext } from '@api-gateway/shared-types';
import { IpRestrictionPlugin } from './ip-restriction.plugin';

function context(
  peer: string,
  rules: Record<string, unknown>,
  ip?: string,
): PluginContext {
  return {
    req: {
      socket: { remoteAddress: peer },
      ip,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    } as unknown as PluginContext['req'],
    res: {} as PluginContext['res'],
    route: {
      id: 'r1',
      method: 'GET',
      pathPattern: '/api',
      serviceId: 's1',
      enabled: true,
      authRequired: false,
      plugins: [{ name: 'ip-restriction', config: rules }],
    },
    service: undefined,
    tenantId: 't1',
    requestId: 'request-1',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('IP restriction trust and address families', () => {
  const plugin = new IpRestrictionPlugin();
  it.each([
    ['10.1.2.3', { allow: ['10.0.0.0/8'] }, undefined],
    ['::ffff:10.1.2.3', { allow: ['10.0.0.0/8'] }, undefined],
    ['2001:db8::1234', { allow: ['2001:db8::/32'] }, undefined],
    ['127.0.0.1', { allow: ['2001:db8::/32'] }, '2001:db8::1234'],
  ])(
    'allows peer %s using the trusted request address',
    async (peer, rules, ip) => {
      await expect(
        plugin.onRequest(
          context(
            peer as string,
            rules as Record<string, unknown>,
            ip as string | undefined,
          ),
        ),
      ).resolves.toBeUndefined();
    },
  );
  it.each([
    ['203.0.113.2', { allow: ['10.0.0.0/8'] }],
    ['2001:db8::1', { deny: ['2001:db8::/32'] }],
    ['2001:db8::1', { allow: ['10.0.0.0/8'] }],
    ['invalid-address', { allow: ['0.0.0.0/0'] }],
    ['10.0.0.1', { allow: ['10.0.0.0/8'], deny: ['10.0.0.1'] }],
  ])(
    'rejects peer %s without accepting a spoofed forwarding header',
    async (peer, rules) => {
      await expect(
        plugin.onRequest(
          context(peer as string, rules as Record<string, unknown>),
        ),
      ).resolves.toMatchObject({ status: 403 });
    },
  );
  it.each(['10.0.0.0/33', '2001:db8::/129', '10.0.0.0/no', '10.0.0.0/8/2'])(
    'fails closed on malformed CIDR %s',
    async (cidr) => {
      await expect(
        plugin.onRequest(context('10.0.0.1', { allow: [cidr] })),
      ).rejects.toThrow('Invalid IP restriction CIDR');
    },
  );
});
