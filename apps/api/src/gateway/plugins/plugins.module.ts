import { Module } from '@nestjs/common';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { ConfigManagerModule } from '../config-manager/config-manager.module';
import { GATEWAY_PLUGIN } from './gateway-plugin.token';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginRunnerService } from './plugin-runner.service';
import { CorsPlugin } from './cors/cors.plugin';
import { IpRestrictionPlugin } from './ip-restriction/ip-restriction.plugin';
import { RequestSizeLimitPlugin } from './request-size-limit/request-size-limit.plugin';
import { RateLimitPlugin } from './rate-limit/rate-limit.plugin';
import { RequestTransformPlugin } from './request-transform/request-transform.plugin';
import { ResponseTransformPlugin } from './response-transform/response-transform.plugin';
import { BasicAuthPlugin } from './basic-auth/basic-auth.plugin';
import { OidcPlugin } from './oidc/oidc.plugin';
import { OAuth2ClientCredentialsPlugin } from './oauth2-client-credentials/oauth2-client-credentials.plugin';
import { HmacAuthPlugin } from './hmac-auth/hmac-auth.plugin';
import { AclPlugin } from './acl/acl.plugin';
import { MtlsPlugin } from './mtls/mtls.plugin';

const FIRST_PARTY_PLUGINS = [
  CorsPlugin,
  IpRestrictionPlugin,
  RequestSizeLimitPlugin,
  RateLimitPlugin,
  RequestTransformPlugin,
  ResponseTransformPlugin,
  BasicAuthPlugin,
  OidcPlugin,
  OAuth2ClientCredentialsPlugin,
  HmacAuthPlugin,
  AclPlugin,
  MtlsPlugin,
];

@Module({
  imports: [ConfigManagerModule],
  providers: [
    // RateLimitService is needed by RateLimitPlugin;
    // REDIS_CLIENT is available globally via RedisModule imported in GatewayModule.
    RateLimitService,
    PluginRegistryService,
    PluginRunnerService,
    ...FIRST_PARTY_PLUGINS,
    // Each plugin is also registered under the multi-provider token so the
    // registry can collect them all without knowing each class by name.
    ...FIRST_PARTY_PLUGINS.map((Plugin) => ({
      provide: GATEWAY_PLUGIN,
      useExisting: Plugin,
    })),
  ],
  exports: [PluginRegistryService, PluginRunnerService],
})
export class PluginsModule {}
