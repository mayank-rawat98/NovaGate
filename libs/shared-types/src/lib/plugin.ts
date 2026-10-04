import type {
  IncomingMessage,
  ServerResponse,
  OutgoingHttpHeaders,
} from 'http';
import type { RouteConfig, ServiceConfig } from './ws-messages.js';

export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface PluginContext {
  /** Protocol handlers abort admission work on disconnect or deadline. */
  signal?: AbortSignal;
  req: IncomingMessage & { user?: { id: string }; requestId: string };
  res: ServerResponse;
  route: RouteConfig;
  service: ServiceConfig | undefined;
  tenantId: string;
  requestId: string;
  logger: PluginLogger;
  /** Set only after a plugin has verified inbound credentials. External
   * subjects are distinct from gateway consumer UUIDs used for analytics. */
  authentication?: { method: string; subject?: string };
}

export interface PluginShortCircuit {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export interface GatewayPlugin {
  name: string;
  /** Missing capability declarations default to HTTP only. */
  protocols?: readonly ('http' | 'websocket' | 'grpc')[];

  /**
   * Called before the request reaches the proxy.
   * Return a PluginShortCircuit to stop processing and send that response.
   * Return void to pass to the next plugin.
   */
  onRequest?(ctx: PluginContext): Promise<PluginShortCircuit | void>;

  /**
   * Called after the downstream responds, before the response is sent to client.
   * Can mutate response headers on ctx.res. Cannot change the body (streaming).
   */
  onResponse?(
    ctx: PluginContext & { statusCode: number; headers: OutgoingHttpHeaders },
  ): Promise<void>;

  /**
   * Called when the proxy encounters an error (timeout, 5xx after retries).
   * Return a PluginShortCircuit to send a custom error response.
   * Return void to let the default error handling proceed.
   */
  onError?(
    ctx: PluginContext & { error: Error },
  ): Promise<PluginShortCircuit | void>;
}

export interface OidcPluginConfig {
  jwksUri: string;
  issuer: string;
  audience?: string;
  claimsToForward?: string[];
}
export interface OAuth2PluginConfig {
  /** Exactly one endpoint is required. Outbound injection does not authenticate inbound clients. */
  introspectionEndpoint?: string;
  tokenEndpoint?: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  headerName?: string;
  issuer?: string;
  audience?: string;
}
