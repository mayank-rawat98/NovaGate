/**
 * Usage metering, quotas and plans (roadmap 6.4). Gateways keep cumulative
 * monthly counters in their own Redis and report the totals, so missed or
 * repeated reports never change the metered result.
 */

/** Calendar month in UTC, e.g. "202610". */
export type UsageMonth = string;
export const USAGE_MONTH_PATTERN = /^20\d{2}(0[1-9]|1[0-2])$/;
export const MAX_REPORTED_CONSUMERS = 1000;
export const MAX_CONSUMER_MONTHLY_QUOTA = 2_000_000_000;

export function usageMonth(time: Date): UsageMonth {
  return `${time.getUTCFullYear()}${String(time.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function previousUsageMonth(time: Date): UsageMonth {
  return usageMonth(
    new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth() - 1, 1)),
  );
}
/** First instant of the next UTC month: when monthly quotas reset. */
export function nextMonthStart(time: Date): Date {
  return new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1));
}

export interface MonthlyUsage {
  month: UsageMonth;
  /** Cumulative proxied requests counted by this source this month. */
  requests: number;
  /** Cumulative requests per identified consumer (bounded). */
  consumers: Array<{ consumerId: string; requests: number }>;
}
/** Gateway → control plane `usage.report` payload. */
export interface UsageReport {
  /** Stable per gateway Redis; gateways sharing Redis share a source. */
  source: string;
  months: MonthlyUsage[];
}

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Validates a gateway usage report; returns null when anything is off. */
export function parseUsageReport(value: unknown): UsageReport | null {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.source !== 'string' ||
    !UUID.test(input.source) ||
    !Array.isArray(input.months) ||
    input.months.length < 1 ||
    input.months.length > 2
  )
    return null;
  const months: MonthlyUsage[] = [];
  for (const entry of input.months) {
    const month = entry as Record<string, unknown>;
    if (
      !month ||
      typeof month.month !== 'string' ||
      !USAGE_MONTH_PATTERN.test(month.month) ||
      months.some((seen) => seen.month === month.month) ||
      !count(month.requests) ||
      !Array.isArray(month.consumers) ||
      month.consumers.length > MAX_REPORTED_CONSUMERS
    )
      return null;
    const consumers: MonthlyUsage['consumers'] = [];
    const ids = new Set<string>();
    for (const item of month.consumers) {
      const consumer = item as Record<string, unknown>;
      if (
        !consumer ||
        typeof consumer.consumerId !== 'string' ||
        !UUID.test(consumer.consumerId) ||
        ids.has(consumer.consumerId.toLowerCase()) ||
        !count(consumer.requests)
      )
        return null;
      ids.add(consumer.consumerId.toLowerCase());
      consumers.push({
        consumerId: consumer.consumerId.toLowerCase(),
        requests: consumer.requests as number,
      });
    }
    months.push({
      month: month.month,
      requests: month.requests as number,
      consumers,
    });
  }
  return { source: input.source.toLowerCase(), months };
}

/** Workspace suspension pushed to the gateway in TenantConfig. */
export interface TenantSuspension {
  reason: 'QUOTA_EXCEEDED';
  /** When the suspension lifts (the next monthly reset). */
  until: string;
}

export interface Plan {
  id: string;
  name: string;
  /** Null limits are unlimited. */
  requestsPerMonth: number | null;
  consumersMax: number | null;
  routesMax: number | null;
  logRetentionDays: number;
  priceMonthlyCents: number | null;
  /** True when a Stripe price is configured for self-service upgrade. */
  purchasable: boolean;
}

export interface UsageMeter {
  used: number;
  limit: number | null;
  /** Rounded down; null when unlimited. */
  percent: number | null;
}

export interface BillingOverview {
  plan: Plan;
  plans: Plan[];
  month: UsageMonth;
  resetsAt: string;
  requests: UsageMeter;
  consumers: UsageMeter;
  routes: UsageMeter;
  logRetentionDays: { configured: number; max: number };
  suspended: TenantSuspension | null;
  /** Plan limits are enforced on this installation (otherwise informational). */
  quotasEnforced: boolean;
  /** Stripe checkout is configured on this installation. */
  checkoutAvailable: boolean;
}

export interface ConsumerQuotaUsage {
  consumerId: string;
  name: string;
  month: UsageMonth;
  requests: number;
  monthlyQuota: number | null;
  percent: number | null;
}

export function usageMeter(used: number, limit: number | null): UsageMeter {
  return {
    used,
    limit,
    percent: limit === null ? null : Math.floor((used / limit) * 100),
  };
}
