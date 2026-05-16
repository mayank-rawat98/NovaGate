import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service.js';

interface MtlsConfig {
  required: boolean;
}

@Injectable()
export class MtlsPlugin implements GatewayPlugin {
  readonly name = 'mtls';
  private readonly logger = new Logger(MtlsPlugin.name);

  constructor(private readonly configManager: GatewayConfigManagerService) {}

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === 'mtls');
    if (!entry) return;

    const config = entry.config as unknown as MtlsConfig;
    if (!config.required) return;

    const req = ctx.req;

    // Client cert forwarded by TLS-terminating proxy (nginx/Caddy)
    const certHeader =
      req.headers['ssl_client_cert'] ?? req.headers['x-ssl-client-cert'];
    const certStr = Array.isArray(certHeader) ? certHeader[0] : certHeader;

    if (!certStr) {
      return this.forbidden(
        ctx.requestId,
        'MTLS_CERT_MISSING',
        'Client certificate required',
      );
    }

    // URL-decode if needed (nginx sends URL-encoded PEM)
    const pem = decodeURIComponent(certStr);

    const caCertPem = this.configManager.getConfig()?.caCertPem;
    if (!caCertPem) {
      this.logger.warn(
        'mTLS plugin is configured on a route but no CA certificate is set for this tenant',
      );
      return this.forbidden(
        ctx.requestId,
        'MTLS_NO_CA',
        'No CA certificate configured',
      );
    }

    const verifyResult = this.verifyCert(pem, caCertPem);
    if (!verifyResult.ok) {
      return this.forbidden(
        ctx.requestId,
        'MTLS_CERT_INVALID',
        verifyResult.message ?? 'Certificate validation failed',
      );
    }

    // Extract subject info and forward as headers
    if (verifyResult.subject) {
      req.headers['x-ssl-client-subject'] = verifyResult.subject;
    }
    if (verifyResult.san) {
      req.headers['x-ssl-client-san'] = verifyResult.san;
    }
  }

  private verifyCert(
    clientPem: string,
    caPem: string,
  ):
    | { ok: true; subject?: string; san?: string }
    | { ok: false; message?: string } {
    try {
      const clientCert = new crypto.X509Certificate(clientPem);
      const caCert = new crypto.X509Certificate(caPem);

      if (!clientCert.verify(caCert.publicKey)) {
        return { ok: false, message: 'Certificate not signed by trusted CA' };
      }

      // Check expiry
      const now = new Date();
      if (
        now < new Date(clientCert.validFrom) ||
        now > new Date(clientCert.validTo)
      ) {
        return {
          ok: false,
          message: 'Certificate has expired or is not yet valid',
        };
      }

      return {
        ok: true,
        subject: clientCert.subject,
        san: clientCert.subjectAltName ?? undefined,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private forbidden(
    requestId: string,
    code: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: code, message, requestId }),
    };
  }
}
