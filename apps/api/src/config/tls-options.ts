import { readFileSync, statSync } from 'node:fs';
import type { ServerOptions } from 'node:https';
import {
  MAX_TENANT_CA_BUNDLE_BYTES,
  MAX_TENANT_CA_CERTIFICATES,
} from '@api-gateway/shared-types';
import { DEFAULT_TLS, type ListenerTlsSettings } from './configuration';
import { certificateBundle } from './certificate-trust';

export function listenerTlsOptions(
  settings: ListenerTlsSettings,
):
  | Pick<
      ServerOptions,
      | 'key'
      | 'cert'
      | 'ca'
      | 'crl'
      | 'requestCert'
      | 'rejectUnauthorized'
      | 'minVersion'
      | 'handshakeTimeout'
    >
  | undefined {
  if (!settings.certFile && !settings.keyFile) {
    if (settings.clientCaFile || settings.crlFile)
      throw new Error('Client trust requires listener TLS');
    return;
  }
  if (!settings.certFile || !settings.keyFile)
    throw new Error('Listener TLS requires certificate and private key');
  const read = (file: string) => {
    if (statSync(file).size > MAX_TENANT_CA_BUNDLE_BYTES)
      throw new Error('Listener TLS file too large');
    return readFileSync(file);
  };
  const cert = read(settings.certFile);
  certificateBundle(
    cert.toString('utf8'),
    MAX_TENANT_CA_BUNDLE_BYTES,
    MAX_TENANT_CA_CERTIFICATES,
  );
  const ca = settings.clientCaFile ? read(settings.clientCaFile) : undefined;
  if (ca)
    certificateBundle(
      ca.toString('utf8'),
      MAX_TENANT_CA_BUNDLE_BYTES,
      MAX_TENANT_CA_CERTIFICATES,
      true,
    );
  return {
    key: read(settings.keyFile),
    cert,
    ...(ca ? { ca } : {}),
    ...(settings.crlFile ? { crl: read(settings.crlFile) } : {}),
    requestCert: !!ca,
    // Route policy decides whether a client cert is required; anonymous health/public routes remain available.
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    handshakeTimeout:
      settings.handshakeTimeoutMs ?? DEFAULT_TLS.handshakeTimeoutMs,
  };
}
