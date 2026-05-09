import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
    try {
      await this.transporter.sendMail({
        from,
        to,
        subject: 'Reset your API Gateway password',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#111">Reset your password</h2>
            <p style="color:#555">Click the button below to set a new password. This link expires in 1 hour.</p>
            <a href="${resetUrl}"
               style="display:inline-block;margin:16px 0;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
              Reset password
            </a>
            <p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
            <p style="color:#bbb;font-size:12px">Link: ${resetUrl}</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error('Failed to send password reset email', err);
      throw err;
    }
  }
}
