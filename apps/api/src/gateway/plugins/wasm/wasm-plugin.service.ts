import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import {
  inspectWasmModule,
  wasmPluginOfRouteName,
  type BaseWsMessage,
  type WasmModuleInspection,
  type WasmModuleMessage,
  type WasmPluginConfig,
  type WasmStatusMessage,
} from '@api-gateway/shared-types';
import {
  DEFAULT_WASM_PLUGINS,
  type WasmPluginSettings,
} from '../../../config/configuration';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service';
import { ControlPlaneConnectorService } from '../../connector/control-plane-connector.service';
import { REDIS_CLIENT } from '../../shared/redis.tokens';
import { PluginRegistryService } from '../plugin-registry.service';
import { sanitizeError } from '../third-party/guarded-plugin';
import { WasmSandbox } from './wasm-sandbox';
import { UnavailableWasmPlugin, WasmPlugin } from './wasm-plugin';

/** Verified modules survive control plane outages in local Redis. */
const CACHE_TTL_SECONDS = 30 * 86400;
const FETCH_RETRY_MS = 5000;
const STATUS_DEBOUNCE_MS = 1000;
const STATUS_INTERVAL_MS = 30000;
const STATUS_MAX_BUFFERED_BYTES = 65536;

interface Compiled {
  module: WebAssembly.Module;
  inspection: WasmModuleInspection;
}

/**
 * Workspace WebAssembly plugins (issue #123). Configuration lists installed
 * plugins by name and digest; the bytes come from the control plane on
 * request, are verified against the digest and the sandbox rules, then run
 * in a WasmSandbox. Unavailable plugins resolve to a fail-closed placeholder.
 */
