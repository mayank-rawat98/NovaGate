export const LOG_REDACTED_FIELDS = [
  'path',
  'downstreamService',
  'requestId',
  'consumerId',
  'traceId',
  'spanId',
] as const;
export type LogRedactedField = (typeof LOG_REDACTED_FIELDS)[number];
/** Privacy applies only to request-log observations, never live request security inputs. */
export interface LogPrivacyPolicy {
  clientIp: 'omit' | 'retain';
  userAgent: 'omit' | 'retain';
  /** Missing/empty preserves the existing metadata policy. Never redact log identity/receipt. */
  redactedFields?: LogRedactedField[];
}
export interface LogPrivacyCoverage {
  revision: string;
  redactedFields: LogRedactedField[];
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
export const REDACTED_LOG_VALUE = '[redacted]';
export function validateLogPrivacy(value: unknown): LogPrivacyPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid log privacy policy');
  const input = value as Record<string, unknown>;
  if (
    ![2, 3].includes(Object.keys(input).length) ||
    Object.keys(input).some(
      (key) => !['clientIp', 'userAgent', 'redactedFields'].includes(key),
    ) ||
    !['omit', 'retain'].includes(input.clientIp as string) ||
    !['omit', 'retain'].includes(input.userAgent as string)
  )
    throw new Error('Choose omit or retain for each log field');
  let fields: LogRedactedField[] = [];
  if (Object.hasOwn(input, 'redactedFields')) {
    if (
      !Array.isArray(input.redactedFields) ||
      input.redactedFields.length > LOG_REDACTED_FIELDS.length ||
      input.redactedFields.some(
        (field) => !LOG_REDACTED_FIELDS.includes(field),
      ) ||
      new Set(input.redactedFields).size !== input.redactedFields.length
    )
      throw new Error('Choose supported log fields without duplicates');
    const selected = input.redactedFields;
    fields = LOG_REDACTED_FIELDS.filter((field) => selected.includes(field));
  }
  return {
    clientIp: input.clientIp as LogPrivacyPolicy['clientIp'],
    userAgent: input.userAgent as LogPrivacyPolicy['userAgent'],
    ...(fields.length ? { redactedFields: fields } : {}),
  };
}
/** Missing, legacy or malformed policies fail closed to conservative defaults. */
export function logPrivacyPolicy(value: unknown): LogPrivacyPolicy {
  try {
    return validateLogPrivacy(value);
  } catch {
    return {
      clientIp: 'omit',
      userAgent: 'omit',
      ...(value &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'redactedFields')
        ? { redactedFields: [...LOG_REDACTED_FIELDS] }
        : {}),
    };
  }
}
export function redactRequestLog<T extends object>(log: T, value: unknown): T {
  const policy = logPrivacyPolicy(value);
  const result = { ...log } as T & { clientIp?: unknown; userAgent?: unknown };
  if (policy.clientIp === 'omit') result.clientIp = REDACTED_CLIENT_IP;
  if (policy.userAgent === 'omit') delete result.userAgent;
  for (const field of policy.redactedFields ?? []) {
    if (field === 'path' || field === 'requestId')
      (result as Record<string, unknown>)[field] = REDACTED_LOG_VALUE;
    else delete (result as Record<string, unknown>)[field];
  }
  return result;
}
/** A request spanning config updates uses the stricter of its start and finish policies. */
export function stricterLogPrivacy(
  first: unknown,
  second: unknown,
): LogPrivacyPolicy {
  const a = logPrivacyPolicy(first),
    b = logPrivacyPolicy(second);
  const fields = LOG_REDACTED_FIELDS.filter(
    (field) =>
      a.redactedFields?.includes(field) || b.redactedFields?.includes(field),
  );
  return {
    clientIp:
      a.clientIp === 'omit' || b.clientIp === 'omit' ? 'omit' : 'retain',
    userAgent:
      a.userAgent === 'omit' || b.userAgent === 'omit' ? 'omit' : 'retain',
    ...(fields.length ? { redactedFields: fields } : {}),
  };
}
