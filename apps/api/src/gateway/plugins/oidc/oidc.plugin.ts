import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type {
  GatewayPlugin,
  OidcPluginConfig,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { IdentityProviderService } from '../identity-provider/identity-provider.service';

interface SigningKey {
  kid?: string;
  key: crypto.KeyObject;
  algorithms: jwt.Algorithm[];
}
interface KeySet {
  keys: SigningKey[];
  fetchedAt: number;
}
@Injectable()
export class OidcPlugin implements GatewayPlugin {
  readonly name = 'oidc';
  readonly protocols = ['http', 'grpc', 'websocket'] as const;
  constructor(private readonly provider: IdentityProviderService) {}
  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find(
      (plugin) => plugin.name === this.name,
    );
    if (!entry) return;
    // Claims supplied by the client cannot survive an OIDC authentication boundary.
    for (const name of Object.keys(ctx.req.headers))
      if (name.startsWith('x-claim-')) delete ctx.req.headers[name];
    const config = entry.config as unknown as OidcPluginConfig;
    try {
      if (
        !config ||
        typeof config.jwksUri !== 'string' ||
        typeof config.issuer !== 'string' ||
        !config.issuer ||
        (config.audience !== undefined &&
          (typeof config.audience !== 'string' || !config.audience)) ||
        (config.claimsToForward !== undefined &&
          (!Array.isArray(config.claimsToForward) ||
            config.claimsToForward.some(
              (claim) =>
                typeof claim !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(claim),
            )))
      )
        throw new Error();
      this.provider.endpoint(config.jwksUri);
    } catch {
      return this.failure(
        ctx,
        500,
        'OIDC_MISCONFIGURED',
        'Invalid OIDC configuration',
      );
    }
    const match =
      typeof ctx.req.headers.authorization === 'string'
        ? /^Bearer ([^\s]+)$/i.exec(ctx.req.headers.authorization)
        : null;
    if (!match)
      return this.failure(
        ctx,
        401,
        'OIDC_TOKEN_MISSING',
        'Bearer token required',
      );
    const token = match[1];
    if (!this.provider.validToken(token))
      return this.failure(ctx, 401, 'OIDC_TOKEN_INVALID', 'Invalid token');
    const decoded = jwt.decode(token, { complete: true });
    if (
      !decoded ||
      typeof decoded.payload === 'string' ||
      (decoded.header.kid !== undefined &&
        typeof decoded.header.kid !== 'string')
    )
      return this.failure(ctx, 401, 'OIDC_TOKEN_INVALID', 'Invalid token');
    const kid = decoded.header.kid;
    const scope = this.provider.scope('oidc:jwks', ctx.tenantId, [
      config.jwksUri,
      config.issuer,
      config.audience ?? null,
    ]);
    let keys: SigningKey[];
    try {
      const set = await this.provider.coalesce(
        scope,
        async (signal) => {
          const cached = this.provider.getCached<KeySet>(scope);
          if (
            cached &&
            (!kid ||
              cached.keys.some((key) => key.kid === kid) ||
              Date.now() - cached.fetchedAt <
                this.provider.settings.jwksRefreshCooldownMs)
          )
            return cached;
          const value = (await this.provider.requestJson(config.jwksUri, {
            signal,
          })) as { keys?: unknown[] };
          if (
            !Array.isArray(value.keys) ||
            value.keys.length > this.provider.settings.maxJwksKeys
          )
            throw new Error('Invalid JWKS');
          const fresh = {
            keys: value.keys
              .map((key) => this.signingKey(key))
              .filter((key): key is SigningKey => key !== undefined),
            fetchedAt: Date.now(),
          };
          this.provider.putCached(
            scope,
            fresh,
            this.provider.settings.jwksCacheTtlMs,
            signal,
          );
          return fresh;
        },
        ctx.signal,
      );
      keys = set.keys;
    } catch {
      return this.failure(
        ctx,
        503,
        'OIDC_JWKS_UNAVAILABLE',
        'Signing keys unavailable',
      );
    }
    for (const key of keys) {
      if (
        (kid && key.kid !== kid) ||
        !key.algorithms.includes(decoded.header.alg as jwt.Algorithm)
      )
        continue;
      try {
        const payload = jwt.verify(token, key.key, {
          algorithms: key.algorithms,
          issuer: config.issuer,
          ...(config.audience ? { audience: config.audience } : {}),
        });
        if (
          typeof payload === 'string' ||
          !Number.isSafeInteger(payload.exp) ||
          (payload.exp ?? 0) <= Date.now() / 1000
        )
          continue;
        ctx.signal?.throwIfAborted();
        const forwarded: Record<string, string> = {};
        for (const claim of config.claimsToForward ?? []) {
          const value: unknown = payload[claim];
          if (value === undefined || value === null) continue;
          if (
            !['string', 'number', 'boolean'].includes(typeof value) ||
            [...String(value)].some((char) =>
              [0, 10, 13].includes(char.charCodeAt(0)),
            ) ||
            Buffer.byteLength(String(value)) >
              this.provider.settings.maxHeaderBytes
          )
            throw new Error('Invalid forwarded claim');
          forwarded[`x-claim-${claim.toLowerCase()}`] = String(value);
        }
        Object.assign(ctx.req.headers, forwarded);
        ctx.authentication = {
          method: this.name,
          ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
        };
        return;
      } catch {
        /* Try only bounded, explicitly compatible public signing keys. */
      }
    }
    return this.failure(
      ctx,
      401,
      'OIDC_TOKEN_INVALID',
      'Token verification failed',
    );
  }
  private signingKey(value: unknown): SigningKey | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const jwk = value as Record<string, unknown>;
    if (
      (jwk.use !== undefined && jwk.use !== 'sig') ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) ||
      (jwk.kid !== undefined && typeof jwk.kid !== 'string')
    )
      return;
    try {
      let key: crypto.KeyObject;
      if (
        jwk.kty === 'RSA' &&
        typeof jwk.n === 'string' &&
        typeof jwk.e === 'string'
      )
        key = crypto.createPublicKey({
          format: 'jwk',
          key: { kty: 'RSA', n: jwk.n, e: jwk.e },
        });
      else if (
        jwk.kty === 'EC' &&
        typeof jwk.crv === 'string' &&
        typeof jwk.x === 'string' &&
        typeof jwk.y === 'string'
      )
        key = crypto.createPublicKey({
          format: 'jwk',
          key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y },
        });
      else if (Array.isArray(jwk.x5c) && typeof jwk.x5c[0] === 'string')
        key = new crypto.X509Certificate(Buffer.from(jwk.x5c[0], 'base64'))
          .publicKey;
      else return;
      let algorithms: jwt.Algorithm[];
      if (
        jwk.kty === 'RSA' &&
        key.asymmetricKeyType === 'rsa' &&
        (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
      )
        algorithms = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'];
      else if (jwk.kty === 'EC' && key.asymmetricKeyType === 'ec') {
        const curve = key.asymmetricKeyDetails?.namedCurve;
        algorithms =
          curve === 'prime256v1'
            ? ['ES256']
            : curve === 'secp384r1'
              ? ['ES384']
              : curve === 'secp521r1'
                ? ['ES512']
                : [];
      } else return;
      if (jwk.alg !== undefined) {
        if (
          typeof jwk.alg !== 'string' ||
          !algorithms.includes(jwk.alg as jwt.Algorithm)
        )
          return;
        algorithms = [jwk.alg as jwt.Algorithm];
      }
      if (!algorithms.length) return;
      return {
        key,
        algorithms,
        ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}),
      };
    } catch {
      return;
    }
  }
  clearCache() {
    this.provider.clearCache();
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
