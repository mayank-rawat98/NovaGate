import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

interface Credential {
  username: string;
  passwordHash: string; // SHA-256 hex of the password
}

interface BasicAuthConfig {
  credentials: Credential[];
  realm?: string;
}

@Injectable()
export class BasicAuthPlugin implements GatewayPlugin {
  readonly name = 'basic-auth';

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === 'basic-auth');
    if (!entry) return;

    const config = entry.config as unknown as BasicAuthConfig;
    const realm = config.realm ?? 'Gateway';
    const req = ctx.req as IncomingMessage;

    const authHeader = req.headers['authorization'];
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!header?.startsWith('Basic ')) {
      return this.unauthorized(realm, ctx.requestId);
    }

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) return this.unauthorized(realm, ctx.requestId);

    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);
    const passwordHash = crypto
      .createHash('sha256')
      .update(password)
      .digest('hex');

    const valid = config.credentials.some(
      (c) =>
        c.username === username &&
        crypto.timingSafeEqual(
          Buffer.from(c.passwordHash, 'hex'),
          Buffer.from(passwordHash, 'hex'),
        ),
    );

    if (!valid) return this.unauthorized(realm, ctx.requestId);
  }

  private unauthorized(realm: string, requestId: string): PluginShortCircuit {
    return {
      status: 401,
      headers: {
        'WWW-Authenticate': `Basic realm="${realm}"`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: 'BASIC_AUTH_INVALID',
        message: 'Invalid credentials',
        requestId,
      }),
    };
  }
}
