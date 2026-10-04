import { Injectable, HttpStatus } from '@nestjs/common';
import type { ServiceTarget } from '@api-gateway/shared-types';
import { GatewayError } from '../shared/gateway-error';

@Injectable()
export class LoadBalancerService {
  private readonly counters = new Map<string, number>();
  selectTarget(
    serviceId: string,
    targets: ServiceTarget[],
    healthyUrls: Set<string>,
    unhealthyFallback = false,
  ): string {
    const healthy = targets.filter((target) => healthyUrls.has(target.url));
    const pool = healthy.length ? healthy : unhealthyFallback ? targets : [];
    if (!pool.length)
      throw new GatewayError(
        'NO_HEALTHY_TARGETS',
        'No healthy upstream targets are available',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    // Walk cumulative weights instead of allocating an expanded array per request.
    const weight = (target: ServiceTarget) =>
      Number.isSafeInteger(target.weight) &&
      target.weight >= 1 &&
      target.weight <= 100
        ? target.weight
        : 1;
    const total = pool.reduce((sum, target) => sum + weight(target), 0);
    const position = (this.counters.get(serviceId) ?? 0) % total;
    this.counters.set(serviceId, (position + 1) % total);
    let cumulative = 0;
    for (const target of pool) {
      cumulative += weight(target);
      if (position < cumulative) return target.url;
    }
    throw new GatewayError(
      'NO_HEALTHY_TARGETS',
      'No healthy upstream targets are available',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
