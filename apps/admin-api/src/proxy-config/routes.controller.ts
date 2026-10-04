import Joi from 'joi';
import {
  MAX_HMAC_SECRETS,
  MAX_HMAC_SECRET_BYTES,
  MAX_HMAC_CLOCK_SKEW_SECONDS,
} from '@api-gateway/shared-types';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';

// Plugin names accepted by the admin-api. Reject unknown names so the
// gateway never tries to resolve a plugin that doesn't exist.
const KNOWN_PLUGIN_NAMES = new Set([
  'cors',
  'ip-restriction',
  'request-size-limit',
  'rate-limit',
  'request-transform',
  'response-transform',
  'basic-auth',
  'oidc',
  'oauth2-client-credentials',
  'hmac-auth',
  'acl',
  'mtls',
  'graphql-guard',
]);

interface PluginEntry {
  name: string;
  config: Record<string, unknown>;
}

interface RouteBody {
  method?: string;
  pathPattern?: string;
  serviceId?: string;
  authRequired?: boolean;
  rateLimitOverride?: number | null;
  enabled?: boolean;
  retry?: { attempts: number; on: number[]; methods: string[] } | null;
  plugins?: PluginEntry[] | null;
  graphql?: {
    maxDepth?: number;
    maxComplexity?: number;
    introspectionAllowed?: boolean;
  } | null;
}

const providerEndpoint = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .custom((value, helpers) => {
    const url = new URL(value);
    return url.username || url.password || url.hash
      ? helpers.error('any.invalid')
      : value;
  });
const oidcConfigSchema = Joi.object({
  jwksUri: providerEndpoint.required(),
  issuer: Joi.string().required(),
  audience: Joi.string(),
  claimsToForward: Joi.array().items(Joi.string().pattern(/^[a-zA-Z0-9_.-]+$/)),
});
const oauthConfigSchema = Joi.object({
  introspectionEndpoint: providerEndpoint,
  tokenEndpoint: providerEndpoint,
  clientId: Joi.string()
    .pattern(/^\S+$/)
    .custom((value, helpers) =>
      [...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
        ? helpers.error('any.invalid')
        : value,
    )
    .required(),
  clientSecret: Joi.string().required(),
  scopes: Joi.array().items(
    Joi.string()
      .pattern(/^\S+$/)
      .custom((value, helpers) =>
        [...value].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
          ? helpers.error('any.invalid')
          : value,
      ),
  ),
  issuer: Joi.string(),
  audience: Joi.string(),
  headerName: Joi.string()
    .pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
    .custom((value, helpers) => {
      const name = value.toLowerCase();
      return [
        'host',
        'content-length',
        'transfer-encoding',
        'connection',
        'upgrade',
        'proxy-authorization',
      ].includes(name) || name.startsWith('sec-websocket-')
        ? helpers.error('any.invalid')
        : value;
    }),
}).xor('introspectionEndpoint', 'tokenEndpoint');

const hmacConfigSchema = Joi.object({
  mode: Joi.string().valid('generic', 'stripe'),
  header: Joi.string()
    .max(128)
    .pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
    .required(),
  algorithm: Joi.string().valid('sha256', 'sha512').required(),
  secrets: Joi.array()
    .min(1)
    .max(MAX_HMAC_SECRETS)
    .items(
      Joi.string().custom((v: string, helpers) =>
        Buffer.byteLength(v) > MAX_HMAC_SECRET_BYTES
          ? helpers.error('any.invalid')
          : v,
      ),
    )
    .required(),
  timestampHeader: Joi.string()
    .max(128)
    .pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  maxClockSkewSeconds: Joi.number()
    .strict()
    .integer()
    .min(1)
    .max(MAX_HMAC_CLOCK_SKEW_SECONDS),
}).custom((v, helpers) => {
  if (
    v.mode === 'stripe' &&
    (v.algorithm !== 'sha256' || v.timestampHeader !== undefined)
  )
    return helpers.error('any.invalid');
  if (v.timestampHeader?.toLowerCase() === v.header.toLowerCase())
    return helpers.error('any.invalid');
  if (
    v.maxClockSkewSeconds !== undefined &&
    v.mode !== 'stripe' &&
    !v.timestampHeader
  )
    return helpers.error('any.invalid');
  return v;
});

function validatePlugins(plugins: unknown): void {
  if (plugins === null || plugins === undefined) return;
  if (!Array.isArray(plugins))
    throw new BadRequestException('plugins must be an array');
  for (const entry of plugins) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string')
      throw new BadRequestException('each plugin must have a string name');
    if (!KNOWN_PLUGIN_NAMES.has(entry.name)) {
      throw new BadRequestException(`Unknown plugin: "${entry.name}"`);
    }
    if (
      typeof entry.config !== 'object' ||
      entry.config === null ||
      Array.isArray(entry.config)
    ) {
      throw new BadRequestException(
        `plugin "${entry.name}" config must be an object`,
      );
    }
    const schema =
      entry.name === 'oidc'
        ? oidcConfigSchema
        : entry.name === 'oauth2-client-credentials'
          ? oauthConfigSchema
          : entry.name === 'hmac-auth'
            ? hmacConfigSchema
            : entry.name === 'mtls'
              ? Joi.object({ required: Joi.boolean().strict().required() })
              : undefined;
    if (schema?.validate(entry.config).error)
      throw new BadRequestException(
        `Invalid ${entry.name} configuration: check credentials and optional fields`,
      );
  }
}

