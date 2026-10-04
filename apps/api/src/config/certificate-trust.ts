import { X509Certificate } from 'node:crypto';

/** Strict PEM parsing prevents silently trusting only the first certificate of malformed input. */
export function certificateBundle(
  pem: string,
  maxBytes: number,
  maxCount: number,
  caOnly = false,
): X509Certificate[] {
  if (typeof pem !== 'string' || !pem || Buffer.byteLength(pem) > maxBytes)
    throw new Error('Invalid certificate bundle');
  const pattern =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks = pem.match(pattern);
  if (
    !blocks?.length ||
    blocks.length > maxCount ||
    pem.replace(pattern, '').trim()
  )
    throw new Error('Invalid certificate bundle');
  const now = Date.now();
  return blocks.map((block) => {
    const cert = new X509Certificate(block);
    if (
      !Number.isFinite(Date.parse(cert.validFrom)) ||
      now < Date.parse(cert.validFrom) ||
      now >= Date.parse(cert.validTo) ||
      (caOnly && !cert.ca)
    )
      throw new Error('Invalid or expired certificate');
    return cert;
  });
}
/** OpenSSL/verified terminator handles path constraints; additionally bind it to current tenant trust. */
export function anchored(
  chain: X509Certificate[],
  anchors: X509Certificate[],
): boolean {
  for (let index = 0; index < chain.length; index++) {
    const cert = chain[index];
    if (index > 0 && !cert.ca) return false;
    if (
      anchors.some(
        (anchor) => cert.checkIssued(anchor) && cert.verify(anchor.publicKey),
      )
    )
      return true;
    const issuer = chain[index + 1];
    if (!issuer || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey))
      return false;
  }
  return false;
}
