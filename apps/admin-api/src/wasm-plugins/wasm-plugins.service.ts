import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  MAX_WASM_ALLOWED_HOSTS,
  MAX_WASM_MODULE_BYTES,
  MAX_WASM_PLUGINS,
  THIRD_PARTY_PLUGIN_VERSION_PATTERN,
  WASM_ROUTE_PLUGIN_PREFIX,
  inspectWasmModule,
  isWasmHost,
  isWasmPluginName,
  type WasmPluginState,
  type WasmPluginSummary,
} from '@api-gateway/shared-types';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';
import { WASM_CATALOG } from './catalog.generated';

interface Row {
  name: string;
  version: string;
  description: string;
  sha256: string;
  size: number;
  hooks: WasmPluginSummary['hooks'];
  allowedHosts: string[];
  source: 'catalog' | 'upload';
  catalogId: string | null;
  createdAt: Date;
}

const COLUMNS = `name,version,description,sha256,size,hooks,"allowedHosts",source,"catalogId","createdAt"`;

/**
 * Workspace WebAssembly plugins: install from the curated catalog or upload
 * a module, both checked with the gateway's sandbox rules. Configuration
 * carries name, digest, hooks and allowed hosts; gateways fetch the bytes
 * through the control plane.
 */
@Injectable()
export class WasmPluginsService {
  private readonly catalog = WASM_CATALOG.map((entry) => ({
    ...entry,
    hooks: inspectWasmModule(Buffer.from(entry.module, 'base64')).hooks,
  }));

  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
  ) {}

  private id(tenantId: string) {
    const id = tenantId.toLowerCase();
    return { id, schema: tenantSchema(id) };
  }

  async state(tenantId: string): Promise<WasmPluginState> {
    const { id, schema } = this.id(tenantId);
    const rows: Row[] = await this.db.query(
      `SELECT ${COLUMNS} FROM ${schema}.wasm_plugins WHERE "deletedAt" IS NULL ORDER BY name`,
    );
    const installed = new Set(rows.map((row) => row.catalogId).filter(Boolean));
    const report = await this.push.wasmReport(id);
    return {
      plugins: rows.map(({ createdAt, ...row }) => ({
        ...row,
        installedAt: createdAt.toISOString(),
      })),
      catalog: this.catalog.map(({ module: _module, ...entry }) => ({
        ...entry,
        installed: installed.has(entry.id),
      })),
      ...report,
    };
  }

  async install(tenantId: string, input: unknown) {
    const body = input as Record<string, unknown> | null;
    const entry = this.catalog.find(
      (candidate) =>
        body && typeof body === 'object' && candidate.id === body.catalogId,
    );
    if (!entry || Object.keys(body ?? {}).length !== 1)
      throw new BadRequestException('catalogId must name a catalog plugin');
    const bytes = Buffer.from(entry.module, 'base64');
    return this.store(tenantId, {
      name: entry.name,
      version: entry.version,
      description: entry.description,
      bytes,
      allowedHosts: entry.allowedHosts,
      source: 'catalog',
      catalogId: entry.id,
    });
  }

  async upload(tenantId: string, input: unknown) {
    const body = input as Record<string, unknown> | null;
    const allowed = [
      'name',
      'version',
      'description',
      'module',
      'allowedHosts',
    ];
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !allowed.includes(key))
    )
      throw new BadRequestException(
        'Send name, version, module (base64) and optional description and allowedHosts',
      );
    if (!isWasmPluginName(body.name))
      throw new BadRequestException(
        'name must be lowercase letters, digits and hyphens (up to 64)',
      );
    if (
      typeof body.version !== 'string' ||
      !THIRD_PARTY_PLUGIN_VERSION_PATTERN.test(body.version)
    )
      throw new BadRequestException(
        'version must be an exact version such as 1.0.0',
      );
    if (
      body.description !== undefined &&
      (typeof body.description !== 'string' || body.description.length > 500)
    )
      throw new BadRequestException('description is limited to 500 characters');
    const hosts = body.allowedHosts ?? [];
    if (
      !Array.isArray(hosts) ||
      hosts.length > MAX_WASM_ALLOWED_HOSTS ||
      !hosts.every(isWasmHost) ||
      new Set(hosts).size !== hosts.length
    )
      throw new BadRequestException(
        `allowedHosts lists up to ${MAX_WASM_ALLOWED_HOSTS} unique lowercase hosts (host or host:port)`,
      );
    if (
      typeof body.module !== 'string' ||
      body.module.length > Math.ceil(MAX_WASM_MODULE_BYTES / 3) * 4 + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body.module)
    )
      throw new BadRequestException(
        `module must be a base64-encoded WebAssembly binary of at most ${MAX_WASM_MODULE_BYTES} bytes`,
      );
    return this.store(tenantId, {
      name: body.name,
      version: body.version,
      description: (body.description as string | undefined) ?? '',
      bytes: Buffer.from(body.module, 'base64'),
      allowedHosts: hosts as string[],
      source: 'upload',
      catalogId: null,
    });
  }

  private async store(
    tenantId: string,
    plugin: {
      name: string;
      version: string;
      description: string;
      bytes: Buffer;
      allowedHosts: string[];
      source: 'catalog' | 'upload';
      catalogId: string | null;
    },
  ) {
    let hooks: WasmPluginSummary['hooks'];
    try {
      hooks = inspectWasmModule(plugin.bytes).hooks;
    } catch (error) {
      throw new BadRequestException(
        `The module was refused: ${(error as Error).message}`,
      );
    }
    const { id, schema } = this.id(tenantId);
    const sha256 = createHash('sha256').update(plugin.bytes).digest('hex');
    const payload = await this.db.transaction(async (manager) => {
      await this.lock(manager, id);
      const [{ count }] = await manager.query(
        `SELECT COUNT(*)::int AS count FROM ${schema}.wasm_plugins WHERE "deletedAt" IS NULL`,
      );
      if (count >= MAX_WASM_PLUGINS)
        throw new ConflictException(
          `A workspace can install up to ${MAX_WASM_PLUGINS} WebAssembly plugins`,
        );
      const [existing] = await manager.query(
        `SELECT 1 FROM ${schema}.wasm_plugins WHERE name=$1 AND "deletedAt" IS NULL`,
        [plugin.name],
      );
      if (existing)
        throw new ConflictException(
          `A plugin named ${plugin.name} is installed. Remove it first.`,
        );
      await manager.query(
        `INSERT INTO ${schema}.wasm_plugins (name,version,description,sha256,size,module,hooks,"allowedHosts",source,"catalogId")
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
        [
          plugin.name,
          plugin.version,
          plugin.description,
          sha256,
          plugin.bytes.length,
          plugin.bytes,
          JSON.stringify(hooks),
          JSON.stringify(plugin.allowedHosts),
          plugin.source,
          plugin.catalogId,
        ],
      );
      return this.push.persistUpdate(id, manager);
    });
    await this.push.publish(payload);
    return this.state(id);
  }

  async remove(tenantId: string, name: string) {
    if (!isWasmPluginName(name))
      throw new NotFoundException('Plugin not found');
    const { id, schema } = this.id(tenantId);
    const payload = await this.db.transaction(async (manager) => {
      await this.lock(manager, id);
      // Removing a plugin a route uses would silently fail that route closed.
      const routes: Array<{ method: string; pathPattern: string }> =
        await manager.query(
          `SELECT method,"pathPattern" FROM ${schema}.routes
            WHERE "deletedAt" IS NULL AND plugins @> $1::jsonb LIMIT 5`,
          [JSON.stringify([{ name: `${WASM_ROUTE_PLUGIN_PREFIX}${name}` }])],
        );
      if (routes.length)
        throw new ConflictException(
          `Remove ${WASM_ROUTE_PLUGIN_PREFIX}${name} from these routes first: ${routes
            .map((route) => `${route.method} ${route.pathPattern}`)
            .join(', ')}`,
        );
      const removed = await manager.query(
        `UPDATE ${schema}.wasm_plugins SET "deletedAt"=NOW() WHERE name=$1 AND "deletedAt" IS NULL RETURNING id`,
        [name],
      );
      if (!(Array.isArray(removed[0]) ? removed[0] : removed).length)
        throw new NotFoundException('Plugin not found');
      return this.push.persistUpdate(id, manager);
    });
    await this.push.publish(payload);
    return this.state(id);
  }

  private async lock(manager: EntityManager, tenantId: string) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'wasm-plugins:' + tenantId,
    ]);
  }
}