@Injectable()
export class WasmPluginService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WasmPluginService.name);
  private readonly plugins = new Map<
    string,
    WasmPlugin | UnavailableWasmPlugin
  >();
  private readonly compiled = new Map<string, Compiled>();
  private readonly requested = new Map<string, number>();
  private readonly settings: WasmPluginSettings;
  private retry?: NodeJS.Timeout;
  private statusTimer?: NodeJS.Timeout;
  private statusInterval?: NodeJS.Timeout;
  private syncing: Promise<void> = Promise.resolve();
  private readonly stops: Array<() => void> = [];

  constructor(
    config: ConfigService,
    private readonly registry: PluginRegistryService,
    private readonly gatewayConfig: GatewayConfigManagerService,
    private readonly connector: ControlPlaneConnectorService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.settings = {
      ...DEFAULT_WASM_PLUGINS,
      ...config.get<WasmPluginSettings>('wasmPlugins'),
    };
  }

  onModuleInit() {
    this.registry.addResolver((name) => {
      const plugin = wasmPluginOfRouteName(name);
      if (!plugin) return undefined;
      // Not installed (or not yet configured): fail closed, never skip.
      return (
        this.plugins.get(plugin) ??
        new UnavailableWasmPlugin(plugin, '0'.repeat(64), 'loading', null)
      );
    });
    this.stops.push(
      this.gatewayConfig.subscribeConfig(() => this.scheduleSync()),
      this.connector.onMessage(
        'wasm.module',
        (message) => void this.receive(message as unknown as WasmModuleMessage),
      ),
      this.connector.onAuthenticated(() => {
        this.requested.clear();
        this.reportedEmpty = false;
        this.scheduleSync();
      }),
    );
    this.retry = setInterval(() => this.scheduleSync(), FETCH_RETRY_MS);
    this.retry.unref();
    this.statusInterval = setInterval(() => this.report(), STATUS_INTERVAL_MS);
    this.statusInterval.unref();
    this.scheduleSync();
  }

  async onModuleDestroy() {
    for (const stop of this.stops) stop();
    clearInterval(this.retry);
    clearInterval(this.statusInterval);
    clearTimeout(this.statusTimer);
    await this.syncing;
    await Promise.all(
      [...this.plugins.values()].map((plugin) =>
        plugin instanceof WasmPlugin ? plugin.close() : undefined,
      ),
    );
    this.plugins.clear();
  }

  private scheduleSync() {
    this.syncing = this.syncing
      .then(() => this.sync())
      .catch((error) =>
        this.logger.warn(`WASM plugin sync failed: ${sanitizeError(error)}`),
      );
  }

  private async sync() {
    const desired = new Map<string, WasmPluginConfig>(
      (this.gatewayConfig.getConfig()?.wasmPlugins ?? []).map((entry) => [
        entry.name,
        entry,
      ]),
    );
    let changed = false;
    for (const [name, plugin] of this.plugins) {
      const wanted = desired.get(name);
      if (
        !wanted ||
        wanted.sha256 !== plugin.sha256 ||
        (plugin instanceof WasmPlugin && !this.sameHosts(plugin, wanted))
      ) {
        this.plugins.delete(name);
        if (plugin instanceof WasmPlugin) await plugin.close();
        changed = true;
      }
    }
    for (const [name, entry] of desired) {
      const current = this.plugins.get(name);
      if (current instanceof WasmPlugin) continue;
      const compiled = await this.load(entry.sha256);
      if (compiled) {
        this.plugins.set(name, this.create(entry, compiled));
        changed = true;
      } else if (!(current instanceof UnavailableWasmPlugin)) {
        this.plugins.set(
          name,
          new UnavailableWasmPlugin(name, entry.sha256, 'loading', null),
        );
        changed = true;
      }
    }
    if (changed) this.scheduleReport();
  }

  private readonly hosts = new WeakMap<WasmPlugin, string>();
  private sameHosts(plugin: WasmPlugin, entry: WasmPluginConfig) {
    return this.hosts.get(plugin) === [...entry.allowedHosts].sort().join(',');
  }

  private create(entry: WasmPluginConfig, compiled: Compiled): WasmPlugin {
    const plugin = new WasmPlugin(
      entry.name,
      entry.sha256,
      new WasmSandbox(
        compiled.module,
        compiled.inspection,
        entry.allowedHosts.map((host) => host.toLowerCase()),
        this.settings,
      ),
      compiled.inspection.hooks,
      this.settings,
      () => this.scheduleReport(),
    );
    this.hosts.set(plugin, [...entry.allowedHosts].sort().join(','));
    return plugin;
  }

  /** From memory, then local Redis; otherwise asks the control plane. */
  private async load(sha256: string): Promise<Compiled | null> {
    const known = this.compiled.get(sha256);
    if (known) return known;
    const cached = await this.redis.get(`wasm:${sha256}`).catch(() => null);
    if (cached) {
      const compiled = await this.verify(sha256, cached).catch(() => null);
      if (compiled) return compiled;
    }
    const last = this.requested.get(sha256) ?? 0;
    if (Date.now() - last >= FETCH_RETRY_MS) {
      this.requested.set(sha256, Date.now());
      this.connector.sendTransient(
        { type: 'wasm.fetch', payload: { sha256 } } as BaseWsMessage,
        4096,
      );
    }
    return null;
  }

  private async verify(sha256: string, base64: string): Promise<Compiled> {
    const bytes = Buffer.from(base64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('Module digest does not match the configuration');
    const inspection = inspectWasmModule(bytes);
    const module = await WebAssembly.compile(bytes);
    const compiled = { module, inspection };
    this.compiled.set(sha256, compiled);
    return compiled;
  }

  private async receive(message: WasmModuleMessage) {
    const { sha256, module } = message.payload ?? {};
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return;
    const names = (this.gatewayConfig.getConfig()?.wasmPlugins ?? [])
      .filter((entry) => entry.sha256 === sha256)
      .map((entry) => entry.name);
    if (!names.length) return;
    try {
      if (typeof module !== 'string') throw new Error('Module not found');
      await this.verify(sha256, module);
      await this.redis
        .set(`wasm:${sha256}`, module, 'EX', CACHE_TTL_SECONDS)
        .catch(() => undefined);
    } catch (error) {
      const reason = sanitizeError(error);
      this.logger.warn(`WASM module ${sha256.slice(0, 12)} refused: ${reason}`);
      for (const name of names)
        this.plugins.set(
          name,
          new UnavailableWasmPlugin(name, sha256, 'failed', reason),
        );
      this.scheduleReport();
      return;
    }
    this.scheduleSync();
  }

  private scheduleReport() {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.report();
    }, STATUS_DEBOUNCE_MS);
    this.statusTimer.unref();
  }

  private reportedEmpty = false;
  private report() {
    // Gateways without WASM plugins send one empty report, then stay quiet.
    if (!this.plugins.size && this.reportedEmpty) return;
    this.reportedEmpty = !this.plugins.size;
    this.connector.sendTransient(
      {
        type: 'wasm.status',
        payload: { plugins: this.statuses() },
      } as WasmStatusMessage as unknown as BaseWsMessage,
      STATUS_MAX_BUFFERED_BYTES,
    );
  }

  statuses() {
    return [...this.plugins.values()].map((plugin) => plugin.status());
  }
}
