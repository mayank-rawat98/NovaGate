import {
  BadRequestException,
  NotFoundException,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';
import type { ServiceTarget } from '@api-gateway/shared-types';

interface ServiceBody {
  name?: string;
  targets?: unknown;
  healthCheckPath?: string;
  timeoutMs?: number;
  healthCheckIntervalMs?: number;
  healthCheckProtocol?: 'http' | 'grpc';
  healthCheckService?: string;
  unhealthyFallback?: boolean;
  h2?: boolean;
  supportsWebSocket?: boolean;
}

function validateTargets(targets: unknown): ServiceTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new BadRequestException('Targets must be a non-empty array');
  }
  return targets.map((target, index) => {
    if (!target || typeof target !== 'object') {
      throw new BadRequestException(`targets[${index}] must be an object`);
    }
    const record = target as { url?: unknown; weight?: unknown };
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) {
      throw new BadRequestException(`targets[${index}].url is required`);
    }
    const weight =
      typeof record.weight === 'number' ? record.weight : Number(record.weight);
    if (!Number.isFinite(weight) || weight < 1 || weight > 100) {
      throw new BadRequestException(
        `targets[${index}].weight must be between 1 and 100`,
      );
    }
    return { url, weight };
  });
}

function validateHealthSettings(body: ServiceBody) {
  if (
    body.healthCheckProtocol !== undefined &&
    !['http', 'grpc'].includes(body.healthCheckProtocol)
  )
    throw new BadRequestException('Health check protocol must be http or grpc');
  if (
    body.healthCheckService !== undefined &&
    (typeof body.healthCheckService !== 'string' ||
      Buffer.byteLength(body.healthCheckService, 'utf8') > 256 ||
      [...body.healthCheckService].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ))
  )
    throw new BadRequestException(
      'gRPC health service name must be at most 256 UTF-8 bytes without control characters',
    );
  for (const flag of ['h2', 'supportsWebSocket'] as const)
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean')
      throw new BadRequestException(`${flag} must be a boolean`);
  if (
    body.timeoutMs !== undefined &&
    (!Number.isSafeInteger(body.timeoutMs) ||
      body.timeoutMs < 100 ||
      body.timeoutMs > 3600000)
  )
    throw new BadRequestException(
      'Timeout must be an integer between 100 and 3600000 ms',
    );
  if (
    body.healthCheckIntervalMs !== undefined &&
    (!Number.isSafeInteger(body.healthCheckIntervalMs) ||
      body.healthCheckIntervalMs < 1000 ||
      body.healthCheckIntervalMs > 60000)
  ) {
    throw new BadRequestException(
      'Health check interval must be an integer between 1000 and 60000 ms',
    );
  }
  if (
    body.unhealthyFallback !== undefined &&
    typeof body.unhealthyFallback !== 'boolean'
  ) {
    throw new BadRequestException('Unhealthy fallback must be a boolean');
  }
  if (
    body.healthCheckPath !== undefined &&
    (typeof body.healthCheckPath !== 'string' ||
      !body.healthCheckPath.startsWith('/') ||
      body.healthCheckPath.startsWith('//') ||
      /[\\#]/.test(body.healthCheckPath) ||
      [...body.healthCheckPath].some(
        (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
      ) ||
      body.healthCheckPath.length > 1024)
  ) {
    throw new BadRequestException(
      'Health check path must be a relative absolute path, such as /health',
    );
  }
}

@Controller('tenants/:tenantId/services')
export class ServicesController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
  ) {}

  @Get()
  async findAll(@Param('tenantId') tenantId: string) {
    const schema = tenantSchema(tenantId);
    return this.dataSource.query(
      `SELECT * FROM ${schema}.services WHERE "deletedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @Post()
  async create(@Param('tenantId') tenantId: string, @Body() body: ServiceBody) {
    const schema = tenantSchema(tenantId);
    validateHealthSettings(body);
    const targets = validateTargets(body.targets);
    const rows = await this.dataSource.query(
      `INSERT INTO ${schema}.services (name, targets, "healthCheckPath", "timeoutMs", h2, "supportsWebSocket", "healthCheckIntervalMs", "unhealthyFallback", "healthCheckProtocol", "healthCheckService")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        body.name,
        JSON.stringify(targets),
        body.healthCheckPath ?? '/health',
        body.timeoutMs ?? 10000,
        body.h2 ?? false,
        body.supportsWebSocket ?? false,
        body.healthCheckIntervalMs ?? 10000,
        body.unhealthyFallback ?? false,
        body.healthCheckProtocol ?? 'http',
        body.healthCheckService ?? '',
      ],
    );
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @Put(':id')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: ServiceBody,
  ) {
    const schema = tenantSchema(tenantId);
    validateHealthSettings(body);
    const targets =
      body.targets === undefined
        ? null
        : JSON.stringify(validateTargets(body.targets));
    const rows = await this.dataSource.query(
      `WITH updated AS (UPDATE ${schema}.services
       SET name = COALESCE($2, name),
            targets = COALESCE($3::jsonb, targets),
            "healthCheckPath" = COALESCE($4, "healthCheckPath"),
            "timeoutMs" = COALESCE($5, "timeoutMs"),
            h2 = COALESCE($6, h2),
            "supportsWebSocket" = COALESCE($7, "supportsWebSocket"),
            "healthCheckIntervalMs" = COALESCE($8, "healthCheckIntervalMs"),
            "unhealthyFallback" = COALESCE($9, "unhealthyFallback"),
            "healthCheckProtocol" = COALESCE($10, "healthCheckProtocol"),
            "healthCheckService" = COALESCE($11, "healthCheckService")
       WHERE id = $1 AND "deletedAt" IS NULL RETURNING *) SELECT * FROM updated`,
      [
        id,
        body.name ?? null,
        targets,
        body.healthCheckPath ?? null,
        body.timeoutMs ?? null,
        body.h2 ?? null,
        body.supportsWebSocket ?? null,
        body.healthCheckIntervalMs ?? null,
        body.unhealthyFallback ?? null,
        body.healthCheckProtocol ?? null,
        body.healthCheckService ?? null,
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
      `UPDATE ${schema}.services SET "deletedAt" = NOW() WHERE id = $1 AND "deletedAt" IS NULL`,
      [id],
    );
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }
}
