import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import {
  isThirdPartyPluginName,
  type GatewayPlugin,
  type ThirdPartyPluginStatus,
} from '@api-gateway/shared-types';
import type { GatewayConfig } from '../../../config/configuration';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service';
import { PluginRegistryService } from '../plugin-registry.service';
import {
  GuardedPlugin,
  UnavailablePlugin,
  sanitizeError,
} from './guarded-plugin';

const HOOKS = [
  'prepareRequest',
  'onRequest',
  'validateRequest',
  'onResponse',
  'onError',
] as const;
const PROTOCOLS = new Set(['http', 'websocket', 'grpc']);

/**
 * Loads operator-configured npm plugin packages (trust-based; see phase 6.6
 * for sandboxing). Each package must match its pinned version and export a
 * GatewayPlugin whose name is the package name. Load failures never stop the
 * gateway: routes using an unavailable plugin fail closed.
 */
@Injectable()
export class PluginLoaderService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PluginLoaderService.name);
  private readonly loaded = new Map<
    string,
    GuardedPlugin | UnavailablePlugin
  >();
  /** Real package roots used to attribute asynchronous crashes. */
  private readonly roots = new Map<string, GuardedPlugin>();
  private readonly listeners = new Set<() => void>();
  private crashGuard?: {
    exception: (error: unknown) => void;
    rejection: (reason: unknown) => void;
  };

  constructor(
    private readonly config: ConfigService<GatewayConfig, true>,
    private readonly registry: PluginRegistryService,
    private readonly gatewayConfig: GatewayConfigManagerService,
  ) {}

  onModuleInit() {
    const settings = this.config.get('thirdPartyPlugins', { infer: true });
    if (!settings?.directory || !settings.packages.length) return;
    // Resolve packages only from the operator's plugin directory.
    const resolveFrom = createRequire(join(settings.directory, 'package.json'));
    for (const entry of settings.packages) {
      const identity = { package: entry.package, version: entry.version };
      try {
        const manifestPath = resolveFrom.resolve(
          `${entry.package}/package.json`,
        );
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name !== entry.package)
          throw new Error(
            'package.json name does not match the configured package',
          );
        if (manifest.version !== entry.version)
          throw new Error(
            `installed version ${String(manifest.version).slice(0, 32)} does not match pinned ${entry.version}`,
          );
        const exported = resolveFrom(entry.package) as {
          default?: unknown;
        };
        const plugin = this.validate(
          exported?.default ?? exported,
          entry.package,
        );
        const guarded = new GuardedPlugin(
          plugin,
          identity,
          settings,
          () => {
            const disabled = this.gatewayConfig.getConfig()?.disabledPlugins;
            return Array.isArray(disabled) && disabled.includes(plugin.name);
          },
          () => this.changed(),
        );
        this.registry.register(guarded);
        this.loaded.set(plugin.name, guarded);
        this.roots.set(realpathSync(dirname(manifestPath)) + sep, guarded);
        this.logger.log(
          JSON.stringify({
            msg: 'Loaded third-party plugin',
            plugin: plugin.name,
            version: entry.version,
          }),
        );
      } catch (error) {
        const reason = sanitizeError(error);
        const placeholder = new UnavailablePlugin(
          entry.package,
          identity,
          reason,
        );
        // Never shadow an existing registration with a placeholder.
        if (!this.registry.isKnown(entry.package))
          this.registry.register(placeholder);
        this.loaded.set(entry.package, placeholder);
        this.logger.error(
          JSON.stringify({
            msg: 'Third-party plugin unavailable',
            plugin: entry.package,
            reason,
          }),
        );
      }
    }
    if (this.roots.size) this.installCrashGuard();
  }

  onApplicationShutdown() {
    if (!this.crashGuard) return;
    process.off('uncaughtException', this.crashGuard.exception);
    process.off('unhandledRejection', this.crashGuard.rejection);
    this.crashGuard = undefined;
  }

  private validate(candidate: unknown, packageName: string): GatewayPlugin {
    if (!candidate || typeof candidate !== 'object')
      throw new Error('default export must be a GatewayPlugin object');
    const plugin = candidate as Record<string, unknown>;
    if (plugin.name !== packageName || !isThirdPartyPluginName(plugin.name))
      throw new Error('plugin name must equal its scoped package name');
    if (this.registry.isKnown(plugin.name))
      throw new Error('plugin name is already registered');
    const hooks = HOOKS.filter((hook) => plugin[hook] !== undefined);
    if (!hooks.length) throw new Error('plugin exports no hooks');
    if (hooks.some((hook) => typeof plugin[hook] !== 'function'))
      throw new Error('plugin hooks must be functions');
    if (
      plugin.protocols !== undefined &&
      (!Array.isArray(plugin.protocols) ||
        !plugin.protocols.every((protocol) =>
          PROTOCOLS.has(protocol as string),
        ))
    )
      throw new Error('protocols must list http, websocket or grpc');
    return candidate as GatewayPlugin;
  }

  /**
   * Asynchronous plugin crashes (throws in timers or unhandled rejections)
   * are attributed by stack path and quarantine the plugin. Anything else
   * keeps Node's default fatal behavior.
   */
  private installCrashGuard() {
    const exception = (error: unknown) => {
      if (this.attributeCrash(error)) return;
      // Not a plugin: restore the default handler and crash as Node would.
      this.onApplicationShutdown();
      setImmediate(() => {
        throw error;
      });
    };
    // Unhandled rejections reach the same path Node's default would use.
    const rejection = (reason: unknown) => exception(reason);
    process.on('uncaughtException', exception);
    process.on('unhandledRejection', rejection);
    this.crashGuard = { exception, rejection };
  }

  /** Quarantines the plugin whose installed files appear in the error stack. */
  attributeCrash(error: unknown): boolean {
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    for (const [root, plugin] of this.roots) {
      if (!stack.includes(root)) continue;
      plugin.failed(error, 'crash');
      this.logger.error(
        JSON.stringify({
          msg: 'Third-party plugin crashed; quarantined',
          plugin: plugin.name,
          reason: sanitizeError(error),
        }),
      );
      return true;
    }
    return false;
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  statuses(): ThirdPartyPluginStatus[] {
    return [...this.loaded.values()].map((plugin) => plugin.status());
  }
}
