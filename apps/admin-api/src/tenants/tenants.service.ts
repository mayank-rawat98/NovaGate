import {
  MAX_TENANT_CA_BUNDLE_BYTES,
  MAX_TENANT_CA_CERTIFICATES,
} from '@api-gateway/shared-types';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Tenant, ApiKey } from '../database/entities/public.entities';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { ConfigPushService } from '../config-push/config-push.service';

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    private readonly provisioningService: TenantProvisioningService,
    private readonly configPush: ConfigPushService,
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
    return this.tenantRepo.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'email',
        'planId',
        'gatewayConfigVersion',
        'lastSeen',
        'createdAt',
        'emailVerified',
        'caCertPem',
      ],
    });
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

  async setCaCert(tenantId: string, caCertPem: string | null) {
    if (caCertPem !== null) {
      try {
        if (
          typeof caCertPem !== 'string' ||
          Buffer.byteLength(caCertPem) > MAX_TENANT_CA_BUNDLE_BYTES
        )
          throw new Error();
        const pattern =
          /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
        const blocks = caCertPem.match(pattern);
        if (
          !blocks?.length ||
          blocks.length > MAX_TENANT_CA_CERTIFICATES ||
          caCertPem.replace(pattern, '').trim()
        )
          throw new Error();
        for (const block of blocks) {
          const ca = new crypto.X509Certificate(block);
          if (
            !ca.ca ||
            Date.now() < Date.parse(ca.validFrom) ||
            Date.now() >= Date.parse(ca.validTo)
          )
            throw new Error();
        }
        caCertPem = blocks.join('\n');
      } catch {
        throw new BadRequestException(
          'Provide a valid, currently active CA certificate bundle (up to eight certificates, 64 KiB). Private keys and leaf certificates are not accepted.',
        );
      }
    }
    await this.tenantRepo.update({ id: tenantId }, { caCertPem });
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }

  private generateApiKey(tenantId: string) {
    const random = crypto.randomBytes(16).toString('hex');
    const key = `gw_${tenantId}_${random}`;
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return { key, hash };
  }
}
