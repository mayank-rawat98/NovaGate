import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
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
import { platformJwtSecret } from './platform-jwt-secret';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly provisioningService: TenantProvisioningService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Enumeration-safe signup. Always returns void and the caller responds with a
   * generic "check your email" message regardless of whether the address is new
   * — so the response never reveals which emails are registered. The gateway is
   * only provisioned once the email is verified (see {@link verifyEmail}).
   */
  async register(name: string, email: string, password: string): Promise<void> {
    const existing = await this.tenantRepo.findOne({ where: { email } });
    const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3003';

    if (existing) {
      if (existing.emailVerified) {
        // Real owner already has an account — let them know without telling the
        // person who triggered this whether the account exists.
        await this.emailService.sendExistingAccountNotice(
          email,
          `${dashboardUrl}/login`,
        );
      } else {
        // Pending signup never verified — refresh the link so they can finish.
        const token = await this.issueVerifyToken(existing.id);
        await this.emailService.sendVerification(
          email,
          `${dashboardUrl}/verify?token=${token}`,
        );
      }
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const tenant = await this.tenantRepo.save({
      name,
      email,
      passwordHash,
      planId: 'free',
      gatewayConfigVersion: 1,
      emailVerified: false,
    });

    const token = await this.issueVerifyToken(tenant.id);
    await this.emailService.sendVerification(
      email,
      `${dashboardUrl}/verify?token=${token}`,
    );
  }

  /**
   * Confirms a signup: marks the email verified, provisions the gateway, and
   * returns an auth session so the dashboard can continue straight to setup.
   */
  async verifyEmail(token: string) {
    const tenant = await this.tenantRepo.findOne({
      where: { verifyToken: token },
    });

    if (!tenant || !tenant.verifyExpires) {
      throw new NotFoundException('Invalid or expired verification link');
    }
    if (tenant.verifyExpires < new Date()) {
      throw new BadRequestException('Verification link has expired');
    }

    // The token is single-use: it's cleared below on success, so a second click
    // won't match this query and we never double-provision the API key.
    const gatewayApiKey = await this.provisioningService.provisionTenant(
      tenant.id,
    );

    await this.tenantRepo.update(tenant.id, {
      emailVerified: true,
      verifyToken: null as unknown as string,
      verifyExpires: null as unknown as Date,
    });

    return {
      token: this.sign(tenant.id),
      tenantId: tenant.id,
      gatewayApiKey,
    };
  }

  async login(email: string, password: string) {
    const tenant = await this.tenantRepo.findOne({ where: { email } });
    if (!tenant || !tenant.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, tenant.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    // Only reached with correct credentials, so this doesn't leak existence to
    // anyone who isn't already the password holder.
    if (!tenant.emailVerified) {
      throw new ForbiddenException(
        'Please verify your email before signing in.',
      );
    }

    return { token: this.sign(tenant.id), tenantId: tenant.id };
  }

  private async issueVerifyToken(tenantId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await this.tenantRepo.update(tenantId, {
      verifyToken: token,
      verifyExpires: expires,
    });
    return token;
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
    const secret = platformJwtSecret();
    return jwt.sign({ sub: tenantId }, secret, { expiresIn: '7d' });
  }
}
