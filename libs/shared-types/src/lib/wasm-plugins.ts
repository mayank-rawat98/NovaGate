/**
 * WebAssembly plugins (roadmap 6.6): untrusted per-workspace plugins run in
 * a gateway sandbox with no WASI, no filesystem and no network except the
 * `http_get` host function to allowlisted hosts. Modules import their memory
 * from the host (capped) and may import only the `novagate` host functions.
 */

/** Route plugin names for WASM plugins: `wasm:<name>`. */
export const WASM_PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const WASM_ROUTE_PLUGIN_PREFIX = 'wasm:';
export const MAX_WASM_MODULE_BYTES = 1048576;
export const MAX_WASM_PLUGINS = 32;
/** 160 pages of 64 KiB: 10 MiB. */
export const WASM_MEMORY_MAX_PAGES = 160;
export const DEFAULT_WASM_TIMEOUT_MS = 50;
export const MAX_WASM_ALLOWED_HOSTS = 16;
export const WASM_HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/** Host functions a module may import from the `novagate` module. */
export const WASM_HOST_FUNCTIONS = [
  'log',
  'get_method',
  'get_path',
  'get_header',
  'get_config',
  'get_consumer',
  'get_response_status',
  'set_request_header',
  'remove_request_header',
  'set_response_header',
  'respond',
  'http_get',
] as const;
export type WasmHostFunction = (typeof WASM_HOST_FUNCTIONS)[number];
export const WASM_HOOKS = ['on_request', 'on_response'] as const;
export type WasmHook = (typeof WASM_HOOKS)[number];

export function isWasmPluginName(value: unknown): value is string {
  return typeof value === 'string' && WASM_PLUGIN_NAME_PATTERN.test(value);
}
/** `wasm:<name>` route plugin entry name → plugin name, or null. */
export function wasmPluginOfRouteName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(WASM_ROUTE_PLUGIN_PREFIX))
    return null;
  const plugin = name.slice(WASM_ROUTE_PLUGIN_PREFIX.length);
  return isWasmPluginName(plugin) ? plugin : null;
}

export interface WasmModuleInspection {
  hooks: WasmHook[];
  /** Imported memory limits in 64 KiB pages; max is capped by the host. */
  memory: { initial: number; maximum: number | null };
  imports: WasmHostFunction[];
}

class Reader {
  offset = 0;
  private readonly bytes: Uint8Array;
  private readonly end: number;
  constructor(bytes: Uint8Array, end = bytes.length) {
    this.bytes = bytes;
    this.end = end;
  }
  byte(): number {
    if (this.offset >= this.end) throw new Error('Truncated module');
    return this.bytes[this.offset++];
  }
  u32(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) {
        if (result > 0xffffffff) throw new Error('Invalid integer');
        return result;
      }
    }
    throw new Error('Invalid integer');
  }
  name(): string {
    const length = this.u32();
    if (this.offset + length > this.end) throw new Error('Truncated name');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      this.bytes.subarray(this.offset, this.offset + length),
    );
    this.offset += length;
    return text;
  }
  limits(): { initial: number; maximum: number | null } {
    const flags = this.byte();
    // Shared and 64-bit memories are refused: flags must be 0 or 1.
    if (flags > 1) throw new Error('Unsupported memory or table limits');
    const initial = this.u32();
    return { initial, maximum: flags === 1 ? this.u32() : null };
  }
  skip(length: number) {
    if (this.offset + length > this.end) throw new Error('Truncated section');
    this.offset += length;
  }
}

/**
 * Checks a module's structure without running it: imports only the
 * `novagate` host functions and `env.memory`, defines no memory of its own,
 * and exports at least one hook. Throws with an operator-readable reason.
 */
export function inspectWasmModule(bytes: Uint8Array): WasmModuleInspection {
  if (bytes.length > MAX_WASM_MODULE_BYTES)
    throw new Error(`Modules are limited to ${MAX_WASM_MODULE_BYTES} bytes`);
  const reader = new Reader(bytes);
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const expected of header)
    if (reader.byte() !== expected)
      throw new Error('Not a WebAssembly 1.0 binary module');
  const imports = new Set<WasmHostFunction>();
  const hooks = new Set<WasmHook>();
  let memory: WasmModuleInspection['memory'] | null = null;
  const seen = new Set<number>();
  while (reader.offset < bytes.length) {
    const id = reader.byte();
    const size = reader.u32();
    const end = reader.offset + size;
    if (end > bytes.length) throw new Error('Truncated section');
    if (id !== 0) {
      if (seen.has(id)) throw new Error('Duplicate section');
      seen.add(id);
    }
    const section = new Reader(bytes, end);
    section.offset = reader.offset;
    if (id === 2) {
      for (let count = section.u32(); count > 0; count--) {
        const module = section.name();
        const field = section.name();
        const kind = section.byte();
        if (module === 'env' && field === 'memory' && kind === 2) {
          memory = section.limits();
          continue;
        }
        if (
          module !== 'novagate' ||
          kind !== 0 ||
          !(WASM_HOST_FUNCTIONS as readonly string[]).includes(field)
        )
          throw new Error(
            `Import ${module}.${field} is not available in the sandbox (no WASI, filesystem or network)`,
          );
        section.u32();
        imports.add(field as WasmHostFunction);
      }
    } else if (id === 5) {
      throw new Error(
        'Modules must import their memory as env.memory so the sandbox can cap it',
      );
    } else if (id === 7) {
      for (let count = section.u32(); count > 0; count--) {
        const name = section.name();
        const kind = section.byte();
        section.u32();
        if (kind === 0 && (WASM_HOOKS as readonly string[]).includes(name))
          hooks.add(name as WasmHook);
      }
    }
    reader.skip(size);
  }
  if (!memory) throw new Error('Modules must import env.memory');
  if (memory.initial > WASM_MEMORY_MAX_PAGES)
    throw new Error(
      `Initial memory exceeds the ${WASM_MEMORY_MAX_PAGES}-page (10 MiB) limit`,
    );
  if (!hooks.size)
    throw new Error('Modules must export on_request or on_response');
  return { hooks: [...hooks], memory, imports: [...imports] };
}

