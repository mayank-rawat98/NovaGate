/**
 * Per-service circuit breaker (roadmap 6.2). The gateway keeps a sliding
 * window of completed upstream attempts per service. It opens the circuit when
 * the failure rate exceeds the threshold, refuses requests while open, then
 * lets one probe through at a time after the open period.
 */
export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Completed upstream attempts kept in the sliding window. */
  windowSize: number;
  /** Open when the window's failure rate is strictly above this percentage. */
  failureRatePercent: number;
  /** Fewest attempts in the window before the circuit may open. */
  minimumRequests: number;
  /** Time an open circuit refuses traffic before it probes. */
  openMs: number;
  /** Consecutive successful probes that close a half-open circuit. */
  halfOpenSuccesses: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  enabled: true,
  windowSize: 20,
  failureRatePercent: 50,
  minimumRequests: 5,
  openMs: 10000,
  halfOpenSuccesses: 2,
};

export const CIRCUIT_BREAKER_LIMITS = {
  windowSize: [5, 100],
  failureRatePercent: [1, 99],
  minimumRequests: [1, 100],
  openMs: [1000, 300000],
  halfOpenSuccesses: [1, 10],
} as const;

/**
 * Returns a validated copy of a stored breaker configuration, or null when it
 * is absent or invalid. Callers treat null as "no breaker", so a malformed
 * value never changes traffic.
 */
export function circuitBreakerConfig(
  value: unknown,
): CircuitBreakerConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') return null;
  const parsed = { enabled: input.enabled } as CircuitBreakerConfig;
  for (const [key, [min, max]] of Object.entries(CIRCUIT_BREAKER_LIMITS)) {
    const field = input[key];
    if (
      typeof field !== 'number' ||
      !Number.isSafeInteger(field) ||
      field < min ||
      field > max
    )
      return null;
    (parsed as unknown as Record<string, number>)[key] = field;
  }
  if (parsed.minimumRequests > parsed.windowSize) return null;
  return parsed;
}

export type CircuitState = 'closed' | 'open' | 'half-open';
export const CIRCUIT_STATES: readonly CircuitState[] = [
  'closed',
  'open',
  'half-open',
];
/** Services one gateway reports; matches the declarative entry bound. */
export const MAX_REPORTED_CIRCUITS = 200;

export interface ServiceCircuitStatus {
  serviceId: string;
  state: CircuitState;
  /** Attempts in the current window and how many of them failed. */
  requests: number;
  failures: number;
  /** When the state last changed. */
  changedAt: string;
  /** While open: when the next probe may run. */
  nextProbeAt: string | null;
}

/** Gateway → control plane snapshot of every service with a breaker. */
export interface CircuitStateReport {
  services: ServiceCircuitStatus[];
}

/** Admin view and live-stream frame. */
export interface CircuitBreakerSnapshot {
  reportedAt: string | null;
  services: ServiceCircuitStatus[];
}

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const timestamp = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 40 &&
  !Number.isNaN(Date.parse(value));

/**
 * Checks a gateway circuit report field by field and returns a copy holding
 * only known keys, or null when anything is out of bounds.
 */
export function parseCircuitStatuses(
  value: unknown,
): ServiceCircuitStatus[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_CIRCUITS)
    return null;
  const seen = new Set<string>();
  const parsed: ServiceCircuitStatus[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.serviceId !== 'string' ||
      !UUID.test(item.serviceId) ||
      seen.has(item.serviceId.toLowerCase()) ||
      !CIRCUIT_STATES.includes(item.state as CircuitState) ||
      !Number.isSafeInteger(item.requests) ||
      !Number.isSafeInteger(item.failures) ||
      (item.requests as number) < 0 ||
      (item.requests as number) > CIRCUIT_BREAKER_LIMITS.windowSize[1] ||
      (item.failures as number) < 0 ||
      (item.failures as number) > (item.requests as number) ||
      !timestamp(item.changedAt) ||
      !(item.nextProbeAt === null || timestamp(item.nextProbeAt))
    )
      return null;
    seen.add(item.serviceId.toLowerCase());
    parsed.push({
      serviceId: item.serviceId.toLowerCase(),
      state: item.state as CircuitState,
      requests: item.requests as number,
      failures: item.failures as number,
      changedAt: item.changedAt as string,
      nextProbeAt: item.nextProbeAt as string | null,
    });
  }
  return parsed;
}
