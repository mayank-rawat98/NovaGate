import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { Tenant } from '../database/entities/public.entities';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly provisioningService: TenantProvisioningService,
    private readonly emailService: EmailService,
  ) {}

  async register(name: string, email: string, password: string) {
    const existing = await this.tenantRepo.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(password, 10);
    const tenant = await this.tenantRepo.save({
      name,
      email,
      passwordHash,
      planId: 'free',
      gatewayConfigVersion: 1,
    });

    const gatewayApiKey = await this.provisioningService.provisionTenant(tenant.id);

    return { token: this.sign(tenant.id), tenantId: tenant.id, gatewayApiKey };
  }

  async login(email: string, password: string) {
    const tenant = await this.tenantRepo.findOne({ where: { email } });
    if (!tenant || !tenant.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, tenant.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return { token: this.sign(tenant.id), tenantId: tenant.id };
  }

  async forgotPassword(email: string): Promise<void> {
    const tenant = await this.tenantRepo.findOne({ where: { email } });
    // Always return success to avoid leaking which emails are registered
    if (!tenant) return;

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.tenantRepo.update(tenant.id, {
      resetPasswordToken: token,
      resetPasswordExpires: expires,
    });

    const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3003';
    const resetUrl = `${dashboardUrl}/reset-password?token=${token}`;
    await this.emailService.sendPasswordReset(email, resetUrl);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tenant = await this.tenantRepo.findOne({
      where: { resetPasswordToken: token },
    });

    if (!tenant || !tenant.resetPasswordExpires) {
      throw new NotFoundException('Invalid or expired reset token');
    }

    if (tenant.resetPasswordExpires < new Date()) {
      throw new BadRequestException('Reset token has expired');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.tenantRepo.update(tenant.id, {
      passwordHash,
      resetPasswordToken: null as unknown as string,
      resetPasswordExpires: null as unknown as Date,
    });
  }

  private sign(tenantId: string): string {
    const secret = process.env.PLATFORM_JWT_SECRET ?? 'changeme-platform-secret-32-chars!';
    return jwt.sign({ sub: tenantId }, secret, { expiresIn: '7d' });
  }
}
