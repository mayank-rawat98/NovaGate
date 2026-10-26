import {
  isThirdPartyPluginName,
  type GatewayPlugin,
} from '@api-gateway/shared-types';

const HOOKS = [
  'prepareRequest',
  'onRequest',
  'validateRequest',
  'onResponse',
  'onError',
] as const;
const PROTOCOLS = ['http', 'websocket', 'grpc'];

/**
 * Declares a third-party plugin and checks it with the same rules the gateway
 * loader applies: a scoped package name, at least one hook, function hooks and
 * known protocols. Export the result as the package's default export.
 */
export function definePlugin<T extends GatewayPlugin>(plugin: T): T {
  if (!isThirdPartyPluginName(plugin?.name))
    throw new TypeError(
      'Plugin name must be its scoped npm package name, such as @acme/saml-auth',
    );
  const hooks = HOOKS.filter((hook) => plugin[hook] !== undefined);
  if (!hooks.length)
    throw new TypeError('Plugin must implement at least one hook');
  for (const hook of hooks)
    if (typeof plugin[hook] !== 'function')
      throw new TypeError(`${hook} must be a function`);
  if (
    plugin.protocols !== undefined &&
    (!Array.isArray(plugin.protocols) ||
      !plugin.protocols.every((protocol) => PROTOCOLS.includes(protocol)))
  )
    throw new TypeError('protocols may contain only http, websocket and grpc');
  return plugin;
}
