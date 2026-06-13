import { Injectable, Logger } from '@nestjs/common';

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  private readonly apiKey = process.env.SMTP_API_KEY;
  private readonly apiBaseUrl =
    process.env.SMTP_API_BASE_URL ?? 'https://api.mailtr.co';
  private readonly from = process.env.SMTP_FROM ?? 'support@novagate.dev';

  private async send({
    to,
    subject,
    html,
    text,
  }: SendEmailParams): Promise<void> {
    if (!this.apiKey) {
      throw new Error('SMTP_API_KEY is not configured');
    }

    const res = await fetch(`${this.apiBaseUrl}/api/v1/emails/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject,
        html,
        ...(text ? { text } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Email API responded with ${res.status} ${res.statusText}${
          detail ? `: ${detail}` : ''
        }`,
      );
    }
  }

  async sendVerification(to: string, verifyUrl: string): Promise<void> {
    try {
      await this.send({
        to,
        subject: 'Confirm your NovaGate account',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#111">Confirm your email</h2>
            <p style="color:#555">Click the button below to finish creating your NovaGate account. This link expires in 1 hour.</p>
            <a href="${verifyUrl}"
               style="display:inline-block;margin:16px 0;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
              Confirm email
            </a>
            <p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
            <p style="color:#bbb;font-size:12px">Link: ${verifyUrl}</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error('Failed to send verification email', err);
      throw err;
    }
  }

  /**
   * Sent when someone tries to register with an email that already has an
   * account. Lets the real owner know without revealing account existence to
   * the person who triggered the signup attempt.
   */
  async sendExistingAccountNotice(to: string, loginUrl: string): Promise<void> {
    try {
      await this.send({
        to,
        subject: 'Someone tried to sign up with your email',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#111">You already have a NovaGate account</h2>
            <p style="color:#555">Someone just attempted to sign up using this email address. If it was you, simply log in — there's no need to create another account.</p>
            <a href="${loginUrl}"
               style="display:inline-block;margin:16px 0;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
              Log in
            </a>
            <p style="color:#888;font-size:13px">If this wasn't you, you can safely ignore this email — no account was created and nothing has changed. Consider resetting your password if you're concerned.</p>
          </div>
        `,
      });
    } catch (err) {
      this.logger.error('Failed to send existing-account notice', err);
      throw err;
    }
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    try {
      await this.send({
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
