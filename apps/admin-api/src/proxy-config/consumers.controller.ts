import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { ConfigPushService } from '../config-push/config-push.service';
import { tenantSchema } from '../tenants/tenant-schema';

@Controller('tenants/:tenantId/consumers')
export class ConsumersController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
  ) {}

  @Get()
  async findAll(@Param('tenantId') tenantId: string) {
    const schema = tenantSchema(tenantId);
    return this.dataSource.query(
      `SELECT id, name, "rateLimitTier", groups, "createdAt" FROM ${schema}.consumers WHERE "revokedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: { name: string; rateLimitTier?: string; groups?: string[] },
  ) {
    const schema = tenantSchema(tenantId);
    const random = crypto.randomBytes(16).toString('hex');
    const plainKey = `gw_${tenantId}_${random}`;
    const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');

    const rows = await this.dataSource.query(
      `INSERT INTO ${schema}.consumers (name, "keyHash", "rateLimitTier", groups)
       VALUES ($1, $2, $3, $4) RETURNING id, name, "rateLimitTier", groups, "createdAt"`,
      [
        body.name,
        keyHash,
        body.rateLimitTier ?? 'authenticated',
        JSON.stringify(body.groups ?? []),
      ],
    );

    await this.configPush.triggerUpdate(tenantId);
    return { ...rows[0], apiKey: plainKey };
  }

  @Put(':id')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: { groups?: string[] },
  ) {
    const schema = tenantSchema(tenantId);
    const rows = await this.dataSource.query(
      `WITH updated AS (UPDATE ${schema}.consumers SET groups = CASE WHEN $3 THEN $2::jsonb ELSE groups END WHERE id = $1 AND "revokedAt" IS NULL RETURNING id, name, "rateLimitTier", groups, "createdAt") SELECT * FROM updated`,
      [id, JSON.stringify(body.groups ?? []), body.groups !== undefined],
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
      `UPDATE ${schema}.consumers SET "revokedAt" = NOW() WHERE id = $1 AND "revokedAt" IS NULL`,
      [id],
    );
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }
}