@Controller('tenants/:tenantId/routes')
export class RoutesController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
  ) {}

  @Get()
  async findAll(@Param('tenantId') tenantId: string) {
    const schema = tenantSchema(tenantId);
    return this.dataSource.query(
      `SELECT * FROM ${schema}.routes WHERE "deletedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @Post()
  async create(@Param('tenantId') tenantId: string, @Body() body: RouteBody) {
    validatePlugins(body.plugins);
    const schema = tenantSchema(tenantId);
    const rows = await this.dataSource.query(
      `INSERT INTO ${schema}.routes
         (method, "pathPattern", "serviceId", "authRequired", "rateLimitOverride", enabled,
          retry, plugins, graphql)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        body.method,
        body.pathPattern,
        body.serviceId,
        body.authRequired ?? false,
        body.rateLimitOverride ?? null,
        body.enabled ?? true,
        body.retry ? JSON.stringify(body.retry) : null,
        body.plugins ? JSON.stringify(body.plugins) : null,
        body.graphql ? JSON.stringify(body.graphql) : null,
      ],
    );
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @Put(':id')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: RouteBody,
  ) {
    validatePlugins(body.plugins);
    const schema = tenantSchema(tenantId);
    const rows = await this.dataSource.query(
      `WITH updated AS (UPDATE ${schema}.routes
       SET method = COALESCE($2, method),
           "pathPattern" = COALESCE($3, "pathPattern"),
           "serviceId" = COALESCE($4, "serviceId"),
           "authRequired" = COALESCE($5, "authRequired"),
           "rateLimitOverride" = CASE WHEN $11 THEN $6 ELSE "rateLimitOverride" END,
           enabled = COALESCE($7, enabled),
           retry = CASE WHEN $12 THEN $8::jsonb ELSE retry END,
           plugins = CASE WHEN $13 THEN $9::jsonb ELSE plugins END,
           graphql = CASE WHEN $14 THEN $10::jsonb ELSE graphql END
       WHERE id = $1 AND "deletedAt" IS NULL RETURNING *) SELECT * FROM updated`,
      [
        id,
        body.method ?? null,
        body.pathPattern ?? null,
        body.serviceId ?? null,
        body.authRequired ?? null,
        body.rateLimitOverride ?? null,
        body.enabled ?? null,
        body.retry ? JSON.stringify(body.retry) : null,
        body.plugins ? JSON.stringify(body.plugins) : null,
        body.graphql ? JSON.stringify(body.graphql) : null,
        body.rateLimitOverride !== undefined,
        body.retry !== undefined,
        body.plugins !== undefined,
        body.graphql !== undefined,
      ],
    );
    if (!rows.length)
      throw new NotFoundException('Configuration entry not found');
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @Delete(':id')
  async remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    const schema = tenantSchema(tenantId);
    await this.dataSource.query(
      `UPDATE ${schema}.routes SET "deletedAt" = NOW() WHERE id = $1 AND "deletedAt" IS NULL`,
      [id],
    );
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }
}
