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
});
