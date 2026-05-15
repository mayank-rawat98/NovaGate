import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Tenant, ApiKey } from '../database/entities/public.entities';
import { TenantProvisioningService } from './tenant-provisioning.service';

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    private readonly provisioningService: TenantProvisioningService,
  ) {}

  async createTenant(name: string, email: string) {
    const tenant = await this.tenantRepo.save({
      name,
      email,
      planId: 'free',
      gatewayConfigVersion: 1,
    });

    await this.provisioningService.provisionTenant(tenant.id);

    const { key, hash } = this.generateApiKey(tenant.id);
    await this.apiKeyRepo.save({
      tenantId: tenant.id,
      keyHash: hash,
      label: 'Default Key',
    });

    return { tenant, apiKey: key };
  }

  async getTenant(id: string) {
    return this.tenantRepo.findOneBy({ id });
  }

  async rotateKey(tenantId: string) {
    // Revoke old keys
    await this.apiKeyRepo.update({ tenantId }, { revokedAt: new Date() });

    const { key, hash } = this.generateApiKey(tenantId);
    await this.apiKeyRepo.save({
      tenantId,
      keyHash: hash,
      label: `Key rotated at ${new Date().toISOString()}`,
    });

    return { apiKey: key };
  }

  private generateApiKey(tenantId: string) {
    const random = crypto.randomBytes(16).toString('hex');
    const key = `gw_${tenantId}_${random}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return { key, hash };
  }
}
