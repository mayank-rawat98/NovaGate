import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockList, isIP } from 'node:net';
import { TLSSocket, type DetailedPeerCertificate } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type {
  GatewayPlugin,
  MtlsPluginConfig,
  PluginContext,
  PluginShortCircuit,
} from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../../config-manager/gateway-config-manager.service.js';
import {
  DEFAULT_MTLS,
  type GatewayConfig,
  type MtlsSettings,
} from '../../../config/configuration';
import { certificateBundle, anchored } from '../../../config/certificate-trust';

@Injectable()
export class MtlsPlugin implements GatewayPlugin {
  readonly name = 'mtls';
  readonly protocols = ['http', 'grpc', 'websocket'] as const;
  private readonly settings: MtlsSettings;
  private readonly proxies = new BlockList();
  constructor(
    private readonly manager: GatewayConfigManagerService,
    config: ConfigService<GatewayConfig, true>,
  ) {
    const configured = config.get('mtls', { infer: true });
    this.settings = {
      ...DEFAULT_MTLS,
      ...configured,
      trustedProxyCidrs: configured?.trustedProxyCidrs ?? [],
    };
    for (const cidr of this.settings.trustedProxyCidrs) {
      const [address, prefix] = cidr.split('/');
      const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
      if (prefix === undefined) this.proxies.addAddress(address, family);
      else this.proxies.addSubnet(address, Number(prefix), family);
    }
  }
  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find(
      (plugin) => plugin.name === this.name,
    );
    if (!entry) return;
    // Client assertions never survive this boundary, even when mTLS is optional.
    for (const name of Object.keys(ctx.req.headers))
      if (name.startsWith('ssl_client_') || name.startsWith('x-ssl-client-'))
        delete ctx.req.headers[name];
    const config = entry.config as unknown as MtlsPluginConfig;
    if (!config || typeof config.required !== 'boolean')
      return this.failure(
        ctx,
        500,
        'MTLS_MISCONFIGURED',
        'Invalid mTLS configuration',
      );
    if (!config.required) return;
    let anchors: X509Certificate[];
    const pem = this.manager.getConfig()?.caCertPem;
    if (!pem)
      return this.failure(ctx, 403, 'MTLS_NO_CA', 'No tenant CA configured');
    try {
      anchors = certificateBundle(
        pem,
        this.settings.maxCaBundleBytes,
        this.settings.maxChainDepth,
        true,
      );
    } catch {
      return this.failure(
        ctx,
        503,
        'MTLS_INVALID_CA',
        'Tenant certificate trust is unavailable',
      );
    }
    try {
      const socket = ctx.req.socket;
      let chain: X509Certificate[];
      if (
        socket instanceof TLSSocket &&
        socket.getPeerCertificate(true)?.raw?.length
      ) {
        const peer = socket.getPeerCertificate(true);
        // Resumed sessions may report authorized without a peer certificate. Never infer identity from it.
        if (!peer?.raw?.length || !socket.authorized)
          throw new Error('Unverified TLS peer');
        const seen = new Set<string>();
        const certificates: string[] = [];
        let current: DetailedPeerCertificate | undefined = peer;
        while (current?.raw?.length) {
          if (seen.has(current.fingerprint256)) break;
          if (certificates.length >= this.settings.maxChainDepth)
            throw new Error('Certificate chain too deep');
          seen.add(current.fingerprint256);
          const cert = new X509Certificate(current.raw);
          certificates.push(cert.toString());
          if (
            anchors.some(
              (anchor) =>
                cert.checkIssued(anchor) && cert.verify(anchor.publicKey),
            )
          )
            break;
          current = current.issuerCertificate;
        }
        chain = certificateBundle(
          certificates.join('\n'),
          this.settings.maxCertificateBytes,
          this.settings.maxChainDepth,
        );
      } else {
        const address = socket?.remoteAddress;
        const family = address && isIP(address);
        if (
          !address ||
          !family ||
          !this.proxies.check(address, family === 4 ? 'ipv4' : 'ipv6')
        )
          throw new Error('Untrusted certificate source');
        // The trusted terminator must overwrite these assertions after proving client private-key possession.
        const headers = this.assertions(ctx);
        if (headers.verify !== 'SUCCESS' || !headers.pem)
          throw new Error('Unverified proxy assertion');
        chain = certificateBundle(
          decodeURIComponent(headers.pem),
          this.settings.maxCertificateBytes,
          this.settings.maxChainDepth,
        );
      }
      const leaf = chain[0];
      if (
        !leaf ||
        leaf.ca ||
        !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
        !anchored(chain, anchors)
      )
        throw new Error('Invalid client certificate');
      ctx.signal?.throwIfAborted();
      ctx.authentication = { method: this.name, subject: leaf.fingerprint256 };
      // A fixed opaque identity avoids forwarding control characters or unbounded subject/SAN fields.
      ctx.req.headers['x-ssl-client-fingerprint'] = leaf.fingerprint256;
      const subject = leaf.subject.replace(/[\r\n]+/g, ', ');
      if (
        Buffer.byteLength(subject) <= this.settings.maxIdentityBytes &&
        [...subject].every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126,
        )
      )
        ctx.req.headers['x-ssl-client-subject'] = subject;
    } catch {
      return this.failure(
        ctx,
        403,
        'MTLS_CERT_INVALID',
        'A verified client certificate is required',
      );
    }
  }
  private assertions(ctx: PluginContext): { pem?: string; verify?: string } {
    const values = new Map<string, string[]>();
    // rawHeaders retains original assertions even after raw gRPC/WS handlers strip forwarding headers.
    for (let index = 0; index < (ctx.req.rawHeaders?.length ?? 0); index += 2) {
      const name = ctx.req.rawHeaders[index].toLowerCase();
      if (
        ![
          'ssl_client_cert',
          'x-ssl-client-cert',
          'ssl_client_verify',
          'x-ssl-client-verify',
        ].includes(name)
      )
        continue;
      const group = values.get(name) ?? [];
      group.push(ctx.req.rawHeaders[index + 1]);
      values.set(name, group);
    }
    const one = (names: string[]) => {
      const present = names.flatMap((name) => values.get(name) ?? []);
      if (
        present.length > 1 ||
        (present[0] &&
          Buffer.byteLength(present[0]) > this.settings.maxCertificateBytes)
      )
        throw new Error('Ambiguous or oversized certificate assertion');
      return present[0];
    };
    return {
      pem: one(['ssl_client_cert', 'x-ssl-client-cert']),
      verify: one(['ssl_client_verify', 'x-ssl-client-verify']),
    };
  }
  private failure(
    ctx: PluginContext,
    status: number,
    error: string,
    message: string,
  ): PluginShortCircuit {
    return {
      status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error, message, requestId: ctx.requestId }),
    };
  }
}
