import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { REDIS_CLIENT } from '../shared/redis.tokens';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { PluginsModule } from './plugins.module';
import { PluginRegistryService } from './plugin-registry.service';

@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, useValue: {} }],
  exports: [REDIS_CLIENT],
})
class TestRedisModule {}

describe('First-party plugin registration through Nest', () => {
  it('resolves every configured plugin in order, and rejects unknown names', async () => {
    const module = await Test.createTestingModule({
      imports: [TestRedisModule, PluginsModule],
    })
      .overrideProvider(RateLimitService)
      .useValue({})
      .overrideProvider(GatewayConfigManagerService)
      .useValue({})
      .compile();
    const registry = module.get(PluginRegistryService);
    const names = [
      'cors',
      'ip-restriction',
      'request-size-limit',
      'rate-limit',
      'request-transform',
      'response-transform',
      'basic-auth',
      'oidc',
      'oauth2-client-credentials',
      'hmac-auth',
      'acl',
      'mtls',
      'graphql-guard',
    ];
    expect(registry.getRegisteredNames()).toEqual(names);
    expect(
      registry
        .resolve(names.map((name) => ({ name, config: {} })))
        .map((p) => p.name),
    ).toEqual(names);
    expect(() =>
      registry.resolve([{ name: 'unavailable-auth', config: {} }]),
    ).toThrow('Unknown configured plugin');
    await module.close();
  });
});
