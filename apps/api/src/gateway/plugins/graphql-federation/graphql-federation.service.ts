import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import {
  GraphQLError,
  execute,
  getOperationAST,
  parse,
  print,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type GraphQLSchema,
} from 'graphql';
import { getStitchedSchemaFromSupergraphSdl } from '@graphql-tools/federation';
import type { ExecutionRequest, Executor } from '@graphql-tools/utils';
import {
  GRAPHQL_FEDERATION_PLUGIN,
  graphqlFederationConfigProblem,
  subgraphOfEndpoint,
  type FederatedGraphConfig,
  type GraphqlFederationPluginConfig,
  type PluginContext,
  type PluginShortCircuit,
  type ServiceConfig,
} from '@api-gateway/shared-types';
import {
  DEFAULT_GRAPHQL,
  DEFAULT_GRAPHQL_FEDERATION,
  type GatewayConfig,
  type GraphqlFederationSettings,
  type GraphqlSettings,
} from '../../../config/configuration';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service';
import {
  CircuitBreakerService,
  outcomeForStatus,
} from '../../circuit-breaker/circuit-breaker.service';
import {
  BodyCaptureError,
  RequestBodyService,
} from '../../shared/request-body.service';
import { PluginRegistryService } from '../plugin-registry.service';
import { GraphqlFederationPlugin } from './graphql-federation.plugin';
import {
  analyzeQuery,
  GraphqlAnalysisError,
} from '../graphql-guard/graphql-query-analyzer';
import {
  graphqlTransport,
  readGraphqlRequest,
  type GraphqlHttpRequest,
} from '../graphql-guard/graphql-http-request';

/** Picks and reserves a subgraph target; the proxy supplies its load balancer. */
export interface SubgraphTargets {
  acquire(service: ServiceConfig): { url: string; release: () => void };
  /** W3C trace context for subgraph requests, when the request is traced. */
  traceHeaders?(): Record<string, string>;
}
export interface FederationResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Prepared {
  graph: string;
  request: GraphqlHttpRequest;
  forwardHeaders: string[];
}
interface Built {
  sha256: string;
  schema: GraphQLSchema | null;
}
interface OperationContext {
  ctx: PluginContext;
  targets: SubgraphTargets;
  forwardHeaders: string[];
  graph: string;
  calls: number;
}

const GRAPHQL_RESPONSE = 'application/graphql-response+json';
const MAX_VALIDATION_ERRORS = 25;
const SUBGRAPH_ERROR_MESSAGES: Record<string, string> = {
  SUBGRAPH_UNAVAILABLE: 'is unavailable',
  SUBGRAPH_TIMEOUT: 'did not respond in time',
  SUBGRAPH_RESPONSE_INVALID: 'returned an invalid response',
  SUBGRAPH_RESPONSE_TOO_LARGE: 'returned a response over the size limit',
  SUBGRAPH_REQUEST_LIMIT: 'was not called: request limit for one operation',
  CIRCUIT_OPEN: 'is temporarily unavailable',
};

/**
 * GraphQL federation gateway (roadmap 6.7). Builds an executable schema per
 * `TenantConfig.federatedGraphs` supergraph with @graphql-tools/federation,
 * whose query planner splits each operation into subgraph requests
 * (including `_entities` lookups) and merges their results. Subgraph
 * requests go to the subgraph's NovaGate service through the proxy's load
 * balancer, health state and circuit breaker, never to the URL in the SDL.
 */
@Injectable()
export class GraphqlFederationService implements OnModuleInit {
  private readonly logger = new Logger(GraphqlFederationService.name);
  private readonly settings: GraphqlFederationSettings;
  private readonly graphql: GraphqlSettings;
  private readonly built = new Map<string, Built>();
  private readonly prepared = new WeakMap<IncomingMessage, Prepared>();
  private active = 0;

  constructor(
    config: ConfigService<GatewayConfig, true>,
    private readonly configManager: GatewayConfigManagerService,
    private readonly bodies: RequestBodyService,
    private readonly registry: PluginRegistryService,
    @Optional() private readonly circuits?: CircuitBreakerService,
  ) {
    this.settings = {
      ...DEFAULT_GRAPHQL_FEDERATION,
      ...config.get('graphqlFederation', { infer: true }),
    };
    this.graphql = {
      ...DEFAULT_GRAPHQL,
      ...config.get('graphql', { infer: true }),
    };
  }

  onModuleInit() {
    this.registry.register(new GraphqlFederationPlugin(this));
  }

