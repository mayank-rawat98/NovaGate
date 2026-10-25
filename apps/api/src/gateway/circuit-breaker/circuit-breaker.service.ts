import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  circuitBreakerConfig,
  type CircuitBreakerConfig,
  type CircuitState,
  type ServiceCircuitStatus,
} from '@api-gateway/shared-types';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

export type AttemptOutcome = 'success' | 'failure' | 'neutral';

/**
 * Upstream classification shared by every protocol: 5xx, timeouts and
 * connection failures (reported as 502/504) count against the service; caller
 * cancellation (499) says nothing about it; anything else is a success.
 */
export function outcomeForStatus(status: number): AttemptOutcome {
  if (status === 499) return 'neutral';
  return status >= 500 ? 'failure' : 'success';
}

/** One upstream attempt. Settles once; later calls are ignored. */
export interface CircuitAdmission {
  readonly allowed: true;
  record(status: number): void;
  settle(outcome: AttemptOutcome): void;
}
export interface CircuitRejection {
  readonly allowed: false;
  /** Whole seconds until the next probe may run (at least 1). */
  readonly retryAfterSeconds: number;
}

interface Circuit {
  config: CircuitBreakerConfig;
  key: string;
  state: CircuitState;
  /** Ring of recent outcomes; true marks a failure. */
  window: boolean[];
  next: number;
  failures: number;
  changedAt: number;
  openedAt: number;
  successes: number;
  /** Token of the in-flight half-open probe, if any. */
  probe: number | null;
  probeStartedAt: number;
  /** Bumped on every transition so late results from older admissions are ignored. */
  epoch: number;
}

const PASS: CircuitAdmission = {
  allowed: true,
  record: () => undefined,
  settle: () => undefined,
};

/**
 * Per-service circuit breaker (roadmap 6.2). State is in memory per gateway
 * process: a sliding window of completed upstream attempts, an open period
 * that refuses traffic, then sequential half-open probes.
 */
