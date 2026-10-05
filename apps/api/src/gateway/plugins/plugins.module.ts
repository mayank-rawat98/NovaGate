import { Module } from '@nestjs/common';
import { RequestBodyService } from '../shared/request-body.service';
import { IdentityProviderService } from './identity-provider/identity-provider.service';
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
import { GraphqlGuardPlugin } from './graphql-guard/graphql-guard.plugin';
import type { GatewayPlugin } from '@api-gateway/shared-types';

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
  GraphqlGuardPlugin,
];

@Module({
  imports: [ConfigManagerModule],
  providers: [
    // RateLimitService is needed by RateLimitPlugin;
    // REDIS_CLIENT is available globally via RedisModule imported in GatewayModule.
    RateLimitService,
    PluginRegistryService,
    PluginRunnerService,
    IdentityProviderService,
    RequestBodyService,
    ...FIRST_PARTY_PLUGINS,
    // Nest keeps only one provider for a token; explicitly aggregate instances.
    {
      provide: GATEWAY_PLUGIN,
      inject: FIRST_PARTY_PLUGINS,
      useFactory: (...plugins: GatewayPlugin[]) => plugins,
    },
  ],
  exports: [PluginRegistryService, PluginRunnerService, RequestBodyService],
})
export class PluginsModule {}
