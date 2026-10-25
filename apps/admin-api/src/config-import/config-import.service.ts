import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { stringify } from 'yaml';
import {
  CONFIG_PREVIEW_TTL_SECONDS,
  DECLARATIVE_CONFIG_MAX_BYTES,
  DECLARATIVE_CONFIG_MAX_ENTRIES,
  type ConfigApplyResult,
  type ConfigChange,
  type ConfigPreview,
  type DeclarativeConfig,
  type RouteConfig,
  type ServiceConfig,
  type ConsumerConfig,
} from '@api-gateway/shared-types';
import { platformJwtSecret } from '../auth/platform-jwt-secret';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  normalizeConfigDocument,
  parseConfigDocument,
  redactConfigDocument,
  routeKey,
} from './config-document';

interface Snapshot {
  version: number;
  services: ServiceConfig[];
  routes: Array<RouteConfig & { configOrder: number | null }>;
  consumers: ConsumerConfig[];
  document: DeclarativeConfig;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

@Injectable()
export class ConfigImportService implements OnModuleDestroy {
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly tenants = new Map<string, number>();
  private readonly secret = platformJwtSecret();
  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
  ) {}
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.operations]);
  }
  private async admitted<T>(
    tenant: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (
      this.stopping ||
      this.operations.size >= 8 ||
      (this.tenants.get(tenant) ?? 0) >= 2
    )
      throw new ServiceUnavailableException(
        'Configuration tools are busy. Try again shortly.',
      );
    this.tenants.set(tenant, (this.tenants.get(tenant) ?? 0) + 1);
    const operation = Promise.resolve().then(work);
    this.operations.add(operation);
    try {
      return await operation;
    } catch (error) {
      const code =
        (error as { code?: string; driverError?: { code?: string } })
          ?.driverError?.code ?? (error as { code?: string })?.code;
      if (['55P03', '57014', '40P01', '40001'].includes(code ?? ''))
        throw new ServiceUnavailableException(
          'Configuration is busy. No import changes were committed. Preview again and retry.',
        );
      throw error;
    } finally {
      this.operations.delete(operation);
      const count = (this.tenants.get(tenant) ?? 1) - 1;
      if (count) this.tenants.set(tenant, count);
      else this.tenants.delete(tenant);
    }
  }
  private async bounded(manager: EntityManager) {
    await manager.query(
      "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
    );
  }
  private async snapshot(
    tenant: string,
    manager: EntityManager,
  ): Promise<Snapshot> {
    const schema = tenantSchema(tenant);
    const [profile] = await manager.query(
      'SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1',
      [tenant],
    );
    if (!profile) throw new NotFoundException('Workspace not found');
    const services: ServiceConfig[] = await manager.query(
      `SELECT id,name,targets,"healthCheckPath","timeoutMs","healthCheckIntervalMs","healthCheckProtocol","healthCheckService","unhealthyFallback",h2,"supportsWebSocket","loadBalancing","circuitBreaker" FROM ${schema}.services WHERE "deletedAt" IS NULL ORDER BY name COLLATE "C",id LIMIT $1`,
      [DECLARATIVE_CONFIG_MAX_ENTRIES + 1],
    );
    const routes: Snapshot['routes'] = await manager.query(
      `SELECT id,method,"pathPattern","serviceId","authRequired","rateLimitOverride",enabled,retry,plugins,graphql,portal,"configOrder" FROM ${schema}.routes WHERE "deletedAt" IS NULL ORDER BY "configOrder" NULLS LAST,"createdAt",id LIMIT $1`,
      [DECLARATIVE_CONFIG_MAX_ENTRIES + 1],
    );
    const consumers: ConsumerConfig[] = await manager.query(
      // Developer portal keys belong to developers, not the declarative document.
      `SELECT id,name,"keyHash","rateLimitTier",groups FROM ${schema}.consumers WHERE "revokedAt" IS NULL AND "portalDeveloperId" IS NULL ORDER BY name COLLATE "C",id LIMIT $1`,
      [DECLARATIVE_CONFIG_MAX_ENTRIES + 1],
    );
    if (
      services.length + routes.length + consumers.length >
      DECLARATIVE_CONFIG_MAX_ENTRIES
    )
      throw new ConflictException(
        'This workspace exceeds the 200-entry import/export limit. Use individual configuration controls.',
      );
    const names = new Map(
      services.map((service) => [service.id, service.name]),
    );
    const document: DeclarativeConfig = {
      version: 1,
      services: services.map(({ id: _id, ...service }) => service),
      routes: routes.map(
        ({ id: _id, configOrder: _order, portal, ...route }) => ({
          ...route,
          plugins: route.plugins ?? [],
          graphql: route.graphql ?? null,
          // Unpublished routes keep their existing document shape.
          ...(portal ? { portal } : {}),
          serviceId: names.get(route.serviceId) ?? '',
        }),
      ),
      consumers: consumers.map(({ name, rateLimitTier, groups }) => ({
        name,
        rateLimitTier,
        groups: groups ?? [],
      })),
    };
    try {
      normalizeConfigDocument(structuredClone(document));
    } catch {
      throw new ConflictException(
        'Current configuration has ambiguous names, missing services or unsupported fields. Repair it with the individual configuration controls before importing or exporting.',
      );
    }
    return {
      version: profile.gatewayConfigVersion,
      services,
      routes,
      consumers,
      document,
    };
  }
  private signature(
    tenant: string,
    snapshot: Snapshot,
    document: DeclarativeConfig,
    expiry: number,
  ) {
    return createHmac('sha256', this.secret)
      .update(
        canonical([
          'novagate-config-preview-v1',
          tenant,
          snapshot.version,
          snapshot.services,
          snapshot.routes,
          snapshot.consumers,
          document,
          expiry,
        ]),
      )
      .digest('hex');
  }
  private changes(
    current: DeclarativeConfig,
    desired: DeclarativeConfig,
  ): { changes: ConfigChange[]; unchanged: number } {
    const changes: ConfigChange[] = [];
    let unchanged = 0;
    for (const [resource, before, after, key] of [
      [
        'service',
        current.services,
        desired.services,
        (row: Record<string, unknown>) => String(row.name),
      ],
      [
        'route',
        current.routes,
        desired.routes,
        (row: Record<string, unknown>) =>
          routeKey(row as unknown as RouteConfig),
      ],
      [
        'consumer',
        current.consumers,
        desired.consumers,
        (row: Record<string, unknown>) => String(row.name),
      ],
    ] as const) {
      const old = new Map(
        before.map((row) => [
          key(row as unknown as Record<string, unknown>),
          row,
        ]),
      );
      after.forEach((row, index) => {
        const identity = key(row as unknown as Record<string, unknown>);
        const previous = old.get(identity);
        if (!previous)
          changes.push({
            resource,
            key: identity,
            action: 'create',
            fields: Object.keys(row),
          });
        else {
          // Union: an omitted optional field (such as portal) is a removal.
          const fields = [
            ...new Set([...Object.keys(row), ...Object.keys(previous)]),
          ].filter(
            (field) =>
              canonical((row as unknown as Record<string, unknown>)[field]) !==
              canonical(
                (previous as unknown as Record<string, unknown>)[field],
              ),
          );
          if (
            resource === 'route' &&
            before.findIndex(
              (candidate) =>
                key(candidate as unknown as Record<string, unknown>) ===
                identity,
            ) !== index
          )
            fields.push('order');
          if (fields.length)
            changes.push({ resource, key: identity, action: 'update', fields });
          else unchanged++;
        }
        old.delete(identity);
      });
      for (const identity of old.keys())
        changes.push({ resource, key: identity, action: 'remove', fields: [] });
    }
    return { changes, unchanged };
  }
  export(tenant: string): Promise<string> {
    tenantSchema(tenant);
    return this.admitted(tenant, () =>
      this.db.transaction('REPEATABLE READ', async (manager) => {
        await this.bounded(manager);
        const state = await this.snapshot(tenant, manager);
        const safe = redactConfigDocument(state.document);
        const inspect = (value: unknown): void => {
          if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
            let unsafe = true;
            try {
              const url = new URL(value);
              unsafe = !!(
                url.username ||
                url.password ||
                url.search ||
                url.hash
              );
            } catch {
              // Malformed URL-like values receive the same bounded refusal.
            }
            if (unsafe)
              throw new ConflictException(
                'Configuration contains URLs with credentials, query strings or fragments. Use individual configuration controls until those values are removed.',
              );
          } else if (value && typeof value === 'object')
            Object.values(value).forEach(inspect);
        };
        inspect(safe);
        const source =
          '# Complete desired configuration. Missing entries are removed or revoked on apply.\n# Consumer keys and saved plugin credentials are omitted. Matching existing credentials are preserved.\n' +
          stringify(safe);
        try {
          if (Buffer.byteLength(source) > DECLARATIVE_CONFIG_MAX_BYTES)
            throw new Error();
          parseConfigDocument(source);
        } catch {
          throw new ConflictException(
            'Export exceeds the import byte or complexity limits. Reduce configuration with individual controls before exporting.',
          );
        }
        return source;
      }),
    );
  }
  preview(tenant: string, input: unknown): Promise<ConfigPreview> {
    tenantSchema(tenant);
    return this.admitted(tenant, async () => {
      const parsed = parseConfigDocument(input);
      return this.db.transaction('REPEATABLE READ', async (manager) => {
        await this.bounded(manager);
        const state = await this.snapshot(tenant, manager);
        const desired = normalizeConfigDocument(parsed, state.document.routes);
        const expiry =
          Math.floor(Date.now() / 1000) + CONFIG_PREVIEW_TTL_SECONDS;
        return {
          dryRun: true,
          revision: `${expiry}.${this.signature(tenant, state, desired, expiry)}`,
          expiresAt: new Date(expiry * 1000).toISOString(),
          configVersion: state.version,
          ...this.changes(state.document, desired),
          warnings: [
            'This document replaces active services, routes and consumers. Missing services/routes are soft-deleted; missing consumers are revoked.',
            'Matching consumer keys and omitted plugin credentials are preserved. New consumer keys are returned only once after apply.',
            'Saved authentication credentials and transform values are omitted from exports. Supply credentials when importing into a different workspace.',
          ],
        };
      });
    });
  }
  apply(
    tenant: string,
    input: unknown,
    revision: string | undefined,
  ): Promise<ConfigApplyResult> {
    tenantSchema(tenant);
    return this.admitted(tenant, async () => {
      const parsed = parseConfigDocument(input);
      if (
        typeof revision !== 'string' ||
        !/^\d{10}\.[a-f\d]{64}$/.test(revision)
      )
        throw new BadRequestException(
          'Preview the document first and send its revision in If-Match.',
        );
      const result = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        await manager.query(
          'SELECT id FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE',
          [tenant],
        );
        const schema = tenantSchema(tenant);
        // Existing CRUD writes use these tables without the parent-row lock.
        // Block them during reconciliation, including inserts, before rechecking.
        await manager.query(
          `LOCK TABLE ${schema}.services,${schema}.routes,${schema}.consumers IN SHARE ROW EXCLUSIVE MODE`,
        );
        const state = await this.snapshot(tenant, manager);
        const desired = normalizeConfigDocument(parsed, state.document.routes);
        const expiry = Number(revision.split('.')[0]);
        const expected = `${expiry}.${this.signature(tenant, state, desired, expiry)}`;
        if (
          expiry <= Math.floor(Date.now() / 1000) ||
          expiry > Math.floor(Date.now() / 1000) + CONFIG_PREVIEW_TTL_SECONDS ||
          !timingSafeEqual(Buffer.from(revision), Buffer.from(expected))
        )
          throw new ConflictException(
            'Configuration or document changed, or the preview expired. Preview again before applying.',
          );
        const diff = this.changes(state.document, desired);
        if (!diff.changes.length)
          return {
            response: {
              dryRun: false as const,
              configVersion: state.version,
              changed: 0,
              delivery: 'unchanged' as const,
              consumerKeys: [],
            },
            payload: undefined,
          };
        const serviceIds = new Map(
          state.services.map((row) => [row.name, row.id]),
        );
        const services = desired.services.map((row) => ({
          ...row,
          id: serviceIds.get(row.name) ?? randomUUID(),
        }));
        const resolved = new Map(services.map((row) => [row.name, row.id]));
        const routeIds = new Map(
          state.routes.map((row) => [routeKey(row), row.id]),
        );
        const routes = desired.routes.map((row, index) => ({
          ...row,
          id: routeIds.get(routeKey(row)) ?? randomUUID(),
          serviceId: resolved.get(row.serviceId),
          configOrder: index,
        }));
        const oldConsumers = new Map(
          state.consumers.map((row) => [row.name, row]),
        );
        const consumerKeys: ConfigApplyResult['consumerKeys'] = [];
        const consumers = desired.consumers.map((row) => {
          const old = oldConsumers.get(row.name);
          const id = old?.id ?? randomUUID();
          const apiKey = old
            ? undefined
            : `gw_${tenant}_${randomBytes(32).toString('hex')}`;
          if (apiKey) consumerKeys.push({ id, name: row.name, apiKey });
          return {
            ...row,
            id,
            keyHash:
              old?.keyHash ??
              createHash('sha256')
                .update(apiKey as string)
                .digest('hex'),
          };
        });
        await manager.query(
          `INSERT INTO ${schema}.services AS s (id,name,targets,"healthCheckPath","timeoutMs","healthCheckIntervalMs","healthCheckProtocol","healthCheckService","unhealthyFallback",h2,"supportsWebSocket","loadBalancing","circuitBreaker")
          SELECT id,name,targets,"healthCheckPath","timeoutMs","healthCheckIntervalMs","healthCheckProtocol","healthCheckService","unhealthyFallback",h2,"supportsWebSocket","loadBalancing","circuitBreaker"
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,name text,targets jsonb,"healthCheckPath" text,"timeoutMs" integer,"healthCheckIntervalMs" integer,"healthCheckProtocol" text,"healthCheckService" text,"unhealthyFallback" boolean,h2 boolean,"supportsWebSocket" boolean,"loadBalancing" text,"circuitBreaker" jsonb)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,targets=EXCLUDED.targets,"healthCheckPath"=EXCLUDED."healthCheckPath","timeoutMs"=EXCLUDED."timeoutMs","healthCheckIntervalMs"=EXCLUDED."healthCheckIntervalMs","healthCheckProtocol"=EXCLUDED."healthCheckProtocol","healthCheckService"=EXCLUDED."healthCheckService","unhealthyFallback"=EXCLUDED."unhealthyFallback",h2=EXCLUDED.h2,"supportsWebSocket"=EXCLUDED."supportsWebSocket","loadBalancing"=EXCLUDED."loadBalancing","circuitBreaker"=EXCLUDED."circuitBreaker"`,
          [JSON.stringify(services)],
        );
        await manager.query(
          `INSERT INTO ${schema}.routes AS r (id,method,"pathPattern","serviceId","authRequired","rateLimitOverride",enabled,retry,plugins,graphql,portal,"configOrder")
          SELECT id,method,"pathPattern","serviceId","authRequired","rateLimitOverride",enabled,retry,plugins,graphql,portal,"configOrder"
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,method text,"pathPattern" text,"serviceId" uuid,"authRequired" boolean,"rateLimitOverride" integer,enabled boolean,retry jsonb,plugins jsonb,graphql jsonb,portal jsonb,"configOrder" integer)
          ON CONFLICT(id) DO UPDATE SET method=EXCLUDED.method,"pathPattern"=EXCLUDED."pathPattern","serviceId"=EXCLUDED."serviceId","authRequired"=EXCLUDED."authRequired","rateLimitOverride"=EXCLUDED."rateLimitOverride",enabled=EXCLUDED.enabled,retry=EXCLUDED.retry,plugins=EXCLUDED.plugins,graphql=EXCLUDED.graphql,portal=EXCLUDED.portal,"configOrder"=EXCLUDED."configOrder"`,
          [JSON.stringify(routes)],
        );
        await manager.query(
          `INSERT INTO ${schema}.consumers AS c (id,name,"keyHash","rateLimitTier",groups)
          SELECT id,name,"keyHash","rateLimitTier",groups FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,name text,"keyHash" text,"rateLimitTier" text,groups jsonb)
          ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,"rateLimitTier"=EXCLUDED."rateLimitTier",groups=EXCLUDED.groups`,
          [JSON.stringify(consumers)],
        );
        await manager.query(
          `UPDATE ${schema}.routes SET "deletedAt"=clock_timestamp() WHERE "deletedAt" IS NULL AND NOT(id=ANY($1::uuid[]))`,
          [routes.map((row) => row.id)],
        );
        await manager.query(
          `UPDATE ${schema}.services SET "deletedAt"=clock_timestamp() WHERE "deletedAt" IS NULL AND NOT(id=ANY($1::uuid[]))`,
          [services.map((row) => row.id)],
        );
        await manager.query(
          `UPDATE ${schema}.consumers SET "revokedAt"=clock_timestamp() WHERE "revokedAt" IS NULL AND "portalDeveloperId" IS NULL AND NOT(id=ANY($1::uuid[]))`,
          [consumers.map((row) => row.id)],
        );
        const payload = await this.push.persistUpdate(tenant, manager);
        return {
          response: {
            dryRun: false as const,
            configVersion: payload.version,
            changed: diff.changes.length,
            delivery: 'queued' as const,
            consumerKeys,
          },
          payload,
        };
      });
      if (result.payload) await this.push.publish(result.payload);
      return result.response;
    });
  }
}