export function isWasmHost(value: unknown): value is string {
  return typeof value === 'string' && WASM_HOST_PATTERN.test(value);
}

/** Gateway-facing metadata in TenantConfig; bytes travel separately. */
export interface WasmPluginConfig {
  name: string;
  sha256: string;
  hooks: WasmHook[];
  /** Hosts `http_get` may call (exact host, optional port), HTTPS only. */
  allowedHosts: string[];
}

export interface WasmPluginSummary extends WasmPluginConfig {
  version: string;
  size: number;
  source: 'catalog' | 'upload';
  catalogId: string | null;
  description: string;
  installedAt: string;
}

export interface WasmCatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Route configuration keys the plugin reads, with their meaning. */
  configKeys: Array<{ key: string; description: string }>;
  hooks: WasmHook[];
  allowedHosts: string[];
  sha256: string;
  size: number;
}

export interface WasmPluginState {
  plugins: WasmPluginSummary[];
  catalog: Array<WasmCatalogEntry & { installed: boolean }>;
  /** The gateway's last runtime report, if fresh. */
  reportedAt: string | null;
  statuses: WasmPluginStatus[];
}

export interface InstallWasmPlugin {
  catalogId: string;
}
export interface UploadWasmPlugin {
  name: string;
  version: string;
  description?: string;
  /** Base64-encoded module. */
  module: string;
  allowedHosts?: string[];
}

/** Gateway → control plane: fetch a module's bytes by digest. */
export interface WasmFetchMessage {
  type: 'wasm.fetch';
  payload: { sha256: string };
}
/** Control plane → gateway: the module, or null when the workspace has none. */
export interface WasmModuleMessage {
  type: 'wasm.module';
  payload: { sha256: string; module: string | null };
}

export type WasmPluginRuntimeState =
  /** Module received and verified; hooks run. */
  | 'active'
  /** Paused after repeated failures; routes using it fail closed. */
  | 'quarantined'
  /** Module not yet received from the control plane; routes fail closed. */
  | 'loading'
  /** Module failed verification or instantiation; routes fail closed. */
  | 'failed';

/** Gateway's view of one WASM plugin, with recent execution times. */
export interface WasmPluginStatus {
  name: string;
  sha256: string;
  state: WasmPluginRuntimeState;
  calls: number;
  failures: number;
  lastError: string | null;
  quarantinedUntil: string | null;
  /** Execution time inside the sandbox over recent calls, microseconds. */
  p50Us: number | null;
  p99Us: number | null;
  maxUs: number | null;
}

/** Gateway → control plane transient report. */
export interface WasmStatusMessage {
  type: 'wasm.status';
  payload: { plugins: WasmPluginStatus[] };
}

const RUNTIME_STATES: readonly WasmPluginRuntimeState[] = [
  'active',
  'quarantined',
  'loading',
  'failed',
];
const SHA256 = /^[a-f0-9]{64}$/;
const micros = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Validated copy of a gateway WASM report, or null when anything is off. */
export function parseWasmStatuses(value: unknown): WasmPluginStatus[] | null {
  if (!Array.isArray(value) || value.length > MAX_WASM_PLUGINS) return null;
  const parsed: WasmPluginStatus[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    const item = entry as Record<string, unknown> | null;
    if (
      !item ||
      typeof item !== 'object' ||
      !isWasmPluginName(item.name) ||
      names.has(item.name) ||
      typeof item.sha256 !== 'string' ||
      !SHA256.test(item.sha256) ||
      !RUNTIME_STATES.includes(item.state as WasmPluginRuntimeState) ||
      !Number.isSafeInteger(item.calls) ||
      (item.calls as number) < 0 ||
      !Number.isSafeInteger(item.failures) ||
      (item.failures as number) < 0 ||
      !(
        item.lastError === null ||
        (typeof item.lastError === 'string' && item.lastError.length <= 200)
      ) ||
      !(
        item.quarantinedUntil === null ||
        (typeof item.quarantinedUntil === 'string' &&
          item.quarantinedUntil.length <= 40 &&
          !Number.isNaN(Date.parse(item.quarantinedUntil)))
      ) ||
      !micros(item.p50Us) ||
      !micros(item.p99Us) ||
      !micros(item.maxUs)
    )
      return null;
    names.add(item.name);
    parsed.push({
      name: item.name,
      sha256: item.sha256,
      state: item.state as WasmPluginRuntimeState,
      calls: item.calls as number,
      failures: item.failures as number,
      lastError: item.lastError as string | null,
      quarantinedUntil: item.quarantinedUntil as string | null,
      p50Us: item.p50Us as number | null,
      p99Us: item.p99Us as number | null,
      maxUs: item.maxUs as number | null,
    });
  }
  return parsed;
}
