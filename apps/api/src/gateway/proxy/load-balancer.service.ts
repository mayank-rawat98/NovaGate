import { Injectable } from '@nestjs/common';
import type { ServiceTarget } from '@api-gateway/shared-types';

@Injectable()
export class LoadBalancerService {
  private readonly counters = new Map<string, number>();

  selectTarget(
    serviceId: string,
    targets: ServiceTarget[],
    healthyUrls: Set<string>,
  ): string {
    if (targets.length === 0) {
      throw new Error('No targets configured for service');
    }
    // Use healthy targets when available; fall back to all targets if all are unhealthy
    const candidates =
      healthyUrls.size > 0
        ? targets.filter((t) => healthyUrls.has(t.url))
        : targets;
    const pool = candidates.length > 0 ? candidates : targets;

    // Expand pool by weight for weighted round-robin
    const expanded: string[] = [];
    for (const t of pool) {
      const w = t.weight > 0 ? t.weight : 1;
      for (let i = 0; i < w; i++) {
        expanded.push(t.url);
      }
    }

    if (expanded.length === 0) {
      throw new Error('No targets available for load balancing');
    }

    const count = this.counters.get(serviceId) ?? 0;
    const selected = expanded[count % expanded.length];
    this.counters.set(serviceId, count + 1);
    return selected;
  }
}
