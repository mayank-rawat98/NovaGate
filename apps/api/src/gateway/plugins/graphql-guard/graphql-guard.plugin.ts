import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { analyzeQuery } from './graphql-query-analyzer';

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_COMPLEXITY = 1000;

@Injectable()
export class GraphqlGuardPlugin implements GatewayPlugin {
  readonly name = 'graphql-guard';

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const graphqlConfig = ctx.route.graphql;
    if (!graphqlConfig) return;

    const req = ctx.req as IncomingMessage & { rawBody?: Buffer };

    // Only POST requests carry a GraphQL query body
    if (req.method !== 'POST') return;

    const contentType = req.headers['content-type'] ?? '';
    if (
      !contentType.includes('application/json') &&
      !contentType.includes('application/graphql')
    ) {
      return;
    }

    const body = await this.readBody(req);
    const query = this.extractQuery(body, contentType);

    if (!query) return;

    const maxDepth = graphqlConfig.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxComplexity = graphqlConfig.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;
    const introspectionAllowed = graphqlConfig.introspectionAllowed ?? false;

    const analysis = analyzeQuery(query);

    if (!introspectionAllowed && analysis.hasIntrospection) {
      return this.reject(
        ctx.requestId,
        'GRAPHQL_INTROSPECTION_DISABLED',
        'GraphQL introspection is disabled',
      );
    }

    if (analysis.depth > maxDepth) {
      return this.reject(
        ctx.requestId,
        'GRAPHQL_DEPTH_EXCEEDED',
        `Query depth ${analysis.depth} exceeds limit of ${maxDepth}`,
      );
    }

    if (analysis.complexity > maxComplexity) {
      return this.reject(
        ctx.requestId,
        'GRAPHQL_COMPLEXITY_EXCEEDED',
        `Query complexity ${analysis.complexity} exceeds limit of ${maxComplexity}`,
      );
    }
  }

  private extractQuery(body: string, contentType: string): string | undefined {
    if (contentType.includes('application/graphql')) {
      return body.trim() || undefined;
    }

    // application/json — parse { query: string }
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const query = parsed['query'];
      return typeof query === 'string' && query.trim() ? query : undefined;
    } catch {
      return undefined;
    }
  }

  private readBody(
    req: IncomingMessage & { rawBody?: Buffer; body?: unknown },
  ): Promise<string> {
    // Use already-buffered raw body if available (e.g. from hmac-auth plugin)
    if (req.rawBody) {
      return Promise.resolve(req.rawBody.toString('utf8'));
    }

    // Nest's default body parser consumes the stream before plugins run, so
    // attaching 'data'/'end' listeners here would wait forever. Reconstruct
    // from the already-parsed body when present and cache it as rawBody.
    if (req.body !== undefined && req.body !== null) {
      const raw =
        typeof req.body === 'string'
          ? Buffer.from(req.body)
          : Buffer.from(JSON.stringify(req.body));
      req.rawBody = raw;
      return Promise.resolve(raw.toString('utf8'));
    }

    // Stream already ended with no buffered body — nothing left to read.
    if (req.readableEnded || req.complete) {
      return Promise.resolve('');
    }

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        // Cache for downstream plugins / proxy
        req.rawBody = raw;
        resolve(raw.toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  private reject(
    requestId: string,
    code: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: code, message, requestId }),
    };
  }
}
