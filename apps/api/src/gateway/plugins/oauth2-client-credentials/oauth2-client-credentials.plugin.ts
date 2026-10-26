import { Injectable, Inject } from '@nestjs/common';
import * as http from 'node:http';
import type { Redis } from 'ioredis';
import type {
  GatewayPlugin,
  OAuth2PluginConfig,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { REDIS_CLIENT } from '../../shared/redis.tokens.js';
import { IdentityProviderService } from '../identity-provider/identity-provider.service';

interface Introspection {
  active: boolean;
  sub?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
}
interface CacheEnvelope {
  version: 2;
  scope: string;
  expiresAt: number;
  result: Introspection;
}
@Injectable()
export class OAuth2ClientCredentialsPlugin implements GatewayPlugin {
  readonly name = 'oauth2-client-credentials';
  readonly protocols = ['http', 'grpc', 'websocket'] as const;
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly provider: IdentityProviderService,
  ) {}
  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find(
      (plugin) => plugin.name === this.name,
    );
    if (!entry) return;
    const config = entry.config as unknown as OAuth2PluginConfig;
    try {
      this.validateConfig(config);
    } catch {
      return this.failure(
        ctx,
        500,
        'OAUTH2_MISCONFIGURED',
        'Invalid OAuth configuration',
      );
    }
    if (config.introspectionEndpoint) return this.inbound(ctx, config);
    try {
      const scope = this.scope(ctx, config, 'oauth2:outbound');
      const result = await this.provider.coalesce(
        scope,
        async (signal) => {
          const cached = this.provider.getCached<string>(scope);
          if (cached) return cached;
          const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            ...(config.scopes?.length
              ? { scope: config.scopes.join(' ') }
              : {}),
          }).toString();
          const requestedAt = Date.now();
          const response = (await this.provider.requestJson(
            config.tokenEndpoint as string,
            { body, signal },
          )) as Record<string, unknown>;
          if (
            !this.provider.validToken(response.access_token) ||
            typeof response.token_type !== 'string' ||
            response.token_type.toLowerCase() !== 'bearer' ||
            (response.expires_in !== undefined &&
              (!Number.isSafeInteger(response.expires_in) ||
                Number(response.expires_in) <= 0))
          )
            throw new Error('Invalid token response');
          if (typeof response.expires_in === 'number') {
            // Cache for at most the declared lifetime; unknown lifetimes are never invented.
            const ttl = Math.min(
              Math.max(
                0,
                response.expires_in * 1000 -
                  (Date.now() - requestedAt) -
                  this.provider.settings.timeoutMs,
              ),
              this.provider.settings.outboundCacheTtlMs,
            );
            this.provider.putCached(scope, response.access_token, ttl, signal);
          }
          return response.access_token;
        },
        ctx.signal,
      );
      ctx.signal?.throwIfAborted();
      ctx.req.headers[(config.headerName ?? 'authorization').toLowerCase()] =
        `Bearer ${result}`;
      // Outbound credential injection does not establish inbound authentication.
    } catch {
      return this.failure(
        ctx,
        503,
        'OAUTH2_PROVIDER_UNAVAILABLE',
        'Unable to obtain upstream credentials',
      );
    }
  }
  private scope(
    ctx: PluginContext,
    config: OAuth2PluginConfig,
    kind: string,
    token?: string,
  ) {
    return this.provider.scope(
      kind,
      ctx.tenantId,
      [
        config.introspectionEndpoint ?? null,
        config.tokenEndpoint ?? null,
        config.clientId,
        config.clientSecret,
        [...(config.scopes ?? [])].sort(),
        config.headerName ?? 'authorization',
        config.issuer ?? null,
        config.audience ?? null,
      ],
      token,
    );
  }
  private validateConfig(config: OAuth2PluginConfig) {
    if (
      !config ||
      !this.provider.validToken(config.clientId) ||
      typeof config.clientSecret !== 'string' ||
      !config.clientSecret ||
      Buffer.byteLength(config.clientSecret) >
        this.provider.settings.maxTokenBytes ||
      !!config.introspectionEndpoint === !!config.tokenEndpoint
    )
      throw new Error();
    this.provider.endpoint(
      config.introspectionEndpoint ?? config.tokenEndpoint ?? '',
    );
    if (
      config.scopes !== undefined &&
      (!Array.isArray(config.scopes) ||
        config.scopes.some(
          (scope) => typeof scope !== 'string' || !scope || /\s/.test(scope),
        ))
    )
      throw new Error();
    if (
      config.issuer !== undefined &&
      (typeof config.issuer !== 'string' || !config.issuer)
    )
      throw new Error();
    if (
      config.audience !== undefined &&
      (typeof config.audience !== 'string' || !config.audience)
    )
      throw new Error();
    const header = config.headerName ?? 'authorization';
    http.validateHeaderName(header);
    if (
      [
        'host',
        'content-length',
        'transfer-encoding',
        'connection',
        'upgrade',
        'proxy-authorization',
      ].includes(header.toLowerCase()) ||
      header.toLowerCase().startsWith('sec-websocket-')
    )
      throw new Error();
  }
  private introspection(
    value: unknown,
    config: OAuth2PluginConfig,
  ): Introspection {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    const result = value as Record<string, unknown>;
    if (typeof result.active !== 'boolean') throw new Error();
    if (!result.active) return { active: false };
    for (const name of ['exp', 'nbf'])
      if (result[name] !== undefined && !Number.isSafeInteger(result[name]))
        throw new Error();
    if (
      (typeof result.exp === 'number' && result.exp <= Date.now() / 1000) ||
      (typeof result.nbf === 'number' && result.nbf > Date.now() / 1000)
    )
      return { active: false };
    if (
      result.sub !== undefined &&
      (typeof result.sub !== 'string' ||
        !result.sub ||
        Buffer.byteLength(result.sub) > this.provider.settings.maxTokenBytes)
    )
      throw new Error();
    if (config.issuer && result.iss !== config.issuer) return { active: false };
    if (
      config.audience &&
      !(typeof result.aud === 'string'
        ? result.aud === config.audience
        : Array.isArray(result.aud) && result.aud.includes(config.audience))
    )
      return { active: false };
    return {
      active: true,
      ...(typeof result.sub === 'string' ? { sub: result.sub } : {}),
      ...(typeof result.exp === 'number' ? { exp: result.exp } : {}),
      ...(typeof result.nbf === 'number' ? { nbf: result.nbf } : {}),
      ...(typeof result.iss === 'string' ? { iss: result.iss } : {}),
      ...(typeof result.aud === 'string' ||
      (Array.isArray(result.aud) &&
        result.aud.every((item) => typeof item === 'string'))
        ? { aud: result.aud as string | string[] }
        : {}),
    };
  }
  private async inbound(
    ctx: PluginContext,
    config: OAuth2PluginConfig,
  ): Promise<PluginShortCircuit | void> {
    const match =
      typeof ctx.req.headers.authorization === 'string'
        ? /^Bearer ([^\s]+)$/i.exec(ctx.req.headers.authorization)
        : null;
    if (!match || !this.provider.validToken(match[1]))
      return this.failure(
        ctx,
        401,
        'OAUTH2_TOKEN_MISSING',
        'Valid Bearer token required',
      );
    const token = match[1];
    const scope = this.scope(ctx, config, 'oauth2:introspect', token);
    try {
      const result = await this.provider.coalesce(
        scope,
        async (signal) => {
          // Cache failure falls back to the provider; it never grants authentication by itself.
          let raw: string | null = null;
          try {
            raw = await this.redis.get(scope);
          } catch {
            /* Verify remotely. */
          }
          signal.throwIfAborted();
          if (
            raw &&
            Buffer.byteLength(raw) <= this.provider.settings.maxResponseBytes
          ) {
            try {
              const envelope = JSON.parse(raw) as CacheEnvelope;
              if (
                envelope.version === 2 &&
                envelope.scope === scope &&
                Number.isSafeInteger(envelope.expiresAt) &&
                envelope.expiresAt > Date.now() &&
                envelope.expiresAt <=
                  Date.now() + this.provider.settings.introspectionCacheTtlMs
              ) {
                const cached = this.introspection(envelope.result, config);
                if (cached.active && cached.exp !== undefined) return cached;
              }
            } catch {
              /* Malformed cache entries never establish trust. */
            }
          }
          const response = await this.provider.requestJson(
            config.introspectionEndpoint as string,
            {
              body: new URLSearchParams({ token }).toString(),
              signal,
              headers: {
                authorization: `Basic ${Buffer.from(`${new URLSearchParams({ value: config.clientId }).toString().slice('value='.length)}:${new URLSearchParams({ value: config.clientSecret }).toString().slice('value='.length)}`).toString('base64')}`,
              },
            },
          );
          const validated = this.introspection(response, config);
          const ttl =
            validated.active && validated.exp !== undefined
              ? Math.min(
                  this.provider.settings.introspectionCacheTtlMs,
                  validated.exp * 1000 - Date.now(),
                )
              : 0;
          if (ttl > 0) {
            signal.throwIfAborted();
            const envelope: CacheEnvelope = {
              version: 2,
              scope,
              expiresAt: Math.floor(Date.now() + ttl),
              result: validated,
            };
            await this.redis
              .set(scope, JSON.stringify(envelope), 'PX', Math.floor(ttl))
              .catch(() => undefined);
          }
          signal.throwIfAborted();
          return validated;
        },
        ctx.signal,
      );
      if (!result.active)
        return this.failure(
          ctx,
          401,
          'OAUTH2_TOKEN_INACTIVE',
          'Token is not active for this resource',
        );
      ctx.signal?.throwIfAborted();
      ctx.authentication = {
        method: this.name,
        ...(result.sub ? { subject: result.sub } : {}),
      };
    } catch {
      return this.failure(
        ctx,
        503,
        'OAUTH2_INTROSPECTION_FAILED',
        'Unable to validate credentials',
      );
    }
  }
  private failure(
    ctx: PluginContext,
    status: number,
    error: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status,
      headers: {
        'WWW-Authenticate': 'Bearer realm="Gateway"',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error, message, requestId: ctx.requestId }),
    };
  }
}
