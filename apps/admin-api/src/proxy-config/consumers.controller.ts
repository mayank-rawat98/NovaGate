import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MAX_CONSUMER_MONTHLY_QUOTA } from '@api-gateway/shared-types';
import { BillingService } from '../billing/billing.service';
import * as crypto from 'crypto';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';

/** Undefined keeps the stored quota; null removes it. */
function monthlyQuota(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_CONSUMER_MONTHLY_QUOTA
  )
    throw new BadRequestException(
      `monthlyQuota must be a whole number from 1 to ${MAX_CONSUMER_MONTHLY_QUOTA}, or null`,
    );
  return value as number;
}

@Controller('tenants/:tenantId/consumers')
export class ConsumersController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
    @Optional() private readonly billing?: BillingService,
  ) {}

  @AutomationScope('consumers:read')
  @Get()
  async findAll(@Param('tenantId') tenantId: string) {
    const schema = tenantSchema(tenantId);
    return this.dataSource.query(
      `SELECT id, name, "rateLimitTier", groups, "monthlyQuota", "createdAt" FROM ${schema}.consumers WHERE "revokedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @AutomationScope('consumers:write')
  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Body()
    body: {
      name: string;
      rateLimitTier?: string;
      groups?: string[];
      monthlyQuota?: number | null;
    },
  ) {
    const schema = tenantSchema(tenantId);
    const quota = monthlyQuota(body.monthlyQuota) ?? null;
    const random = crypto.randomBytes(16).toString('hex');
    const plainKey = `gw_${tenantId}_${random}`;
    const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');

    const insert = (db: Pick<DataSource, 'query'>) =>
      db.query(
        `INSERT INTO ${schema}.consumers (name, "keyHash", "rateLimitTier", groups, "monthlyQuota")
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, "rateLimitTier", groups, "monthlyQuota", "createdAt"`,
        [
          body.name,
          keyHash,
          body.rateLimitTier ?? 'authenticated',
          JSON.stringify(body.groups ?? []),
          quota,
        ],
      );
    const rows = this.billing
      ? await this.billing.withCapacity(tenantId, ['consumers'], insert)
      : await insert(this.dataSource);

    await this.configPush.triggerUpdate(tenantId);
    return { ...rows[0], apiKey: plainKey };
  }

  @AutomationScope('consumers:write')
  @Put(':id')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: { groups?: string[]; monthlyQuota?: number | null },
  ) {
    const schema = tenantSchema(tenantId);
    const quota = monthlyQuota(body.monthlyQuota);
    const rows = await this.dataSource.query(
      `WITH updated AS (UPDATE ${schema}.consumers SET groups = CASE WHEN $3 THEN $2::jsonb ELSE groups END, "monthlyQuota" = CASE WHEN $5 THEN $4::integer ELSE "monthlyQuota" END WHERE id = $1 AND "revokedAt" IS NULL RETURNING id, name, "rateLimitTier", groups, "monthlyQuota", "createdAt") SELECT * FROM updated`,
      [
        id,
        JSON.stringify(body.groups ?? []),
        body.groups !== undefined,
        quota ?? null,
        quota !== undefined,
      ],
    );
    if (!rows.length)
      throw new NotFoundException('Configuration entry not found');
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @AutomationScope('consumers:write')
  @Delete(':id')
  async remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    const schema = tenantSchema(tenantId);
    await this.dataSource.query(
      `UPDATE ${schema}.consumers SET "revokedAt" = NOW() WHERE id = $1 AND "revokedAt" IS NULL`,
      [id],
    );
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }
}
