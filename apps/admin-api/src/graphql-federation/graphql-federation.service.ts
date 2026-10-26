import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parse, type DocumentNode } from 'graphql';
import { composeServices } from '@theguild/federation-composition';
import { DataSource, EntityManager } from 'typeorm';
import {
  DEFAULT_SUBGRAPH_PATH,
  GRAPHQL_FEDERATION_PLUGIN,
  MAX_FEDERATED_GRAPHS,
  MAX_SUBGRAPHS,
  MAX_SUBGRAPH_SDL_BYTES,
  MAX_SUPERGRAPH_SDL_BYTES,
  isFederatedGraphName,
  isSubgraphPath,
  subgraphEndpoint,
  type FederatedGraphSummary,
  type FederatedSubgraphConfig,
  type FederationCompositionError,
  type FederationCompositionResult,
} from '@api-gateway/shared-types';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';

export interface StoredSubgraph extends FederatedSubgraphConfig {
  sdl: string;
}
interface Row {
  name: string;
  subgraphs: StoredSubgraph[];
  publicSdl: string;
  sha256: string;
  updatedAt: Date;
}
interface Composed {
  subgraphs: StoredSubgraph[];
  supergraphSdl: string;
  publicSdl: string;
  sha256: string;
}

/** Composition errors are reported, never thrown, so callers can show them. */
class CompositionFailed extends Error {
  constructor(readonly errors: FederationCompositionError[]) {
    super('Composition failed');
  }
}

/** Bound parsing of uploaded SDL; composition itself is linear in its size. */
const MAX_SDL_TOKENS = 100000;
const MAX_REPORTED_ERRORS = 50;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/**
 * Federated GraphQL graphs (roadmap 6.7). Saving a graph composes its
 * subgraph SDL into a supergraph with @theguild/federation-composition and
 * refuses graphs that do not compose, so gateways only ever receive a valid
 * supergraph in `TenantConfig.federatedGraphs`.
 */
@Injectable()
export class GraphqlFederationService {
  constructor(
    private readonly db: DataSource,
    private readonly push: ConfigPushService,
  ) {}

  private id(tenantId: string) {
    const id = tenantId.toLowerCase();
    return { id, schema: tenantSchema(id) };
  }

