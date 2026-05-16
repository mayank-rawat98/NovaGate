import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import jwt from 'jsonwebtoken';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';

interface JwkKey {
  kty: string;
  kid?: string;
  use?: string;
  n?: string;
  e?: string;
  x5c?: string[];
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface JwksResponse {
  keys: JwkKey[];
}

interface OidcConfig {
  jwksUri: string;
  issuer: string;
  audience?: string;
  claimsToForward?: string[];
}

interface JwksCacheEntry {
  keys: JwkKey[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OidcPlugin implements GatewayPlugin {
  readonly name = 'oidc';
  private readonly logger = new Logger(OidcPlugin.name);

  // In-memory JWKS cache keyed by jwksUri
  private readonly cache = new Map<string, JwksCacheEntry>();

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === 'oidc');
    if (!entry) return;

    const config = entry.config as unknown as OidcConfig;
    const req = ctx.req;

    const authHeader = req.headers['authorization'];
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!header?.startsWith('Bearer ')) {
      return this.unauthorized(
        ctx.requestId,
        'OIDC_TOKEN_MISSING',
        'Bearer token required',
      );
    }

    const token = header.slice(7);

    let kid: string | undefined;
    try {
      const decoded = jwt.decode(token, { complete: true });
      kid = (decoded?.header as { kid?: string } | null)?.kid;
    } catch {
      return this.unauthorized(
        ctx.requestId,
        'OIDC_TOKEN_INVALID',
        'Malformed token',
      );
    }

    let keys: JwkKey[];
    try {
      keys = await this.getKeys(config.jwksUri, kid);
    } catch (err) {
      this.logger.error(`JWKS fetch failed: ${(err as Error).message}`);
      return this.unauthorized(
        ctx.requestId,
        'OIDC_JWKS_UNAVAILABLE',
        'Unable to fetch signing keys',
      );
    }

    const verifyResult = this.verifyWithKeys(token, keys, config, kid);
    if (!verifyResult.ok) {
      // On kid miss, refresh cache once and retry
      if (verifyResult.reason === 'KID_MISS') {
        try {
          keys = await this.fetchAndCache(config.jwksUri);
          const retried = this.verifyWithKeys(token, keys, config, kid);
          if (!retried.ok) {
            return this.unauthorized(
              ctx.requestId,
              'OIDC_TOKEN_INVALID',
              retried.message ?? 'Token verification failed',
            );
          }
          this.forwardClaims(ctx, retried.payload!, config.claimsToForward);
          return;
        } catch {
          return this.unauthorized(
            ctx.requestId,
            'OIDC_TOKEN_INVALID',
            'Token verification failed after key refresh',
          );
        }
      }
      return this.unauthorized(
        ctx.requestId,
        'OIDC_TOKEN_INVALID',
        verifyResult.message ?? 'Token verification failed',
      );
    }

    this.forwardClaims(ctx, verifyResult.payload!, config.claimsToForward);
  }

  private verifyWithKeys(
    token: string,
    keys: JwkKey[],
    config: OidcConfig,
    kid?: string,
  ):
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; reason?: string; message?: string } {
    const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
    if (candidates.length === 0 && kid) {
      return { ok: false, reason: 'KID_MISS' };
    }

    const keysToTry = candidates.length > 0 ? candidates : keys;

    for (const jwk of keysToTry) {
      try {
        const pem = this.jwkToPem(jwk);
        if (!pem) continue;

        const verifyOpts: jwt.VerifyOptions = {
          issuer: config.issuer,
          algorithms: this.algorithmForKey(jwk),
        };
        if (config.audience) verifyOpts.audience = config.audience;

        const payload = jwt.verify(token, pem, verifyOpts) as Record<
          string,
          unknown
        >;
        return { ok: true, payload };
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
          return { ok: false, message: 'Token has expired' };
        }
        // Try next key
      }
    }

    return { ok: false, message: 'No valid signing key found' };
  }

  private forwardClaims(
    ctx: PluginContext,
    payload: Record<string, unknown>,
    claimsToForward?: string[],
  ): void {
    if (!claimsToForward?.length) return;
    const req = ctx.req;
    for (const claim of claimsToForward) {
      const val = payload[claim];
      if (val != null) {
        req.headers[`x-claim-${claim.toLowerCase()}`] = String(val);
      }
    }
  }

  private async getKeys(jwksUri: string, kid?: string): Promise<JwkKey[]> {
    const cached = this.cache.get(jwksUri);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      // If we have a kid and it's in the cache, return; otherwise force refresh below
      if (!kid || cached.keys.some((k) => k.kid === kid)) {
        return cached.keys;
      }
    }
    return this.fetchAndCache(jwksUri);
  }

  private async fetchAndCache(jwksUri: string): Promise<JwkKey[]> {
    const body = await this.fetchJson(jwksUri);
    const jwks = body as JwksResponse;
    this.cache.set(jwksUri, { keys: jwks.keys, fetchedAt: Date.now() });
    return jwks.keys;
  }

  private fetchJson(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https://') ? https : http;
      const req = client.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON from JWKS endpoint'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('JWKS fetch timeout'));
      });
    });
  }

  private jwkToPem(jwk: JwkKey): string | null {
    try {
      if (jwk.kty === 'RSA' && jwk.n && jwk.e) {
        const key = crypto.createPublicKey({
          key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
          format: 'jwk',
        });
        return key.export({ type: 'spki', format: 'pem' }) as string;
      }
      if (jwk.kty === 'EC' && jwk.crv && jwk.x && jwk.y) {
        const key = crypto.createPublicKey({
          key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
          format: 'jwk',
        });
        return key.export({ type: 'spki', format: 'pem' }) as string;
      }
      if (jwk.x5c?.[0]) {
        const der = Buffer.from(jwk.x5c[0], 'base64');
        const key = crypto.createPublicKey({
          key: der,
          format: 'der',
          type: 'spki',
        });
        return key.export({ type: 'spki', format: 'pem' }) as string;
      }
    } catch {
      return null;
    }
    return null;
  }

  private algorithmForKey(jwk: JwkKey): jwt.Algorithm[] {
    if (jwk.alg) return [jwk.alg as jwt.Algorithm];
    if (jwk.kty === 'RSA') return ['RS256', 'RS384', 'RS512'];
    if (jwk.kty === 'EC') {
      if (jwk.crv === 'P-384') return ['ES384'];
      if (jwk.crv === 'P-521') return ['ES512'];
      return ['ES256'];
    }
    return ['RS256'];
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

  // Exposed for tests
  clearCache(): void {
    this.cache.clear();
  }
}
