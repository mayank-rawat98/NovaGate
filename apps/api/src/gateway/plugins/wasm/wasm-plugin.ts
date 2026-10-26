import type { OutgoingHttpHeaders } from 'http';
import {
  WASM_ROUTE_PLUGIN_PREFIX,
  type GatewayPlugin,
  type PluginContext,
  type PluginShortCircuit,
  type WasmHook,
  type WasmPluginRuntimeState,
  type WasmPluginStatus,
} from '@api-gateway/shared-types';
import { sanitizeError } from '../third-party/guarded-plugin';
import {
  WasmSandboxError,
  type WasmCallInput,
  type WasmCallResult,
  type WasmSandbox,
} from './wasm-sandbox';

export interface WasmGuardSettings {
  failureThreshold: number;
  quarantineMs: number;
}

const SAMPLES = 256;

function failClosed(
  status: number,
  error: string,
  message: string,
  ctx: PluginContext,
): PluginShortCircuit {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error, message, requestId: ctx.requestId }),
  };
}

function headers(ctx: PluginContext): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.req.headers))
    if (value !== undefined)
      result[name] = Array.isArray(value) ? value.join(', ') : value;
  return result;
}

/**
 * A workspace-installed WebAssembly plugin on a route (`wasm:<name>`).
 * Every failure fails closed; repeated failures quarantine the plugin.
 */
export class WasmPlugin implements GatewayPlugin {
  readonly name: string;
  readonly protocols = ['http'] as const;
  onRequest?: GatewayPlugin['onRequest'];
  onResponse?: GatewayPlugin['onResponse'];
  private calls = 0;
  private failures = 0;
  private consecutive = 0;
  private quarantinedUntil = 0;
  private lastError: string | null = null;
  private readonly samples: number[] = [];

  constructor(
    readonly plugin: string,
    readonly sha256: string,
    private readonly sandbox: WasmSandbox,
    hooks: WasmHook[],
    private readonly settings: WasmGuardSettings,
    private readonly onChange: () => void,
  ) {
    this.name = `${WASM_ROUTE_PLUGIN_PREFIX}${plugin}`;
    if (hooks.includes('on_request'))
      this.onRequest = (ctx) => this.request(ctx);
    if (hooks.includes('on_response'))
      this.onResponse = (ctx) => this.response(ctx);
  }

  private input(ctx: PluginContext, status?: number): WasmCallInput {
    const entry = ctx.route.plugins?.find((p) => p.name === this.name);
    const [path] = (ctx.req.url ?? '/').split('?');
    return {
      request: {
        method: ctx.req.method ?? 'GET',
        path,
        headers: headers(ctx),
        consumerId: ctx.req.user?.consumerId,
      },
      config: (entry?.config ?? {}) as Record<string, unknown>,
      status,
    };
  }

  private async call(
    hook: WasmHook,
    input: WasmCallInput,
  ): Promise<WasmCallResult> {
    this.calls++;
    try {
      const result = await this.sandbox.run(hook, input);
      // Report the first measured call and recoveries without waiting.
      if (this.consecutive || !this.samples.length) this.onChange();
      this.consecutive = 0;
      this.samples.push(result.elapsedUs);
      if (this.samples.length > SAMPLES) this.samples.shift();
      return result;
    } catch (error) {
      this.failures++;
      this.consecutive++;
      this.lastError = sanitizeError(error);
      if (this.consecutive >= this.settings.failureThreshold)
        this.quarantinedUntil = Date.now() + this.settings.quarantineMs;
      this.onChange();
      throw error;
    }
  }

  private log(ctx: PluginContext, result: WasmCallResult) {
    for (const entry of result.logs)
      ctx.logger[entry.level](
        `[${this.name}] ${entry.message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, 200)}`,
      );
  }

  private async request(
    ctx: PluginContext,
  ): Promise<PluginShortCircuit | void> {
    if (this.quarantinedUntil > Date.now())
      return failClosed(
        503,
        'PLUGIN_UNAVAILABLE',
        'A route plugin is paused after repeated failures',
        ctx,
      );
    let result: WasmCallResult;
    try {
      result = await this.call('on_request', this.input(ctx));
    } catch (error) {
      return error instanceof WasmSandboxError && error.code === 'BUSY'
        ? failClosed(503, 'PLUGIN_BUSY', 'A route plugin is overloaded', ctx)
        : failClosed(502, 'PLUGIN_FAILED', 'A route plugin failed', ctx);
    }
    this.log(ctx, result);
    const { actions } = result;
    if (actions.respond) {
      const body = actions.respond.body;
      const responseHeaders: Record<string, string> = {
        'Content-Type': /^\s*[[{]/.test(body)
          ? 'application/json'
          : 'text/plain; charset=utf-8',
        ...actions.setResponseHeaders,
      };
      return { status: actions.respond.status, headers: responseHeaders, body };
    }
    for (const name of actions.removeRequestHeaders)
      delete ctx.req.headers[name];
    for (const [name, value] of Object.entries(actions.setRequestHeaders))
      ctx.req.headers[name] = value;
    for (const [name, value] of Object.entries(actions.setResponseHeaders))
      if (!ctx.res.headersSent) ctx.res.setHeader(name, value);
  }

  private async response(
    ctx: PluginContext & { statusCode: number; headers: OutgoingHttpHeaders },
  ): Promise<void> {
    // Response hooks cannot fail the request: failures are recorded only.
    if (this.quarantinedUntil > Date.now()) return;
    try {
      const result = await this.call(
        'on_response',
        this.input(ctx, ctx.statusCode),
      );
      this.log(ctx, result);
      for (const [name, value] of Object.entries(
        result.actions.setResponseHeaders,
      ))
        if (!ctx.res.headersSent) ctx.res.setHeader(name, value);
    } catch {
      /* Recorded in status; the response proceeds unchanged. */
    }
  }

  status(): WasmPluginStatus {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
        : null;
    const quarantined = this.quarantinedUntil > Date.now();
    const state: WasmPluginRuntimeState = quarantined
      ? 'quarantined'
      : 'active';
    return {
      name: this.plugin,
      sha256: this.sha256,
      state,
      calls: this.calls,
      failures: this.failures,
      lastError: this.lastError,
      quarantinedUntil: quarantined
        ? new Date(this.quarantinedUntil).toISOString()
        : null,
      p50Us: at(0.5),
      p99Us: at(0.99),
      maxUs: sorted.length ? sorted[sorted.length - 1] : null,
    };
  }

  close() {
    return this.sandbox.close();
  }
}

/** Placeholder while a module is unavailable: routes fail closed. */
export class UnavailableWasmPlugin implements GatewayPlugin {
  readonly name: string;
  readonly protocols = ['http'] as const;
  constructor(
    readonly plugin: string,
    readonly sha256: string,
    readonly state: 'loading' | 'failed',
    readonly lastError: string | null,
  ) {
    this.name = `${WASM_ROUTE_PLUGIN_PREFIX}${plugin}`;
  }
  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit> {
    return failClosed(
      503,
      'PLUGIN_UNAVAILABLE',
      'A route plugin is not available on this gateway',
      ctx,
    );
  }
  status(): WasmPluginStatus {
    return {
      name: this.plugin,
      sha256: this.sha256,
      state: this.state,
      calls: 0,
      failures: 0,
      lastError: this.lastError,
      quarantinedUntil: null,
      p50Us: null,
      p99Us: null,
      maxUs: null,
    };
  }
}
