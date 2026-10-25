import { Injectable, Inject, Optional } from '@nestjs/common';
import type { GatewayPlugin } from '@api-gateway/shared-types';
import { GATEWAY_PLUGIN } from './gateway-plugin.token';

@Injectable()
export class PluginRegistryService {
  private readonly pluginMap = new Map<string, GatewayPlugin>();

  constructor(
    @Optional()
    @Inject(GATEWAY_PLUGIN)
    plugins: GatewayPlugin | GatewayPlugin[],
  ) {
    if (!plugins) return;
    const list = Array.isArray(plugins) ? plugins : [plugins];
    for (const plugin of list) {
      this.pluginMap.set(plugin.name, plugin);
    }
  }

  resolve(
    pluginEntries: Array<{ name: string; config: Record<string, unknown> }>,
  ): GatewayPlugin[] {
    const seen = new Set<string>();
    return pluginEntries.map((entry) => {
      if (seen.has(entry.name))
        throw new Error(`Duplicate configured plugin: ${entry.name}`);
      seen.add(entry.name);
      const plugin = this.pluginMap.get(entry.name);
      if (!plugin) throw new Error(`Unknown configured plugin: ${entry.name}`);
      return plugin;
    });
  }

  /** Adds an operator-loaded plugin; names are unique across all plugins. */
  register(plugin: GatewayPlugin): void {
    if (this.pluginMap.has(plugin.name))
      throw new Error(`Plugin already registered: ${plugin.name}`);
    this.pluginMap.set(plugin.name, plugin);
  }

  isKnown(name: string): boolean {
    return this.pluginMap.has(name);
  }

  getRegisteredNames(): string[] {
    return [...this.pluginMap.keys()];
  }
}
