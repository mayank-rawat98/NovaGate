import {
  GRAPHQL_FEDERATION_PLUGIN,
  type GatewayPlugin,
  type PluginContext,
  type PluginShortCircuit,
} from '@api-gateway/shared-types';
import type { GraphqlFederationService } from './graphql-federation.service';

/**
 * `graphql-federation` route plugin: captures and checks the GraphQL request
 * in the ordered plugin chain. The proxy executes the operation afterwards,
 * once route authentication and metering have run.
 */
export class GraphqlFederationPlugin implements GatewayPlugin {
  readonly name = GRAPHQL_FEDERATION_PLUGIN;
  readonly protocols = ['http'] as const;
  constructor(private readonly federation: GraphqlFederationService) {}

  prepareRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    return this.federation.capture(ctx);
  }

  onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    return this.federation.prepare(ctx);
  }
}