  async list(tenantId: string): Promise<{ graphs: FederatedGraphSummary[] }> {
    const { schema } = this.id(tenantId);
    const rows: Row[] = await this.db.query(
      `SELECT name, subgraphs, "publicSdl", sha256, "updatedAt" FROM ${schema}.federated_graphs
        WHERE "deletedAt" IS NULL ORDER BY name`,
    );
    const services = await this.serviceNames(this.db, schema);
    const routes: Array<{
      method: string;
      pathPattern: string;
      graph: string;
    }> = await this.db.query(
      `SELECT r.method, r."pathPattern", p.entry->'config'->>'graph' AS graph
           FROM ${schema}.routes r, jsonb_array_elements(COALESCE(r.plugins, '[]'::jsonb)) AS p(entry)
          WHERE r."deletedAt" IS NULL AND p.entry->>'name' = $1
          ORDER BY r."pathPattern", r.method`,
      [GRAPHQL_FEDERATION_PLUGIN],
    );
    return {
      graphs: rows.map((row) => ({
        name: row.name,
        subgraphs: row.subgraphs.map(({ sdl, ...subgraph }) => ({
          ...subgraph,
          serviceName: services.get(subgraph.serviceId) ?? null,
          sdlBytes: Buffer.byteLength(sdl),
          sdlSha256: createHash('sha256').update(sdl).digest('hex'),
        })),
        publicSdl: row.publicSdl,
        supergraphSha256: row.sha256,
        routes: routes
          .filter((route) => route.graph === row.name)
          .map((route) => `${route.method} ${route.pathPattern}`),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /** One graph with its subgraph SDL, for editing. */
  async get(tenantId: string, name: string) {
    if (!isFederatedGraphName(name))
      throw new NotFoundException('Graph not found');
    const { schema } = this.id(tenantId);
    const [row]: Row[] = await this.db.query(
      `SELECT name, subgraphs, "publicSdl", sha256, "updatedAt" FROM ${schema}.federated_graphs
        WHERE name=$1 AND "deletedAt" IS NULL`,
      [name],
    );
    if (!row) throw new NotFoundException('Graph not found');
    return {
      name: row.name,
      subgraphs: row.subgraphs,
      publicSdl: row.publicSdl,
      supergraphSha256: row.sha256,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Dry run: validate and compose without saving. */
  async compose(
    tenantId: string,
    input: unknown,
  ): Promise<FederationCompositionResult> {
    const { schema } = this.id(tenantId);
    const subgraphs = this.subgraphs(input);
    await this.assertServices(this.db, schema, subgraphs);
    try {
      const composed = this.composeSubgraphs(subgraphs);
      return { ok: true, errors: [], publicSdl: composed.publicSdl };
    } catch (error) {
      if (error instanceof CompositionFailed)
        return { ok: false, errors: error.errors };
      throw error;
    }
  }

  async save(tenantId: string, name: string, input: unknown) {
    if (!isFederatedGraphName(name))
      throw new BadRequestException(
        'Graph names are lowercase letters and digits joined by single hyphens (up to 48)',
      );
    const { id, schema } = this.id(tenantId);
    const subgraphs = this.subgraphs(input);
    let composed: Composed;
    try {
      composed = this.composeSubgraphs(subgraphs);
    } catch (error) {
      if (error instanceof CompositionFailed)
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'COMPOSITION_FAILED',
          message: 'The subgraphs do not compose into a supergraph',
          errors: error.errors,
        });
      throw error;
    }
    const payload = await this.db.transaction(async (manager) => {
      await this.lock(manager, id);
      await this.assertServices(manager, schema, subgraphs);
      const [existing] = await manager.query(
        `SELECT id FROM ${schema}.federated_graphs WHERE name=$1 AND "deletedAt" IS NULL`,
        [name],
      );
      if (existing) {
        await manager.query(
          `UPDATE ${schema}.federated_graphs
              SET subgraphs=$2::jsonb, "supergraphSdl"=$3, "publicSdl"=$4, sha256=$5, "updatedAt"=NOW()
            WHERE id=$1`,
          [
            existing.id,
            JSON.stringify(composed.subgraphs),
            composed.supergraphSdl,
            composed.publicSdl,
            composed.sha256,
          ],
        );
      } else {
        const [{ count }] = await manager.query(
          `SELECT COUNT(*)::int AS count FROM ${schema}.federated_graphs WHERE "deletedAt" IS NULL`,
        );
        if (count >= MAX_FEDERATED_GRAPHS)
          throw new ConflictException(
            `A workspace can define up to ${MAX_FEDERATED_GRAPHS} federated graphs`,
          );
        await manager.query(
          `INSERT INTO ${schema}.federated_graphs (name, subgraphs, "supergraphSdl", "publicSdl", sha256)
           VALUES ($1, $2::jsonb, $3, $4, $5)`,
          [
            name,
            JSON.stringify(composed.subgraphs),
            composed.supergraphSdl,
            composed.publicSdl,
            composed.sha256,
          ],
        );
      }
      return this.push.persistUpdate(id, manager);
    });
    await this.push.publish(payload);
    return this.get(id, name);
  }

  async remove(tenantId: string, name: string) {
    if (!isFederatedGraphName(name))
      throw new NotFoundException('Graph not found');
    const { id, schema } = this.id(tenantId);
    const payload = await this.db.transaction(async (manager) => {
      await this.lock(manager, id);
      // A route left pointing at a removed graph would fail every request.
      const routes: Array<{ method: string; pathPattern: string }> =
        await manager.query(
          `SELECT method, "pathPattern" FROM ${schema}.routes
            WHERE "deletedAt" IS NULL AND plugins @> $1::jsonb LIMIT 5`,
          [
            JSON.stringify([
              { name: GRAPHQL_FEDERATION_PLUGIN, config: { graph: name } },
            ]),
          ],
        );
      if (routes.length)
        throw new ConflictException(
          `Remove the ${GRAPHQL_FEDERATION_PLUGIN} plugin for ${name} from these routes first: ${routes
            .map((route) => `${route.method} ${route.pathPattern}`)
            .join(', ')}`,
        );
      const removed = await manager.query(
        `UPDATE ${schema}.federated_graphs SET "deletedAt"=NOW() WHERE name=$1 AND "deletedAt" IS NULL RETURNING id`,
        [name],
      );
      if (!(Array.isArray(removed[0]) ? removed[0] : removed).length)
        throw new NotFoundException('Graph not found');
      return this.push.persistUpdate(id, manager);
    });
    await this.push.publish(payload);
    return { success: true };
  }

  /** Validates the request body shape and limits (not composition). */
  private subgraphs(input: unknown): StoredSubgraph[] {
    const body = input as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'subgraphs') ||
      !Array.isArray(body.subgraphs)
    )
      throw new BadRequestException(
        'Send subgraphs: [{ name, serviceId, path, sdl }]',
      );
    const list = body.subgraphs as unknown[];
    if (!list.length || list.length > MAX_SUBGRAPHS)
      throw new BadRequestException(
        `A graph has between 1 and ${MAX_SUBGRAPHS} subgraphs`,
      );
    const names = new Set<string>();
    return list.map((entry, index) => {
      const subgraph = entry as Record<string, unknown> | null;
      const label = `Subgraph ${index + 1}`;
      if (
        !subgraph ||
        typeof subgraph !== 'object' ||
        Array.isArray(subgraph) ||
        Object.keys(subgraph).some(
          (key) => !['name', 'serviceId', 'path', 'sdl'].includes(key),
        )
      )
        throw new BadRequestException(
          `${label}: send name, serviceId, path and sdl`,
        );
      if (!isFederatedGraphName(subgraph.name))
        throw new BadRequestException(
          `${label}: names are lowercase letters and digits joined by single hyphens (up to 48)`,
        );
      if (names.has(subgraph.name))
        throw new BadRequestException(
          `Subgraph names must be unique: ${subgraph.name}`,
        );
      names.add(subgraph.name);
      if (
        typeof subgraph.serviceId !== 'string' ||
        !UUID.test(subgraph.serviceId)
      )
        throw new BadRequestException(
          `${subgraph.name}: serviceId must be a service ID`,
        );
      const path = subgraph.path ?? DEFAULT_SUBGRAPH_PATH;
      if (!isSubgraphPath(path))
        throw new BadRequestException(
          `${subgraph.name}: path must start with / (no query string or dot segments)`,
        );
      if (
        typeof subgraph.sdl !== 'string' ||
        !subgraph.sdl.trim() ||
        Buffer.byteLength(subgraph.sdl) > MAX_SUBGRAPH_SDL_BYTES
      )
        throw new BadRequestException(
          `${subgraph.name}: sdl must be the subgraph schema (at most ${MAX_SUBGRAPH_SDL_BYTES / 1024} KiB)`,
        );
      return {
        name: subgraph.name,
        serviceId: subgraph.serviceId.toLowerCase(),
        path,
        sdl: subgraph.sdl,
      };
    });
  }

  private composeSubgraphs(subgraphs: StoredSubgraph[]): Composed {
    const errors: FederationCompositionError[] = [];
    const documents = new Map<string, DocumentNode>();
    for (const subgraph of subgraphs) {
      try {
        documents.set(
          subgraph.name,
          parse(subgraph.sdl, { maxTokens: MAX_SDL_TOKENS, noLocation: false }),
        );
      } catch (error) {
        errors.push({
          message: `${subgraph.name}: ${bounded((error as Error).message)}`,
          code: 'SDL_PARSE_ERROR',
        });
      }
    }
    if (errors.length) throw new CompositionFailed(errors);
    let result: ReturnType<typeof composeServices>;
    try {
      result = composeServices(
        subgraphs.map((subgraph) => ({
          name: subgraph.name,
          typeDefs: documents.get(subgraph.name) as DocumentNode,
          url: subgraphEndpoint(subgraph.name),
        })),
      );
    } catch (error) {
      throw new CompositionFailed([
        {
          message: bounded((error as Error).message),
          code: 'COMPOSITION_ERROR',
        },
      ]);
    }
    if (result.errors)
      throw new CompositionFailed(
        result.errors.slice(0, MAX_REPORTED_ERRORS).map((error) => ({
          message: bounded(error.message),
          ...(typeof error.extensions?.code === 'string'
            ? { code: error.extensions.code }
            : {}),
        })),
      );
    if (Buffer.byteLength(result.supergraphSdl) > MAX_SUPERGRAPH_SDL_BYTES)
      throw new CompositionFailed([
        {
          message: `The composed supergraph exceeds ${MAX_SUPERGRAPH_SDL_BYTES / 1048576} MiB`,
          code: 'SUPERGRAPH_TOO_LARGE',
        },
      ]);
    return {
      subgraphs,
      supergraphSdl: result.supergraphSdl,
      publicSdl: result.publicSdl,
      sha256: createHash('sha256').update(result.supergraphSdl).digest('hex'),
    };
  }

  private async serviceNames(
    db: Pick<DataSource, 'query'>,
    schema: string,
  ): Promise<Map<string, string>> {
    const rows: Array<{ id: string; name: string }> = await db.query(
      `SELECT id, name FROM ${schema}.services WHERE "deletedAt" IS NULL`,
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async assertServices(
    db: Pick<DataSource, 'query'>,
    schema: string,
    subgraphs: StoredSubgraph[],
  ) {
    const services = await this.serviceNames(db, schema);
    const missing = subgraphs.filter(
      (subgraph) => !services.has(subgraph.serviceId),
    );
    if (missing.length)
      throw new BadRequestException(
        `These subgraphs name a service that does not exist: ${missing
          .map((subgraph) => subgraph.name)
          .join(', ')}`,
      );
  }

  private async lock(manager: EntityManager, tenantId: string) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'federated-graphs:' + tenantId,
    ]);
  }
}

function bounded(message: string): string {
  // eslint-disable-next-line no-control-regex
  const text = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