  /** prepareRequest: bounded capture before ordered policy hooks. */
  async capture(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    try {
      this.pluginConfig(ctx);
      graphqlTransport(ctx);
      if (ctx.req.method === 'POST') await this.bodies.read(ctx);
    } catch (error) {
      return this.failure(ctx, error);
    }
  }

  /**
   * onRequest: parse and bound the operation and check the graph is ready.
   * Execution (and schema validation, which can reveal field names) waits
   * until the proxy has applied route authentication and metering.
   */
  async prepare(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    try {
      const config = this.pluginConfig(ctx);
      const type = graphqlTransport(ctx);
      const request = await readGraphqlRequest(
        ctx,
        type,
        this.bodies,
        this.graphql.maxBodyBytes,
      );
      // A graphql-guard policy on the route sets depth and complexity;
      // without one the gateway defaults apply.
      const guarded =
        ctx.route.graphql != null ||
        !!ctx.route.plugins?.some((entry) => entry.name === 'graphql-guard');
      const analysis = analyzeQuery(request.query, {
        ...this.graphql,
        operationName: request.operationName,
      });
      if (ctx.req.method === 'GET' && analysis.operation !== 'query')
        throw new BodyCaptureError(405, 'GRAPHQL_GET_OPERATION_FORBIDDEN');
      if (analysis.operation === 'subscription')
        throw new GraphqlAnalysisError('GRAPHQL_SUBSCRIPTION_UNSUPPORTED');
      if (!guarded && analysis.depth > this.graphql.maxDepth)
        throw new GraphqlAnalysisError('GRAPHQL_DEPTH_EXCEEDED');
      if (!guarded && analysis.complexity > this.graphql.maxComplexity)
        throw new GraphqlAnalysisError('GRAPHQL_COMPLEXITY_EXCEEDED');
      if (!this.schema(config.graph))
        return this.error(
          ctx,
          503,
          'GRAPH_UNAVAILABLE',
          'The federated graph is not available on this gateway',
        );
      this.prepared.set(ctx.req, {
        graph: config.graph,
        request,
        forwardHeaders: config.forwardHeaders ?? [],
      });
    } catch (error) {
      return this.failure(ctx, error);
    } finally {
      this.bodies.releaseDetached(ctx);
    }
  }

  /** Whether the proxy should execute this route instead of forwarding it. */
  handles(ctx: PluginContext): boolean {
    return this.prepared.has(ctx.req);
  }

  async execute(
    ctx: PluginContext,
    targets: SubgraphTargets,
  ): Promise<FederationResponse> {
    const prepared = this.prepared.get(ctx.req);
    this.prepared.delete(ctx.req);
    const accept = String(ctx.req.headers.accept ?? '');
    const type = accept.includes(GRAPHQL_RESPONSE)
      ? GRAPHQL_RESPONSE
      : 'application/json';
    const respond = (
      status: number,
      result: ExecutionResult | Record<string, unknown>,
    ): FederationResponse => ({
      status,
      headers: { 'Content-Type': `${type}; charset=utf-8` },
      body: JSON.stringify(result),
    });
    // GraphQL over HTTP: request errors are 400 for the GraphQL media type
    // and 200 for clients that only accept application/json.
    const requestErrorStatus = type === GRAPHQL_RESPONSE ? 400 : 200;
    if (!prepared)
      return respond(500, {
        errors: [{ message: 'GraphQL request was not prepared' }],
      });
    const schema = this.schema(prepared.graph);
    if (!schema)
      return respond(503, {
        errors: [
          {
            message: 'The federated graph is not available on this gateway',
            extensions: { code: 'GRAPH_UNAVAILABLE' },
          },
        ],
      });
    if (this.active >= this.settings.maxConcurrentOperations)
      return {
        ...respond(503, {
          errors: [
            {
              message: 'Too many GraphQL operations in progress',
              extensions: { code: 'FEDERATION_CAPACITY_EXCEEDED' },
            },
          ],
        }),
        headers: {
          'Content-Type': `${type}; charset=utf-8`,
          'Retry-After': '1',
        },
      };
    const { request } = prepared;
    let document: DocumentNode;
    try {
      document = parse(request.query, {
        noLocation: false,
        maxTokens: this.graphql.maxTokens,
      });
    } catch (error) {
      return respond(requestErrorStatus, {
        errors: [toJson(error as GraphQLError)],
      });
    }
    const errors = validate(schema, document, undefined, {
      maxErrors: MAX_VALIDATION_ERRORS,
      hideSuggestions: true,
    });
    if (errors.length)
      return respond(requestErrorStatus, { errors: errors.map(toJson) });
    const operation = getOperationAST(document, request.operationName);
    if (!operation)
      return respond(requestErrorStatus, {
        errors: [
          {
            message: request.operationName
              ? `Unknown operation named "${request.operationName}".`
              : 'Must provide operation name if query contains multiple operations.',
          },
        ],
      });
    if (ctx.req.method === 'GET' && operation.operation !== 'query')
      return {
        ...respond(405, {
          errors: [{ message: 'GET requests may only run queries.' }],
        }),
        headers: { 'Content-Type': `${type}; charset=utf-8`, Allow: 'POST' },
      };
    this.active++;
    try {
      const context: OperationContext = {
        ctx,
        targets,
        forwardHeaders: prepared.forwardHeaders,
        graph: prepared.graph,
        calls: 0,
      };
      const result = await execute({
        schema,
        document,
        operationName: request.operationName,
        variableValues: request.variables,
        contextValue: context,
        hideSuggestions: true,
        abortSignal: ctx.signal,
      });
      if (Symbol.asyncIterator in (result as object))
        return respond(requestErrorStatus, {
          errors: [{ message: 'Incremental delivery is not supported.' }],
        });
      const executed = result as ExecutionResult;
      // Variable coercion failures never start execution: a request error.
      return respond(
        executed.data === undefined ? requestErrorStatus : 200,
        executed.errors
          ? { ...executed, errors: executed.errors.map(toJson) }
          : executed,
      );
    } finally {
      this.active--;
    }
  }

