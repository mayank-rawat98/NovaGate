import type { PluginContext } from '@api-gateway/shared-types';
import {
  BodyCaptureError,
  RequestBodyService,
} from '../../shared/request-body.service';
import { GraphqlAnalysisError } from './graphql-query-analyzer';

/** One GraphQL-over-HTTP request: GET parameters or a POST body. */
export interface GraphqlHttpRequest {
  query: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** Checks method, encoding and media type; returns the POST media type. */
export function graphqlTransport(ctx: PluginContext): string {
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

/** Reads and shape-checks the request through the shared bounded capture. */
export async function readGraphqlRequest(
  ctx: PluginContext,
  type: string,
  bodies: RequestBodyService,
  maxBodyBytes: number,
): Promise<GraphqlHttpRequest> {
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
    await bodies.read(ctx);
    const body = (ctx.req as typeof ctx.req & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(body)) throw new GraphqlAnalysisError();
    if (body.length > maxBodyBytes)
      throw new BodyCaptureError(413, 'REQUEST_TOO_LARGE');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    payload =
      type === 'application/graphql' ? { query: text } : JSON.parse(text);
  }
  if (Array.isArray(payload))
    throw new GraphqlAnalysisError('GRAPHQL_BATCH_UNSUPPORTED');
  if (!payload || typeof payload !== 'object') throw new GraphqlAnalysisError();
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
  if (request.extensions && Object.hasOwn(request.extensions, 'persistedQuery'))
    throw new GraphqlAnalysisError('GRAPHQL_PERSISTED_QUERY_UNSUPPORTED');
  return {
    query: request.query,
    ...(typeof request.operationName === 'string'
      ? { operationName: request.operationName }
      : {}),
    ...(request.variables
      ? { variables: request.variables as Record<string, unknown> }
      : {}),
    ...(request.extensions
      ? { extensions: request.extensions as Record<string, unknown> }
      : {}),
  };
}
