import {
  DEFAULT_CIRCUIT_BREAKER,
  type ServiceConfig,
  type TenantConfig,
} from '@api-gateway/shared-types';
import {
  CircuitBreakerService,
  outcomeForStatus,
  type CircuitAdmission,
} from './circuit-breaker.service';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('CircuitBreakerService', () => {
  let config: TenantConfig;
  let listener: () => void = () => undefined;
  let clock = 1_000_000;
  let breaker: CircuitBreakerService;

  const service = (
    id: string,
    circuitBreaker: ServiceConfig['circuitBreaker'],
  ): ServiceConfig => ({
    id,
    name: id,
    targets: [{ url: 'http://127.0.0.1:1', weight: 1 }],
    healthCheckPath: '/health',
    timeoutMs: 1000,
    circuitBreaker,
  });
  const setServices = (services: ServiceConfig[]) => {
    config = { routes: [], services, consumers: [] } as unknown as TenantConfig;
    listener();
  };
  const attempt = (status: number) => {
    const admission = breaker.admit(ID);
    expect(admission.allowed).toBe(true);
    (admission as CircuitAdmission).record(status);
  };

  beforeEach(() => {
    clock = 1_000_000;
    config = {
      routes: [],
      services: [service(ID, DEFAULT_CIRCUIT_BREAKER)],
      consumers: [],
    } as unknown as TenantConfig;
    breaker = new CircuitBreakerService({
      getConfig: () => config,
      subscribeConfig: (next: () => void) => {
        listener = next;
        return () => undefined;
      },
    } as never);
    breaker.now = () => clock;
    breaker.onModuleInit();
  });

  it('classifies upstream statuses', () => {
    expect(outcomeForStatus(200)).toBe('success');
    expect(outcomeForStatus(404)).toBe('success');
    expect(outcomeForStatus(499)).toBe('neutral');
    expect(outcomeForStatus(500)).toBe('failure');
    expect(outcomeForStatus(504)).toBe('failure');
  });

  it('opens above the failure rate once the minimum is reached', () => {
    // 4 failures out of 4: below the 5-request minimum.
    for (let i = 0; i < 4; i++) attempt(502);
    expect(breaker.stateOf(ID)).toBe('closed');
    // 3 of 5 = 60% > 50%.
    const fresh = () => {
      setServices([service(ID, { ...DEFAULT_CIRCUIT_BREAKER, openMs: 1000 })]);
    };
    fresh();
    for (const status of [200, 502, 200, 502, 503]) attempt(status);
    expect(breaker.stateOf(ID)).toBe('open');
    const rejected = breaker.admit(ID);
    expect(rejected).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('does not open at exactly the threshold', () => {
    for (let i = 0; i < 10; i++) attempt(200);
    for (let i = 0; i < 10; i++) attempt(500);
    expect(breaker.stateOf(ID)).toBe('closed');
    // The window slides: an old success drops out, 11/20 = 55% opens it.
    attempt(500);
    expect(breaker.stateOf(ID)).toBe('open');
  });

  it('ignores neutral outcomes and late results from before a transition', () => {
    const late = breaker.admit(ID) as CircuitAdmission;
    for (let i = 0; i < 5; i++) attempt(499);
    expect(breaker.statuses()[0].requests).toBe(0);
    for (let i = 0; i < 5; i++) attempt(502);
    expect(breaker.stateOf(ID)).toBe('open');
    late.record(200);
    expect(breaker.stateOf(ID)).toBe('open');
    // A settled admission cannot be recorded twice.
    late.record(502);
    expect(breaker.statuses()[0].failures).toBe(5);
  });

  it('probes one request at a time and closes after consecutive successes', () => {
    for (let i = 0; i < 5; i++) attempt(502);
    expect(breaker.admit(ID).allowed).toBe(false);
    expect(breaker.statuses()[0].nextProbeAt).toBe(
      new Date(clock + 10000).toISOString(),
    );
    clock += 10000;
    const probe = breaker.admit(ID) as CircuitAdmission;
    expect(probe.allowed).toBe(true);
    expect(breaker.stateOf(ID)).toBe('half-open');
    expect(breaker.admit(ID)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    probe.record(200);
    // Still half-open after one success; the next probe may run at once.
    expect(breaker.stateOf(ID)).toBe('half-open');
    (breaker.admit(ID) as CircuitAdmission).record(204);
    expect(breaker.stateOf(ID)).toBe('closed');
    expect(breaker.statuses()[0]).toMatchObject({ requests: 0, failures: 0 });
  });

  it('reopens on a failed probe and frees the slot on a cancelled one', () => {
    for (let i = 0; i < 5; i++) attempt(504);
    clock += 10000;
    (breaker.admit(ID) as CircuitAdmission).settle('neutral');
    expect(breaker.stateOf(ID)).toBe('half-open');
    (breaker.admit(ID) as CircuitAdmission).record(503);
    expect(breaker.stateOf(ID)).toBe('open');
    expect(breaker.admit(ID)).toEqual({
      allowed: false,
      retryAfterSeconds: 10,
    });
  });

  it('recovers from a probe that never settles', () => {
    for (let i = 0; i < 5; i++) attempt(502);
    clock += 10000;
    breaker.admit(ID); // never settled
    clock += 29999;
    expect(breaker.admit(ID).allowed).toBe(false);
    clock += 1;
    expect(breaker.admit(ID).allowed).toBe(true);
  });

  it('follows configuration: disabled, removed, changed and absent breakers', () => {
    const changes = jest.fn();
    breaker.onChange(changes);
    for (let i = 0; i < 5; i++) attempt(502);
    expect(changes).toHaveBeenCalledTimes(1);
    // Unchanged settings keep the open circuit.
    setServices([service(ID, { ...DEFAULT_CIRCUIT_BREAKER })]);
    expect(breaker.stateOf(ID)).toBe('open');
    // Changed settings reset it.
    setServices([service(ID, { ...DEFAULT_CIRCUIT_BREAKER, windowSize: 30 })]);
    expect(breaker.stateOf(ID)).toBe('closed');
    setServices([
      service(ID, { ...DEFAULT_CIRCUIT_BREAKER, enabled: false }),
      service(OTHER, null),
    ]);
    expect(breaker.statuses()).toEqual([]);
    for (let i = 0; i < 10; i++) attempt(502);
    expect(breaker.admit(OTHER).allowed).toBe(true);
    // An invalid stored value never trips anything.
    setServices([
      service(ID, { ...DEFAULT_CIRCUIT_BREAKER, minimumRequests: 50 }),
    ]);
    expect(breaker.statuses()).toEqual([]);
  });
});
