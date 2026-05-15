import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { ConfigPushService } from '../config-push/config-push.service';

function tenantSchema(tenantId: string): string {
  if (!/^[0-9a-f-]+$/i.test(tenantId)) throw new Error('Invalid tenantId');
  return `tenant_${tenantId.replace(/-/g, '_')}`;
}

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
      `SELECT id, name, "rateLimitTier", "createdAt" FROM ${schema}.consumers WHERE "revokedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: { name: string; rateLimitTier?: string },
  ) {
    const schema = tenantSchema(tenantId);
    const random = crypto.randomBytes(16).toString('hex');
    const plainKey = `gw_${tenantId}_${random}`;
    const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');

    const rows = await this.dataSource.query(
      `INSERT INTO ${schema}.consumers (name, "keyHash", "rateLimitTier")
       VALUES ($1, $2, $3) RETURNING id, name, "rateLimitTier", "createdAt"`,
      [body.name, keyHash, body.rateLimitTier ?? 'authenticated'],
    );

    await this.configPush.triggerUpdate(tenantId);
    return { ...rows[0], apiKey: plainKey };
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
