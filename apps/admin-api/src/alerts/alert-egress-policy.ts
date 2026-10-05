import { BlockList, isIP } from 'node:net';

// IANA special-purpose registries: deny private, reserved and transition ranges.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const deniedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  deniedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  deniedV6.addSubnet(address, prefix, 'ipv6');

/** Conservative global unicast policy, including mapped IPv4 and transition ranges. */
export function isPublicAlertAddress(address: string): boolean {
  if (isIP(address) === 4) return !deniedV4.check(address, 'ipv4');
  if (isIP(address) !== 6) return false;
  return globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}
export function alertTrustedOrigins(input: unknown): ReadonlySet<string> {
  if (input === undefined) return new Set();
  try {
    if (typeof input !== 'string' || input.length > 4096) throw new Error();
    const origins: unknown = JSON.parse(input);
    if (!Array.isArray(origins) || origins.length > 16) throw new Error();
    const result = new Set<string>();
    for (const origin of origins) {
      if (typeof origin !== 'string') throw new Error();
      const url = new URL(origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== origin ||
        url.username ||
        url.password
      )
        throw new Error();
      result.add(origin);
    }
    return result;
  } catch {
    throw new Error('Invalid ALERT_HTTP_TRUSTED_ORIGINS.');
  }
}
