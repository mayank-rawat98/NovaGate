import type { PluginContext } from '@api-gateway/shared-types';
import { RateLimitPlugin } from './rate-limit.plugin';

describe('route rate-limit plugin window', () => {
  const check = jest
    .fn()
    .mockResolvedValue({ allowed: true, retryAfterMs: null });
  const plugin = new RateLimitPlugin({ check } as never);
  const context = (config: Record<string, unknown>) =>
    ({
      route: { id: 'route-1', plugins: [{ name: 'rate-limit', config }] },
      req: { headers: {}, socket: { remoteAddress: '192.0.2.1' } },
      requestId: 'request',
    }) as unknown as PluginContext;
  beforeEach(() => check.mockClear());

  it('enforces the saved route window', async () => {
    await plugin.onRequest(context({ max: 10, windowMs: 1000 }));
    expect(check).toHaveBeenCalledWith('route:route-1:192.0.2.1', 10, 1000);
  });
  it.each([undefined, 0, 3600001, 1.5, '1000'])(
    'falls back to the gateway window for %p',
    async (windowMs) => {
      await plugin.onRequest(context({ max: 10, windowMs }));
      expect(check).toHaveBeenCalledWith(
        'route:route-1:192.0.2.1',
        10,
        undefined,
      );
    },
  );
});
