import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAX_GRAPHQL_POLICY_DEPTH,
  MAX_GRAPHQL_POLICY_COMPLEXITY,
} from '@api-gateway/shared-types';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
  GraphqlPolicy,
} from '@api-gateway/shared-types';
import {
  DEFAULT_GRAPHQL,
  GatewayConfig,
  GraphqlSettings,
} from '../../../config/configuration';
import {
  BodyCaptureError,
  RequestBodyService,
} from '../../shared/request-body.service';
import { analyzeQuery, GraphqlAnalysisError } from './graphql-query-analyzer';

@Injectable()
export class GraphqlGuardPlugin implements GatewayPlugin {
  readonly name = 'graphql-guard';
  readonly protocols = ['http'] as const;
  private readonly settings: GraphqlSettings;
  constructor(
    config: ConfigService<GatewayConfig, true>,
    private readonly bodies: RequestBodyService = new RequestBodyService(
      config,
    ),
  ) {
    this.settings = {
      ...DEFAULT_GRAPHQL,
      ...config.get('graphql', { infer: true }),
    };
  }

  async prepareRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    if (!this.configured(ctx)) return;
    try {
      this.policy(ctx);
      this.transport(ctx);
      if (ctx.req.method === 'POST') await this.bodies.read(ctx);
    } catch (error) {
      return this.failure(ctx, error);
    }
  }

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    if (!this.configured(ctx)) return;
    try {
      const policy = this.policy(ctx);
      const type = this.transport(ctx);
      let payload: unknown;
      if (ctx.req.method === 'GET') {
        const params = new URL(ctx.req.url ?? '/', 'http://gateway.invalid')
          .searchParams;
        for (const key of ['query', 'operationName', 'variables', 'extensions'])
          if (params.getAll(key).length > 1) throw new GraphqlAnalysisError();
        const parseParameter = (key: string) =>
          params.has(key) ? JSON.parse(params.get(key) ?? '') : undefined;
        payload = {
          query: params.get('query'),
          operationName: params.get('operationName') ?? undefined,
          variables: parseParameter('variables'),
          extensions: parseParameter('extensions'),
        };
      } else {
        await this.bodies.read(ctx);
        const body = (ctx.req as typeof ctx.req & { rawBody?: Buffer }).rawBody;
        if (!Buffer.isBuffer(body)) throw new GraphqlAnalysisError();
        if (body.length > this.settings.maxBodyBytes)
          throw new BodyCaptureError(413, 'REQUEST_TOO_LARGE');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        payload =
          type === 'application/graphql' ? { query: text } : JSON.parse(text);
      }
      if (Array.isArray(payload))
        throw new GraphqlAnalysisError('GRAPHQL_BATCH_UNSUPPORTED');
      if (!payload || typeof payload !== 'object')
        throw new GraphqlAnalysisError();
      const request = payload as Record<string, unknown>;
      if (
        typeof request.query !== 'string' ||
        !request.query.trim() ||
        (request.operationName !== undefined &&
          request.operationName !== null &&
          (typeof request.operationName !== 'string' || !request.operationName))
      )
        throw new GraphqlAnalysisError();
      for (const key of ['variables', 'extensions'])
        if (
          request[key] !== undefined &&
          request[key] !== null &&
          (typeof request[key] !== 'object' || Array.isArray(request[key]))
        )
          throw new GraphqlAnalysisError();
      if (
        request.extensions &&
        Object.hasOwn(request.extensions, 'persistedQuery')
      )
        throw new GraphqlAnalysisError('GRAPHQL_PERSISTED_QUERY_UNSUPPORTED');
      const result = analyzeQuery(request.query, {
        ...this.settings,
        ...policy,
        operationName:
          typeof request.operationName === 'string'
            ? request.operationName
            : undefined,
      });
      if (ctx.req.method === 'GET' && result.operation !== 'query')
        throw new BodyCaptureError(405, 'GRAPHQL_GET_OPERATION_FORBIDDEN');
      if (result.operation === 'subscription')
        throw new GraphqlAnalysisError('GRAPHQL_SUBSCRIPTION_UNSUPPORTED');
      if (!policy.introspectionAllowed && result.hasIntrospection)
        throw new GraphqlAnalysisError('GRAPHQL_INTROSPECTION_DISABLED');
      if (result.depth > policy.maxDepth)
        throw new GraphqlAnalysisError('GRAPHQL_DEPTH_EXCEEDED');
      if (result.complexity > policy.maxComplexity)
        throw new GraphqlAnalysisError('GRAPHQL_COMPLEXITY_EXCEEDED');
    } catch (error) {
      return this.failure(ctx, error);
    } finally {
      this.bodies.releaseDetached(ctx);
    }
  }

  // A later query/header transformation must not bypass an earlier guard.
  async validateRequest(
    ctx: PluginContext,
  ): Promise<PluginShortCircuit | void> {
    return this.onRequest(ctx);
  }

  private configured(ctx: PluginContext): boolean {
    return (
      ctx.route.graphql != null ||
      !!ctx.route.plugins?.some((p) => p.name === this.name)
    );
  }
  private policy(ctx: PluginContext): Required<GraphqlPolicy> {
    const entry = ctx.route.plugins?.find((p) => p.name === this.name);
    const policies = [ctx.route.graphql, entry?.config].filter(
      (p) => p != null,
    ) as GraphqlPolicy[];
    for (const policy of policies) {
      if (
        !policy ||
        typeof policy !== 'object' ||
        Array.isArray(policy) ||
        Object.keys(policy).some(
          (key) =>
            !['maxDepth', 'maxComplexity', 'introspectionAllowed'].includes(
              key,
            ),
        ) ||
        (policy.maxDepth !== undefined &&
          (!Number.isSafeInteger(policy.maxDepth) ||
            policy.maxDepth < 1 ||
            policy.maxDepth > MAX_GRAPHQL_POLICY_DEPTH)) ||
        (policy.maxComplexity !== undefined &&
          (!Number.isSafeInteger(policy.maxComplexity) ||
            policy.maxComplexity < 1 ||
            policy.maxComplexity > MAX_GRAPHQL_POLICY_COMPLEXITY)) ||
        (policy.introspectionAllowed !== undefined &&
          typeof policy.introspectionAllowed !== 'boolean')
      )
        throw new BodyCaptureError(500, 'GRAPHQL_CONFIG_INVALID');
    }
    // Default empty auto-injected entries do not weaken explicit route policy.
    const depths = policies.flatMap((p) =>
      p.maxDepth === undefined ? [] : [p.maxDepth],
    );
    const costs = policies.flatMap((p) =>
      p.maxComplexity === undefined ? [] : [p.maxComplexity],
    );
    return {
      maxDepth: depths.length ? Math.min(...depths) : this.settings.maxDepth,
      maxComplexity: costs.length
        ? Math.min(...costs)
        : this.settings.maxComplexity,
      introspectionAllowed:
        policies.every((p) => p.introspectionAllowed === true) &&
        policies.some((p) => p.introspectionAllowed === true),
    };
  }
  private transport(ctx: PluginContext): string {
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'POST')
      throw new BodyCaptureError(405, 'GRAPHQL_METHOD_UNSUPPORTED');
    const encoding = ctx.req.headers['content-encoding'];
    if (encoding !== undefined && encoding !== 'identity')
      throw new BodyCaptureError(415, 'GRAPHQL_ENCODING_UNSUPPORTED');
    if (ctx.req.method === 'GET') {
      if (
        ctx.req.headers['transfer-encoding'] !== undefined ||
        (ctx.req.headers['content-length'] !== undefined &&
          ctx.req.headers['content-length'] !== '0')
      )
        throw new GraphqlAnalysisError('GRAPHQL_GET_BODY_UNSUPPORTED');
      return '';
    }
    const type = (ctx.req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!['application/json', 'application/graphql'].includes(type))
      throw new BodyCaptureError(415, 'GRAPHQL_MEDIA_TYPE_UNSUPPORTED');
    return type;
  }
  private failure(ctx: PluginContext, error: unknown): PluginShortCircuit {
    const status = error instanceof BodyCaptureError ? error.status : 400;
    const code =
      error instanceof BodyCaptureError || error instanceof GraphqlAnalysisError
        ? error.code
        : 'GRAPHQL_QUERY_INVALID';
    return {
      status,
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        ...(status === 405 ? { Allow: 'GET, POST' } : {}),
      },
      body: JSON.stringify({
        error: code,
        message:
          status === 413
            ? 'Request body exceeds the configured size limit'
            : 'GraphQL request does not meet this route policy',
        requestId: ctx.requestId,
      }),
    };
  }
}