@Injectable()
export class CircuitBreakerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, Circuit>();
  private readonly listeners = new Set<() => void>();
  private nextProbe = 1;
  private unsubscribe?: () => void;
  /** Clock; replaced in tests. */
  now: () => number = Date.now;

  constructor(private readonly configManager: GatewayConfigManagerService) {}

  onModuleInit() {
    this.unsubscribe = this.configManager.subscribeConfig(() =>
      this.reconcile(),
    );
    this.reconcile();
  }
  onModuleDestroy() {
    this.unsubscribe?.();
    this.listeners.clear();
  }

  /** Called on every state transition or reset. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Tracks exactly the enabled breakers of the current configuration. A
   * changed setting resets that service's circuit to closed.
   */
  reconcile() {
    const wanted = new Map<string, CircuitBreakerConfig>();
    for (const service of this.configManager.getConfig()?.services ?? []) {
      const config = circuitBreakerConfig(service.circuitBreaker);
      if (config?.enabled) wanted.set(service.id, config);
    }
    let changed = false;
    for (const id of this.circuits.keys())
      if (!wanted.has(id)) {
        this.circuits.delete(id);
        changed = true;
      }
    for (const [id, config] of wanted) {
      const key = JSON.stringify(config);
      const current = this.circuits.get(id);
      if (current?.key === key) continue;
      this.circuits.set(id, this.fresh(config, key, current?.epoch ?? 0));
      changed = true;
    }
    if (changed) this.notify();
  }

  admit(serviceId: string): CircuitAdmission | CircuitRejection {
    const circuit = this.circuits.get(serviceId);
    if (!circuit) return PASS;
    const now = this.now();
    if (circuit.state === 'open') {
      const reopensAt = circuit.openedAt + circuit.config.openMs;
      if (now < reopensAt)
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((reopensAt - now) / 1000)),
        };
      this.transition(circuit, 'half-open', now);
    }
    if (circuit.state === 'half-open') {
      // A probe that never settled (for example a hung connection) must not
      // pin the circuit open forever.
      if (
        circuit.probe !== null &&
        now - circuit.probeStartedAt < circuit.config.openMs * 3
      )
        return { allowed: false, retryAfterSeconds: 1 };
      const token = this.nextProbe++;
      circuit.probe = token;
      circuit.probeStartedAt = now;
      return this.admission(serviceId, circuit.epoch, token);
    }
    return this.admission(serviceId, circuit.epoch, null);
  }

  statuses(): ServiceCircuitStatus[] {
    return [...this.circuits].map(([serviceId, circuit]) => ({
      serviceId,
      state: circuit.state,
      requests: Math.min(circuit.window.length, circuit.config.windowSize),
      failures: circuit.failures,
      changedAt: new Date(circuit.changedAt).toISOString(),
      nextProbeAt:
        circuit.state === 'open'
          ? new Date(circuit.openedAt + circuit.config.openMs).toISOString()
          : null,
    }));
  }

  stateOf(serviceId: string): CircuitState | null {
    return this.circuits.get(serviceId)?.state ?? null;
  }

  private admission(
    serviceId: string,
    epoch: number,
    probe: number | null,
  ): CircuitAdmission {
    let settled = false;
    const settle = (outcome: AttemptOutcome) => {
      if (settled) return;
      settled = true;
      const circuit = this.circuits.get(serviceId);
      if (!circuit || circuit.epoch !== epoch) return;
      this.apply(circuit, outcome, probe);
    };
    return {
      allowed: true,
      record: (status) => settle(outcomeForStatus(status)),
      settle,
    };
  }

  private apply(
    circuit: Circuit,
    outcome: AttemptOutcome,
    probe: number | null,
  ) {
    const now = this.now();
    if (circuit.state === 'half-open') {
      // Only the current probe decides; it is released either way.
      if (probe === null || circuit.probe !== probe) return;
      circuit.probe = null;
      if (outcome === 'neutral') return;
      if (outcome === 'failure') return this.open(circuit, now);
      circuit.successes++;
      if (circuit.successes >= circuit.config.halfOpenSuccesses)
        this.transition(circuit, 'closed', now);
      return;
    }
    if (circuit.state !== 'closed' || outcome === 'neutral') return;
    const failed = outcome === 'failure';
    const size = circuit.config.windowSize;
    if (circuit.window.length < size) circuit.window.push(failed);
    else {
      if (circuit.window[circuit.next]) circuit.failures--;
      circuit.window[circuit.next] = failed;
      circuit.next = (circuit.next + 1) % size;
    }
    if (failed) circuit.failures++;
    const requests = circuit.window.length;
    if (
      requests >= circuit.config.minimumRequests &&
      circuit.failures * 100 > circuit.config.failureRatePercent * requests
    )
      this.open(circuit, now);
  }

  private open(circuit: Circuit, now: number) {
    circuit.openedAt = now;
    this.transition(circuit, 'open', now);
  }

  private transition(circuit: Circuit, state: CircuitState, now: number) {
    const previous = circuit.state;
    circuit.state = state;
    circuit.changedAt = now;
    circuit.epoch++;
    circuit.probe = null;
    circuit.successes = 0;
    if (state === 'closed') {
      circuit.window = [];
      circuit.next = 0;
      circuit.failures = 0;
    }
    this.logger.log(
      JSON.stringify({
        msg: 'Circuit breaker state changed',
        from: previous,
        to: state,
        requests: circuit.window.length,
        failures: circuit.failures,
      }),
    );
    this.notify();
  }

  private fresh(
    config: CircuitBreakerConfig,
    key: string,
    epoch: number,
  ): Circuit {
    return {
      config,
      key,
      state: 'closed',
      window: [],
      next: 0,
      failures: 0,
      changedAt: this.now(),
      openedAt: 0,
      successes: 0,
      probe: null,
      probeStartedAt: 0,
      epoch: epoch + 1,
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        this.logger.warn('A circuit breaker listener failed');
      }
    }
  }
}
