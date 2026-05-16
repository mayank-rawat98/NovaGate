import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

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
]);

function tenantSchema(tenantId: string): string {
  if (!/^[0-9a-f-]+$/i.test(tenantId)) throw new Error('Invalid tenantId');
  return `tenant_${tenantId.replace(/-/g, '_')}`;
}

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
}

function validatePlugins(plugins: unknown): void {
  if (!plugins) return;
  if (!Array.isArray(plugins))
    throw new BadRequestException('plugins must be an array');
  for (const entry of plugins) {
    if (typeof entry.name !== 'string')
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
          retry, plugins)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        body.method,
        body.pathPattern,
        body.serviceId,
        body.authRequired ?? false,
        body.rateLimitOverride ?? null,
        body.enabled ?? true,
        body.retry ? JSON.stringify(body.retry) : null,
        body.plugins ? JSON.stringify(body.plugins) : null,
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
      `UPDATE ${schema}.routes
       SET method = COALESCE($2, method),
           "pathPattern" = COALESCE($3, "pathPattern"),
           "serviceId" = COALESCE($4, "serviceId"),
           "authRequired" = COALESCE($5, "authRequired"),
           "rateLimitOverride" = COALESCE($6, "rateLimitOverride"),
           enabled = COALESCE($7, enabled),
           retry = COALESCE($8::jsonb, retry),
           plugins = COALESCE($9::jsonb, plugins)
       WHERE id = $1 AND "deletedAt" IS NULL RETURNING *`,
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
      ],
    );
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
