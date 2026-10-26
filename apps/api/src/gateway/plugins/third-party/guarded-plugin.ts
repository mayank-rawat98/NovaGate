import type { OutgoingHttpHeaders } from 'http';
import {
  MAX_PLUGIN_STATUS_ERROR_LENGTH,
  type GatewayPlugin,
  type PluginContext,
  type PluginShortCircuit,
  type ThirdPartyPluginStatus,
} from '@api-gateway/shared-types';

export interface GuardSettings {
  hookTimeoutMs: number;
  failureThreshold: number;
  quarantineMs: number;
}

type RequestHook = 'prepareRequest' | 'onRequest' | 'validateRequest';
const REQUEST_HOOKS: RequestHook[] = [
  'prepareRequest',
  'onRequest',
  'validateRequest',
];

export class PluginTimeoutError extends Error {
  constructor(hook: string, ms: number) {
    super(`${hook} exceeded ${ms} ms`);
  }
}

/** One-line, bounded failure text: no stack, request data or control characters. */
export function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : 'Non-error thrown';
  return message
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .trim()
    .slice(0, MAX_PLUGIN_STATUS_ERROR_LENGTH);
}

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

/**
 * Runs an operator-trusted third-party plugin with bounded hooks. Failures,
 * timeouts and crashes never escape: request hooks fail closed, response and
 * error hooks are skipped. Repeated failures quarantine the plugin.
 */
export class GuardedPlugin implements GatewayPlugin {
  readonly name: string;
  readonly protocols: readonly ('http' | 'websocket' | 'grpc')[];
  prepareRequest?: GatewayPlugin['prepareRequest'];
  validateRequest?: GatewayPlugin['validateRequest'];
  private consecutive = 0;
  private quarantinedUntil = 0;
  private lastError: string | null = null;

  constructor(
    private readonly plugin: GatewayPlugin,
    private readonly identity: { package: string; version: string },
    private readonly settings: GuardSettings,
    private readonly isDisabled: () => boolean,
    private readonly onChange: () => void,
  ) {
    this.name = plugin.name;
    this.protocols = [...(plugin.protocols ?? ['http'])];
    for (const hook of ['prepareRequest', 'validateRequest'] as const)
      if (typeof plugin[hook] === 'function')
        this[hook] = (ctx) => this.request(hook, ctx);
  }

  /** Always present so disabled or quarantined plugins fail closed. */
  onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    return this.request('onRequest', ctx);
  }

  async onResponse(
    ctx: PluginContext & { statusCode: number; headers: OutgoingHttpHeaders },
  ): Promise<void> {
    if (!this.plugin.onResponse || this.blocked()) return;
    await this.guard('onResponse', () => this.plugin.onResponse?.(ctx)).catch(
      () => undefined,
    );
  }

  async onError(
    ctx: PluginContext & { error: Error },
  ): Promise<PluginShortCircuit | void> {
    if (!this.plugin.onError || this.blocked()) return;
    return this.guard('onError', () => this.plugin.onError?.(ctx)).catch(
      () => undefined,
    );
  }

  private blocked(): boolean {
    return this.isDisabled() || this.quarantinedUntil > Date.now();
  }

  private async request(
    hook: RequestHook,
    ctx: PluginContext,
  ): Promise<PluginShortCircuit | void> {
    if (this.isDisabled())
      return failClosed(
        503,
        'PLUGIN_DISABLED',
        'A plugin required by this route is disabled',
        ctx,
      );
    if (this.quarantinedUntil > Date.now())
      return failClosed(
        503,
        'PLUGIN_UNAVAILABLE',
        'A plugin required by this route is temporarily unavailable',
        ctx,
      );
    const implementation = this.plugin[hook];
    if (typeof implementation !== 'function') return;
    try {
      return await this.guard(hook, () =>
        implementation.call(this.plugin, ctx),
      );
    } catch {
      return failClosed(502, 'PLUGIN_FAILED', 'A route plugin failed', ctx);
    }
  }

  private guard<T>(
    hook: string,
    run: () => Promise<T> | T | undefined,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    // Promise.resolve().then also captures synchronous throws.
    const work = Promise.resolve().then(run) as Promise<T>;
    // A hook that settles after its timeout must not raise an unhandled rejection.
    work.catch(() => undefined);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PluginTimeoutError(hook, this.settings.hookTimeoutMs)),
        this.settings.hookTimeoutMs,
      );
      timer.unref();
    });
    return Promise.race([work, deadline]).then(
      (value) => {
        clearTimeout(timer);
        this.succeeded();
        return value;
      },
      (error: unknown) => {
        clearTimeout(timer);
        this.failed(
          error,
          error instanceof PluginTimeoutError ? 'timeout' : 'error',
        );
        throw error;
      },
    );
  }

  private succeeded() {
    if (this.consecutive === 0) return;
    this.consecutive = 0;
    this.onChange();
  }

  /** Records a failure observed by a hook or attributed by the crash guard. */
  failed(error: unknown, kind: 'error' | 'timeout' | 'crash') {
    this.consecutive++;
    this.lastError = sanitizeError(error);
    if (kind === 'crash' || this.consecutive >= this.settings.failureThreshold)
      this.quarantinedUntil = Date.now() + this.settings.quarantineMs;
    this.onChange();
  }

  status(): ThirdPartyPluginStatus {
    const quarantined = this.quarantinedUntil > Date.now();
    return {
      name: this.name,
      package: this.identity.package,
      version: this.identity.version,
      state: this.isDisabled()
        ? 'disabled'
        : quarantined
          ? 'quarantined'
          : 'active',
      protocols: [...this.protocols],
      hooks: [
        ...REQUEST_HOOKS,
        'onResponse' as const,
        'onError' as const,
      ].filter((hook) => typeof this.plugin[hook] === 'function'),
      failures: this.consecutive,
      lastError: this.lastError,
      quarantinedUntil: quarantined
        ? new Date(this.quarantinedUntil).toISOString()
        : null,
    };
  }
}

/** Placeholder for a configured package that could not be loaded. */
export class UnavailablePlugin implements GatewayPlugin {
  readonly protocols = ['http', 'websocket', 'grpc'] as const;
  constructor(
    readonly name: string,
    private readonly identity: { package: string; version: string },
    private readonly reason: string,
  ) {}
  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit> {
    return failClosed(
      503,
      'PLUGIN_UNAVAILABLE',
      'A plugin required by this route is not installed on this gateway',
      ctx,
    );
  }
  status(): ThirdPartyPluginStatus {
    return {
      name: this.name,
      package: this.identity.package,
      version: this.identity.version,
      state: 'failed',
      protocols: [],
      hooks: [],
      failures: 0,
      lastError: this.reason,
      quarantinedUntil: null,
    };
  }
}
