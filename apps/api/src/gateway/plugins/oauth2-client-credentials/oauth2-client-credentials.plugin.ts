import { Injectable, Inject, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import type { Redis } from 'ioredis';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { REDIS_CLIENT } from '../../shared/redis.tokens.js';

interface OAuth2Config {
  // Mode A: validate inbound Bearer tokens via introspection
  introspectionEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  // Mode B: inject outbound Bearer token via client credentials grant
  tokenEndpoint?: string;
  scopes?: string[];
  headerName?: string; // header to inject upstream token into, default 'Authorization'
}

interface IntrospectionResponse {
  active: boolean;
  sub?: string;
  exp?: number;
  [key: string]: unknown;
}

const CACHE_PREFIX = 'oauth2:introspect:';

@Injectable()
export class OAuth2ClientCredentialsPlugin implements GatewayPlugin {
  readonly name = 'oauth2-client-credentials';
  private readonly logger = new Logger(OAuth2ClientCredentialsPlugin.name);

  // Keyed by tokenEndpoint+clientId+scopes so routes with different configs don't share tokens
  private readonly outboundTokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find(
      (p) => p.name === 'oauth2-client-credentials',
    );
    if (!entry) return;

    const config = entry.config as unknown as OAuth2Config;

    // Mode A: validate inbound token via introspection
    if (config.introspectionEndpoint) {
      return this.validateInbound(ctx, config);
    }

    // Mode B: inject outbound client credentials token
    if (config.tokenEndpoint && config.clientId && config.clientSecret) {
      return this.injectOutbound(ctx, config);
    }
  }

  private async validateInbound(
    ctx: PluginContext,
    config: OAuth2Config,
  ): Promise<PluginShortCircuit | void> {
    if (!config.clientId || !config.clientSecret) {
      ctx.logger.error(
        'oauth2-client-credentials plugin misconfigured: clientId and clientSecret are required for introspection',
      );
      return this.unauthorized(
        ctx.requestId,
        'OAUTH2_MISCONFIGURED',
        'Plugin configuration error: clientId and clientSecret are required',
      );
    }

    const authHeader = ctx.req.headers['authorization'];
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!header?.startsWith('Bearer ')) {
      return this.unauthorized(
        ctx.requestId,
        'OAUTH2_TOKEN_MISSING',
        'Bearer token required',
      );
    }

    const token = header.slice(7);

    // Check Redis cache first
    const cacheKey = `${CACHE_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;
    let result: IntrospectionResponse | null = null;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        result = JSON.parse(cached) as IntrospectionResponse;
      }
    } catch {
      // Redis failure — fail open, proceed to introspect
    }

    if (!result) {
      try {
        result = await this.introspect(token, config);
        if (result.active && result.exp) {
          const ttl = Math.max(0, result.exp - Math.floor(Date.now() / 1000));
          if (ttl > 0) {
            await this.redis
              .set(cacheKey, JSON.stringify(result), 'EX', ttl)
              .catch(() => undefined);
          }
        }
      } catch (err) {
        this.logger.error(
          `Token introspection failed: ${(err as Error).message}`,
        );
        return this.unauthorized(
          ctx.requestId,
          'OAUTH2_INTROSPECTION_FAILED',
          'Could not validate token',
        );
      }
    }

    if (!result.active) {
      return this.unauthorized(
        ctx.requestId,
        'OAUTH2_TOKEN_INACTIVE',
        'Token is not active',
      );
    }

    ctx.authentication = { method: this.name, subject: result.sub };
  }

  private async injectOutbound(
    ctx: PluginContext,
    config: OAuth2Config,
  ): Promise<void> {
    const token = await this.getOutboundToken(config);
    const headerName = config.headerName ?? 'Authorization';
    ctx.req.headers[headerName.toLowerCase()] = `Bearer ${token}`;
  }

  private async getOutboundToken(config: OAuth2Config): Promise<string> {
    const cacheKey = `${config.tokenEndpoint}:${config.clientId}:${(config.scopes ?? []).join(',')}`;
    const cached = this.outboundTokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt - 30_000) {
      return cached.token;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      ...(config.scopes?.length ? { scope: config.scopes.join(' ') } : {}),
    });

    const response = await this.postForm(
      config.tokenEndpoint!,
      body.toString(),
    );
    const data = response as { access_token: string; expires_in?: number };

    const expiresIn = (data.expires_in ?? 3600) * 1000;
    this.outboundTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn,
    });
    return data.access_token;
  }

  private introspect(
    token: string,
    config: OAuth2Config,
  ): Promise<IntrospectionResponse> {
    const credentials = Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString('base64');
    const body = `token=${encodeURIComponent(token)}`;
    return this.postForm(config.introspectionEndpoint!, body, {
      Authorization: `Basic ${credentials}`,
    }) as Promise<IntrospectionResponse>;
  }

  private postForm(
    url: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = url.startsWith('https://') ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (url.startsWith('https://') ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          ...extraHeaders,
        },
        timeout: 5000,
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON from token endpoint'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Token endpoint timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  private unauthorized(
    requestId: string,
    code: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="Gateway"',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: code, message, requestId }),
    };
  }
}
