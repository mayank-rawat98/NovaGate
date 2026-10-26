import { outboundTrustedOrigins } from '../shared/outbound-egress-policy';
export { isPublicOutboundAddress as isPublicAlertAddress } from '../shared/outbound-egress-policy';
export function alertTrustedOrigins(input: unknown): ReadonlySet<string> {
  return outboundTrustedOrigins(input, 'ALERT_HTTP_TRUSTED_ORIGINS');
}
