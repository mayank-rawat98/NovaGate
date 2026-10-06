/** Privacy applies only to request-log observations, never live request security inputs. */
export interface LogPrivacyPolicy {
  clientIp: 'omit' | 'retain';
  userAgent: 'omit' | 'retain';
}
export interface LogPrivacyState {
  policy: LogPrivacyPolicy;
  revision: string;
  historicalCleanup: 'pending' | 'retrying' | 'complete';
  gatewayUpdatePending: boolean;
}
export interface SaveLogPrivacy {
  policy: LogPrivacyPolicy;
  expectedRevision: string;
}
export const REDACTED_CLIENT_IP = '[redacted]';
export function validateLogPrivacy(value: unknown): LogPrivacyPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid log privacy policy');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    Object.keys(input).some(
      (key) => key !== 'clientIp' && key !== 'userAgent',
    ) ||
    !['omit', 'retain'].includes(input.clientIp as string) ||
    !['omit', 'retain'].includes(input.userAgent as string)
  )
    throw new Error('Choose omit or retain for each log field');
  return {
    clientIp: input.clientIp as LogPrivacyPolicy['clientIp'],
    userAgent: input.userAgent as LogPrivacyPolicy['userAgent'],
  };
}
/** Missing, legacy or malformed policies fail closed to conservative defaults. */
export function logPrivacyPolicy(value: unknown): LogPrivacyPolicy {
  try {
    return validateLogPrivacy(value);
  } catch {
    return { clientIp: 'omit', userAgent: 'omit' };
  }
}
export function redactRequestLog<T extends object>(log: T, value: unknown): T {
  const policy = logPrivacyPolicy(value);
  const result = { ...log } as T & { clientIp?: unknown; userAgent?: unknown };
  if (policy.clientIp === 'omit') result.clientIp = REDACTED_CLIENT_IP;
  if (policy.userAgent === 'omit') delete result.userAgent;
  return result;
}
/** A request spanning config updates uses the stricter of its start and finish policies. */
export function stricterLogPrivacy(
  first: unknown,
  second: unknown,
): LogPrivacyPolicy {
  const a = logPrivacyPolicy(first),
    b = logPrivacyPolicy(second);
  return {
    clientIp:
      a.clientIp === 'omit' || b.clientIp === 'omit' ? 'omit' : 'retain',
    userAgent:
      a.userAgent === 'omit' || b.userAgent === 'omit' ? 'omit' : 'retain',
  };
}
