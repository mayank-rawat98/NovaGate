import type { SecureContextOptions } from 'node:tls';
import {
  MAX_TENANT_CA_BUNDLE_BYTES,
  MAX_TENANT_CA_CERTIFICATES,
} from '@api-gateway/shared-types';
import { certificateBundle } from '../../config/certificate-trust';

interface TrustSource {
  getConfig(): { caCertPem?: string } | null;
  subscribeConfig(listener: () => void): () => void;
}
/** Listener enablement and keys remain operator-owned; tenant CA rotations update client trust in place. */
export function bindTenantClientTrust(
  server: {
    setSecureContext(options: SecureContextOptions): void;
    once(event: 'close', listener: () => void): unknown;
  },
  options: SecureContextOptions & { requestCert?: boolean },
  source: TrustSource,
): () => void {
  if (!options.requestCert)
    return () => {
      /* No native client-certificate listener enabled. */
    };
  let initialized = false;
  let applied: string | undefined;
  const refresh = () => {
    const pem = source.getConfig()?.caCertPem;
    if (initialized && applied === pem) return;
    try {
      const ca = pem
        ? certificateBundle(
            pem,
            MAX_TENANT_CA_BUNDLE_BYTES,
            MAX_TENANT_CA_CERTIFICATES,
            true,
          ).map((cert) => cert.toString())
        : options.ca;
      server.setSecureContext({ ...options, ca });
      applied = pem;
      initialized = true;
    } catch {
      // Preserve transport context on invalid configuration. Required mTLS routes reject invalid tenant trust.
    }
  };
  const unsubscribe = source.subscribeConfig(refresh);
  server.once('close', unsubscribe);
  refresh();
  return unsubscribe;
}
