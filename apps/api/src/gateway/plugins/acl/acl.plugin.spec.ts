import { Test } from '@nestjs/testing';
import { AclPlugin } from './acl.plugin';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service';
import type { PluginContext, TenantConfig } from '@api-gateway/shared-types';

function makeConfig(consumers: TenantConfig['consumers']): TenantConfig {
  return {
    routes: [],
    services: [],
    consumers,
    rateLimit: { windowMs: 60000, unauthMax: 100, authMax: 500 },
  };
}

function makeCtx(
  userId: string | undefined,
  aclConfig: Record<string, unknown>,
): PluginContext {
  return {
    req: {
      headers: {},
      user: userId ? { id: userId } : undefined,
    } as unknown as PluginContext['req'],
    res: {} as PluginContext['res'],
    route: {
      id: 'r1',
      method: 'GET',
      pathPattern: '/admin',
      serviceId: 's1',
      authRequired: true,
      enabled: true,
      plugins: [{ name: 'acl', config: aclConfig }],
    },
    service: undefined,
    tenantId: 't1',
    requestId: 'req-1',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

describe('AclPlugin', () => {
  let plugin: AclPlugin;
  let configManager: jest.Mocked<GatewayConfigManagerService>;

  beforeEach(async () => {
    configManager = {
      getConfig: jest.fn(),
    } as unknown as jest.Mocked<GatewayConfigManagerService>;

    const module = await Test.createTestingModule({
      providers: [
        AclPlugin,
        { provide: GatewayConfigManagerService, useValue: configManager },
      ],
    }).compile();
    plugin = module.get(AclPlugin);
  });

  it('passes through when no acl plugin entry on route', async () => {
    const ctx = makeCtx('c1', {});
    ctx.route.plugins = [];
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('passes through when allow and deny are empty', async () => {
    configManager.getConfig.mockReturnValue(
      makeConfig([
        {
          id: 'c1',
          name: 'app',
          keyHash: 'h',
          rateLimitTier: 'authenticated',
          groups: [],
        },
      ]),
    );
    const ctx = makeCtx('c1', {});
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('allows consumer in allowed group', async () => {
    configManager.getConfig.mockReturnValue(
      makeConfig([
        {
          id: 'c1',
          name: 'app',
          keyHash: 'h',
          rateLimitTier: 'authenticated',
          groups: ['admin'],
        },
      ]),
    );
    const ctx = makeCtx('c1', { allow: ['admin'] });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('denies consumer not in allowed group', async () => {
    configManager.getConfig.mockReturnValue(
      makeConfig([
        {
          id: 'c1',
          name: 'app',
          keyHash: 'h',
          rateLimitTier: 'authenticated',
          groups: ['read-only'],
        },
      ]),
    );
    const ctx = makeCtx('c1', { allow: ['admin'] });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'ACL_DENIED',
    );
    expect((result as { status: number }).status).toBe(403);
  });

  it('denies consumer in denied group even if also in allowed group', async () => {
    configManager.getConfig.mockReturnValue(
      makeConfig([
        {
          id: 'c1',
          name: 'app',
          keyHash: 'h',
          rateLimitTier: 'authenticated',
          groups: ['admin', 'blacklisted'],
        },
      ]),
    );
    const ctx = makeCtx('c1', { allow: ['admin'], deny: ['blacklisted'] });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'ACL_DENIED',
    );
  });

  it('denies unauthenticated request when allow list is set', async () => {
    configManager.getConfig.mockReturnValue(makeConfig([]));
    const ctx = makeCtx(undefined, { allow: ['admin'] });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'ACL_DENIED',
    );
  });

  it('allows consumer with no groups when only deny list has other groups', async () => {
    configManager.getConfig.mockReturnValue(
      makeConfig([
        {
          id: 'c1',
          name: 'app',
          keyHash: 'h',
          rateLimitTier: 'authenticated',
          groups: [],
        },
      ]),
    );
    const ctx = makeCtx('c1', { deny: ['banned'] });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeUndefined();
  });

  it('treats consumer with no groups as empty groups', async () => {
    configManager.getConfig.mockReturnValue(
      makeConfig([
        { id: 'c1', name: 'app', keyHash: 'h', rateLimitTier: 'authenticated' },
      ]),
    );
    const ctx = makeCtx('c1', { allow: ['admin'] });
    const result = await plugin.onRequest(ctx);
    expect(result).toBeDefined();
    expect(JSON.parse((result as { body: string }).body).error).toBe(
      'ACL_DENIED',
    );
  });
});