  /** The executable schema for a graph, rebuilt when its supergraph changes. */
  private schema(name: string): GraphQLSchema | null {
    const graph = this.graph(name);
    if (!graph) return null;
    const cached = this.built.get(name);
    if (cached?.sha256 === graph.sha256) return cached.schema;
    let schema: GraphQLSchema | null = null;
    try {
      schema = getStitchedSchemaFromSupergraphSdl({
        supergraphSdl: graph.supergraphSdl,
        onSubschemaConfig: (subschema) => {
          const subgraph = subgraphOfEndpoint(subschema.endpoint);
          subschema.executor = ((request: ExecutionRequest) =>
            this.callSubgraph(name, subgraph, request)) as Executor;
        },
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          msg: 'Federated graph could not be built',
          graph: name,
          error: (error as Error).message.slice(0, 200),
        }),
      );
    }
    // Configuration only ever names a few graphs; forget removed ones.
    const names = new Set(
      (this.configManager.getConfig()?.federatedGraphs ?? []).map(
        (item) => item.name,
      ),
    );
    for (const key of this.built.keys())
      if (!names.has(key)) this.built.delete(key);
    this.built.set(name, { sha256: graph.sha256, schema });
    return schema;
  }

  private graph(name: string): FederatedGraphConfig | undefined {
    return this.configManager
      .getConfig()
      ?.federatedGraphs?.find(
        (graph) =>
          graph.name === name &&
          typeof graph.supergraphSdl === 'string' &&
          typeof graph.sha256 === 'string' &&
          Array.isArray(graph.subgraphs),
      );
  }

  private async callSubgraph(
    graphName: string,
    subgraphName: string | null,
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const context = request.context as OperationContext | undefined;
    if (!context || !subgraphName)
      throw subgraphError(subgraphName ?? 'unknown', 'SUBGRAPH_UNAVAILABLE');
    if (++context.calls > this.settings.maxSubgraphRequests)
      throw subgraphError(subgraphName, 'SUBGRAPH_REQUEST_LIMIT');
    // Current configuration: a service edited mid-operation uses its new targets.
    const config = this.configManager.getConfig();
    const subgraph = this.graph(graphName)?.subgraphs.find(
      (item) => item.name === subgraphName,
    );
    const service = config?.services.find(
      (item) => item.id === subgraph?.serviceId,
    );
    if (!subgraph || !service?.targets?.length)
      throw subgraphError(subgraphName, 'SUBGRAPH_UNAVAILABLE');
    const circuit = this.circuits?.admit(service.id);
    if (circuit && !circuit.allowed)
      throw subgraphError(subgraphName, 'CIRCUIT_OPEN');
    let lease: { url: string; release: () => void };
    try {
      lease = context.targets.acquire(service);
    } catch {
      circuit?.settle('neutral');
      throw subgraphError(subgraphName, 'SUBGRAPH_UNAVAILABLE');
    }
    const { ctx } = context;
    const timeout = AbortSignal.timeout(service.timeoutMs ?? 10000);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeout])
      : timeout;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: `${GRAPHQL_RESPONSE}, application/json;q=0.9`,
      'x-request-id': ctx.requestId,
    };
    for (const name of context.forwardHeaders) {
      const value = ctx.req.headers[name];
      if (typeof value === 'string') headers[name] = value;
      else if (Array.isArray(value)) headers[name] = value.join(', ');
    }
    Object.assign(headers, context.targets.traceHeaders?.() ?? {});
    try {
      const response = await fetch(
        lease.url.replace(/\/+$/, '') + subgraph.path,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: print(request.document),
            ...(request.variables && Object.keys(request.variables).length
              ? { variables: request.variables }
              : {}),
            ...(request.operationName
              ? { operationName: request.operationName }
              : {}),
          }),
          signal,
          redirect: 'manual',
        },
      );
      circuit?.record(response.status);
      const text = await this.readBounded(response, subgraphName);
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        throw subgraphError(
          subgraphName,
          response.ok ? 'SUBGRAPH_RESPONSE_INVALID' : 'SUBGRAPH_UNAVAILABLE',
        );
      }
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        !('data' in result || 'errors' in result)
      )
        throw subgraphError(
          subgraphName,
          response.ok ? 'SUBGRAPH_RESPONSE_INVALID' : 'SUBGRAPH_UNAVAILABLE',
        );
      return result as ExecutionResult;
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      if (ctx.signal?.aborted) {
        circuit?.settle('neutral');
        throw subgraphError(subgraphName, 'SUBGRAPH_UNAVAILABLE');
      }
      const timedOut = timeout.aborted;
      circuit?.settle(outcomeForStatus(timedOut ? 504 : 502));
      throw subgraphError(
        subgraphName,
        timedOut ? 'SUBGRAPH_TIMEOUT' : 'SUBGRAPH_UNAVAILABLE',
      );
    } finally {
      circuit?.settle('neutral');
      lease.release();
    }
  }

  private async readBounded(
    response: Response,
    subgraph: string,
  ): Promise<string> {
    const limit = this.settings.maxSubgraphResponseBytes;
    const length = Number(response.headers.get('content-length') ?? NaN);
    if (length > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw subgraphError(subgraph, 'SUBGRAPH_RESPONSE_TOO_LARGE');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw subgraphError(subgraph, 'SUBGRAPH_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  }

  private pluginConfig(ctx: PluginContext): GraphqlFederationPluginConfig {
    const config = ctx.route.plugins?.find(
      (entry) => entry.name === GRAPHQL_FEDERATION_PLUGIN,
    )?.config;
    if (graphqlFederationConfigProblem(config))
      throw new BodyCaptureError(500, 'GRAPHQL_FEDERATION_CONFIG_INVALID');
    return config as unknown as GraphqlFederationPluginConfig;
  }

  private failure(ctx: PluginContext, error: unknown): PluginShortCircuit {
    const status = error instanceof BodyCaptureError ? error.status : 400;
    const code =
      error instanceof BodyCaptureError || error instanceof GraphqlAnalysisError
        ? error.code
        : 'GRAPHQL_QUERY_INVALID';
    return this.error(
      ctx,
      status,
      code,
      status === 413
        ? 'Request body exceeds the configured size limit'
        : status >= 500
          ? 'GraphQL federation is misconfigured for this route'
          : 'GraphQL request is not valid for this route',
    );
  }

  /** Gateway error shape plus a GraphQL `errors` list for GraphQL clients. */
  private error(
    ctx: PluginContext,
    status: number,
    code: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...(status === 405 ? { Allow: 'GET, POST' } : {}),
        ...(status === 503 ? { 'Retry-After': '5' } : {}),
      },
      body: JSON.stringify({
        error: code,
        message,
        requestId: ctx.requestId,
        errors: [{ message, extensions: { code } }],
      }),
    };
  }
}

function subgraphError(subgraph: string, code: string): GraphQLError {
  return new GraphQLError(
    `Subgraph "${subgraph}" ${SUBGRAPH_ERROR_MESSAGES[code] ?? 'failed'}`,
    { extensions: { code, subgraph } },
  );
}

/** Client-facing error JSON: message, locations, path and extensions only. */
function toJson(error: GraphQLError): Record<string, unknown> {
  const json =
    typeof error.toJSON === 'function'
      ? (error.toJSON() as unknown as Record<string, unknown>)
      : { message: String((error as Error)?.message ?? 'Error') };
  return Object.fromEntries(
    Object.entries(json).filter(([key]) =>
      ['message', 'locations', 'path', 'extensions'].includes(key),
    ),
  );
}
