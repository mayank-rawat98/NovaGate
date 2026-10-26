import { randomUUID } from 'node:crypto';
import {
  IncomingMessage,
  ServerResponse,
  type OutgoingHttpHeaders,
} from 'node:http';
import { Socket } from 'node:net';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
  RouteConfig,
  ServiceConfig,
} from '@api-gateway/shared-types';

export interface MockLogEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

export interface MockContextOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Request body made available on ctx.req as a readable stream. */
  body?: string | Buffer;
  /** Merged into a default GET /test route with no plugins. */
  route?: Partial<RouteConfig>;
  service?: ServiceConfig;
  tenantId?: string;
  requestId?: string;
  user?: { id: string };
  authentication?: PluginContext['authentication'];
  signal?: AbortSignal;
}

export type MockContext = PluginContext & {
  /** Messages written through ctx.logger. */
  logs: MockLogEntry[];
};

/**
 * Builds a PluginContext from real Node HTTP objects, so plugins exercise
 * the same header, stream and response APIs they see in the gateway.
 */
export function createMockContext(
  options: MockContextOptions = {},
): MockContext {
  const socket = new Socket();
  const req = new IncomingMessage(socket) as PluginContext['req'];
  req.method = (options.method ?? 'GET').toUpperCase();
  req.url = options.url ?? '/test';
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flat();
  const requestId = options.requestId ?? randomUUID();
  req.requestId = requestId;
  if (options.user) req.user = options.user;
  req.push(options.body ?? null);
  if (options.body !== undefined) req.push(null);
  const res = new ServerResponse(req);
  const logs: MockLogEntry[] = [];
  const log =
    (level: MockLogEntry['level']) =>
    (msg: string, meta?: Record<string, unknown>) =>
      logs.push({ level, msg, ...(meta ? { meta } : {}) });
  return {
    req,
    res,
    route: {
      id: randomUUID(),
      method: 'GET',
      pathPattern: '/test',
      serviceId: randomUUID(),
      authRequired: false,
      enabled: true,
      plugins: [],
      ...options.route,
    },
    service: options.service,
    tenantId: options.tenantId ?? randomUUID(),
    requestId,
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    authentication: options.authentication,
    signal: options.signal,
    logs,
  };
}

export interface RunPluginOptions {
  /** Upstream status for onResponse; omit to skip the response phase. */
  statusCode?: number;
  responseHeaders?: OutgoingHttpHeaders;
  /** Upstream error for onError; runs instead of onResponse. */
  error?: Error;
}

export interface RunPluginResult {
  /** First short-circuit response and the hook that returned it. */
  shortCircuit?: PluginShortCircuit;
  phase?: 'prepareRequest' | 'onRequest' | 'validateRequest' | 'onError';
  /** Hooks that ran, in order. */
  ran: string[];
}

/**
 * Runs one plugin through the gateway's hook order: prepareRequest,
 * onRequest, validateRequest, then onResponse (or onError). Stops at the
 * first short-circuit, as the gateway does. Exceptions propagate so tests
 * can assert them; in the gateway they fail the request closed.
 */
export async function runPlugin(
  plugin: GatewayPlugin,
  ctx: PluginContext,
  options: RunPluginOptions = {},
): Promise<RunPluginResult> {
  const ran: string[] = [];
  for (const phase of [
    'prepareRequest',
    'onRequest',
    'validateRequest',
  ] as const) {
    const hook = plugin[phase];
    if (!hook) continue;
    ran.push(phase);
    const result = await hook.call(plugin, ctx);
    if (result) return { shortCircuit: result, phase, ran };
  }
  if (options.error) {
    if (plugin.onError) {
      ran.push('onError');
      const result = await plugin.onError({ ...ctx, error: options.error });
      if (result) return { shortCircuit: result, phase: 'onError', ran };
    }
    return { ran };
  }
  if (options.statusCode !== undefined && plugin.onResponse) {
    ran.push('onResponse');
    await plugin.onResponse({
      ...ctx,
      statusCode: options.statusCode,
      headers: options.responseHeaders ?? {},
    });
  }
  return { ran };
}
