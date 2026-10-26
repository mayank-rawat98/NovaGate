import { ConfigService } from '@nestjs/config';
import type { ServiceConfig } from '@api-gateway/shared-types';
import { LoadBalancerService } from './load-balancer.service';

describe('weighted health-aware selection', () => {
  const targets = [
    { url: 'http://one', weight: 2 },
    { url: 'http://two', weight: 1 },
  ];
  it('honors weights while removing failed peers', () => {
    const balancer = new LoadBalancerService();
    expect(
      Array.from({ length: 6 }, () =>
        balancer.selectTarget(
          'svc',
          targets,
          new Set(targets.map((t) => t.url)),
        ),
      ),
    ).toEqual([
      'http://one',
      'http://one',
      'http://two',
      'http://one',
      'http://one',
      'http://two',
    ]);
    expect(balancer.selectTarget('svc', targets, new Set(['http://two']))).toBe(
      'http://two',
    );
  });
  it('fails closed by default and permits explicit fail-open only with configured targets', () => {
    const balancer = new LoadBalancerService();
    expect(() => balancer.selectTarget('svc', targets, new Set())).toThrow(
      expect.objectContaining({ code: 'NO_HEALTHY_TARGETS', status: 503 }),
    );
    expect(balancer.selectTarget('svc', targets, new Set(), true)).toBe(
      'http://one',
    );
    expect(() => balancer.selectTarget('svc', [], new Set(), true)).toThrow();
  });
  const healthy = new Set(targets.map((target) => target.url));
  const service = (): ServiceConfig => ({
    id: 'svc',
    name: 'service',
    targets,
    healthCheckPath: '/health',
    timeoutMs: 1000,
    loadBalancing: 'least-connections',
  });
  it('selects the least active work per weight and distributes equally loaded peers', () => {
    const balancer = new LoadBalancerService();
    const leases = Array.from({ length: 6 }, () =>
      balancer.acquireTarget(
        'svc',
        targets,
        healthy,
        false,
        'least-connections',
      ),
    );
    expect(leases.filter((lease) => lease.url === 'http://one')).toHaveLength(
      4,
    );
    expect(leases.filter((lease) => lease.url === 'http://two')).toHaveLength(
      2,
    );
    expect(balancer.activeReservations).toBe(6);
    for (const lease of leases) {
      lease.release();
      lease.release();
    }
    expect(balancer.activeReservations).toBe(0);
  });
  it('moves traffic away from a busy peer and restores it after release', () => {
    const balancer = new LoadBalancerService();
    const first = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    expect(first.url).toBe('http://one');
    const second = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    expect(second.url).toBe('http://two');
    first.release();
    expect(
      balancer.acquireTarget(
        'svc',
        targets,
        healthy,
        false,
        'least-connections',
      ).url,
    ).toBe('http://one');
    second.release();
  });
  it('does not let a removed generation release decrement new reservations', () => {
    const balancer = new LoadBalancerService();
    const old = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    balancer.reconcile([]);
    expect(balancer.trackedServices).toBe(0);
    const current = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    old.release();
    expect(balancer.activeReservations).toBe(1);
    expect(
      balancer.acquireTarget(
        'svc',
        targets,
        healthy,
        false,
        'least-connections',
      ).url,
    ).toBe('http://two');
    current.release();
  });
  it('retains active work for unchanged targets when weights change', () => {
    const balancer = new LoadBalancerService();
    const old = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    const changed = [{ url: 'http://one', weight: 1 }, targets[1]];
    balancer.reconcile([{ ...service(), targets: changed }]);
    expect(
      balancer.acquireTarget(
        'svc',
        changed,
        healthy,
        false,
        'least-connections',
      ).url,
    ).toBe('http://two');
    old.release();
  });
  it('bounds services, targets and live reservations without silently evicting active work', () => {
    const balancer = new LoadBalancerService(
      new ConfigService({
        loadBalancer: {
          maxServices: 1,
          maxTargetsPerService: 2,
          maxActiveReservations: 1,
        },
      }),
    );
    const first = balancer.acquireTarget('svc', targets, healthy);
    expect(() => balancer.acquireTarget('svc', targets, healthy)).toThrow(
      expect.objectContaining({
        code: 'BALANCER_CAPACITY_EXCEEDED',
        status: 503,
      }),
    );
    first.release();
    expect(() => balancer.selectTarget('other', targets, healthy)).toThrow(
      expect.objectContaining({ code: 'BALANCER_CAPACITY_EXCEEDED' }),
    );
    balancer.reconcile([]);
    expect(balancer.selectTarget('other', targets, healthy)).toBe('http://one');
    const tight = new LoadBalancerService(
      new ConfigService({ loadBalancer: { maxTargetsPerService: 1 } }),
    );
    expect(() => tight.acquireTarget('svc', targets, healthy)).toThrow(
      expect.objectContaining({ status: 503 }),
    );
    expect(tight.trackedServices).toBe(0);
  });
  it('isolates new tenant generations while retaining capacity for old outstanding work', () => {
    const balancer = new LoadBalancerService();
    const old = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    balancer.reconcile([service()], 'another-tenant');
    const current = balancer.acquireTarget(
      'svc',
      targets,
      healthy,
      false,
      'least-connections',
    );
    old.release();
    expect(balancer.activeReservations).toBe(1);
    expect(
      balancer.acquireTarget(
        'svc',
        targets,
        healthy,
        false,
        'least-connections',
      ).url,
    ).toBe('http://two');
    current.release();
  });
  it.each([
    [{ url: 'http://one', weight: 1.5 }],
    [{ url: 'http://one', weight: 0 }],
    [{ url: 'ftp://one', weight: 1 }],
    [{ url: 'http://secret:password@one', weight: 1 }],
    [
      { url: 'http://one', weight: 1 },
      { url: 'http://one/', weight: 2 },
    ],
  ])('rejects malformed targets without creating state', (...invalid) => {
    const balancer = new LoadBalancerService();
    expect(() => balancer.acquireTarget('svc', invalid, new Set())).toThrow(
      expect.objectContaining({ code: 'BALANCER_CONFIG_INVALID', status: 500 }),
    );
    expect(balancer.trackedServices).toBe(0);
  });
  it('stops selection during shutdown while late releases remain safe', () => {
    const balancer = new LoadBalancerService();
    const lease = balancer.acquireTarget('svc', targets, healthy);
    balancer.onModuleDestroy();
    expect(() => balancer.acquireTarget('svc', targets, healthy)).toThrow(
      expect.objectContaining({ status: 503 }),
    );
    lease.release();
    lease.release();
    expect(balancer.activeReservations).toBe(0);
  });
});
