import {
  Injectable,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MAX_SERVICE_TARGET_URL_BYTES,
  MAX_SERVICE_TARGET_WEIGHT,
  type ServiceTarget,
  type ServiceConfig,
} from '@api-gateway/shared-types';
import { GatewayError } from '../shared/gateway-error';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import {
  DEFAULT_LOAD_BALANCER,
  type LoadBalancerSettings,
} from '../../config/configuration';

export interface TargetLease {
  url: string;
  release: () => void;
}
type Algorithm = NonNullable<ServiceConfig['loadBalancing']>;
interface TargetState {
  url: string;
  weight: number;
  active: number;
}
interface ServiceState {
  targets: Map<string, TargetState>;
  counter: number;
  signature: string;
}

/** Counts active upstream requests/streams/tunnels, per gateway replica.
 * Releases retain their original target object across configuration generations. */
@Injectable()
export class LoadBalancerService implements OnModuleInit, OnModuleDestroy {
  private readonly states = new Map<string, ServiceState>();
  private readonly settings: LoadBalancerSettings;
  private active = 0;
  private stopping = false;
  private tenantId: string | null = null;
  private unsubscribe?: () => void;
  constructor(
    config: ConfigService = new ConfigService(),
    @Optional() private readonly manager?: GatewayConfigManagerService,
  ) {
    this.settings = {
      ...DEFAULT_LOAD_BALANCER,
      ...config.get<LoadBalancerSettings>('loadBalancer'),
    };
  }
  get activeReservations(): number {
    return this.active;
  }
  get trackedServices(): number {
    return this.states.size;
  }
  onModuleInit(): void {
    this.tenantId = this.manager?.getTenantId() ?? null;
    this.unsubscribe = this.manager?.subscribeConfig?.(() =>
      this.reconcile(
        this.manager?.getConfig()?.services ?? [],
        this.manager?.getTenantId() ?? null,
      ),
    );
  }
  onModuleDestroy(): void {
    this.stopping = true;
    this.unsubscribe?.();
    this.states.clear();
  }
  reconcile(
    services: ServiceConfig[],
    tenantId: string | null = this.tenantId,
  ): void {
    if (tenantId !== this.tenantId) {
      this.states.clear();
      this.tenantId = tenantId;
    }
    const current = new Map(services.map((service) => [service.id, service]));
    for (const [id, state] of this.states) {
      const service = current.get(id);
      if (!service) this.states.delete(id);
      else
        this.synchronize(
          state,
          service.targets,
          service.loadBalancing ?? 'weighted-round-robin',
        );
    }
  }
  acquireTarget(
    serviceId: string,
    targets: ServiceTarget[],
    healthyUrls: Set<string>,
    unhealthyFallback = false,
    algorithm: Algorithm = 'weighted-round-robin',
  ): TargetLease {
    if (this.stopping || this.active >= this.settings.maxActiveReservations)
      this.capacity();
    const selected = this.choose(
      serviceId,
      targets,
      healthyUrls,
      unhealthyFallback,
      algorithm,
    );
    selected.active++;
    this.active++;
    let released = false;
    return {
      url: selected.url,
      release: () => {
        if (released) return;
        released = true;
        selected.active--;
        this.active--;
      },
    };
  }
  /** Compatibility selection without reserving work. Runtime dispatch uses acquireTarget. */
  selectTarget(
    serviceId: string,
    targets: ServiceTarget[],
    healthyUrls: Set<string>,
    unhealthyFallback = false,
    algorithm: Algorithm = 'weighted-round-robin',
  ): string {
    return this.choose(
      serviceId,
      targets,
      healthyUrls,
      unhealthyFallback,
      algorithm,
    ).url;
  }
  private choose(
    serviceId: string,
    targets: ServiceTarget[],
    healthyUrls: Set<string>,
    unhealthyFallback: boolean,
    algorithm: Algorithm,
  ): TargetState {
    if (this.stopping) this.capacity();
    const config = this.manager?.getConfig();
    if (config) {
      const tenant = this.manager?.getTenantId() ?? null;
      if (tenant !== this.tenantId) {
        this.states.clear();
        this.tenantId = tenant;
      }
      const service = config.services.find((item) => item.id === serviceId);
      if (!service)
        throw new GatewayError(
          'NO_HEALTHY_TARGETS',
          'Upstream configuration removed',
          503,
        );
      // Current topology is authoritative even if a policy hook awaited an older snapshot.
      targets = service.targets;
      algorithm = service.loadBalancing ?? 'weighted-round-robin';
      unhealthyFallback = service.unhealthyFallback === true;
    }
    let state = this.states.get(serviceId);
    if (!state) {
      if (this.states.size >= this.settings.maxServices) this.capacity();
      state = { targets: new Map(), counter: 0, signature: '' };
      this.synchronize(state, targets, algorithm);
      this.states.set(serviceId, state);
    } else this.synchronize(state, targets, algorithm);
    const healthy = [...state.targets.values()].filter((target) =>
      healthyUrls.has(target.url),
    );
    let pool = healthy.length
      ? healthy
      : unhealthyFallback
        ? [...state.targets.values()]
        : [];
    if (!pool.length)
      throw new GatewayError(
        'NO_HEALTHY_TARGETS',
        'No healthy upstream targets are available',
        503,
      );
    if (algorithm === 'least-connections') {
      const least = pool.reduce((best, target) =>
        target.active * best.weight < best.active * target.weight
          ? target
          : best,
      );
      pool = pool.filter(
        (target) =>
          target.active * least.weight === least.active * target.weight,
      );
    }
    const total = pool.reduce((sum, target) => sum + target.weight, 0);
    const position = state.counter % total;
    state.counter = (position + 1) % total;
    let cumulative = 0;
    for (const target of pool) {
      cumulative += target.weight;
      if (position < cumulative) return target;
    }
    throw new GatewayError(
      'BALANCER_CONFIG_INVALID',
      'Service balancing configuration is invalid',
      500,
    );
  }
  private synchronize(
    state: ServiceState,
    targets: ServiceTarget[],
    algorithm: Algorithm,
  ): void {
    if (
      !['weighted-round-robin', 'least-connections'].includes(algorithm) ||
      !Array.isArray(targets)
    )
      throw new GatewayError(
        'BALANCER_CONFIG_INVALID',
        'Service balancing configuration is invalid',
        500,
      );
    if (targets.length > this.settings.maxTargetsPerService) this.capacity();
    const canonical = new Set<string>();
    for (const target of targets) {
      try {
        const url = new URL(target.url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          Buffer.byteLength(target.url) > MAX_SERVICE_TARGET_URL_BYTES ||
          canonical.has(url.href) ||
          !Number.isSafeInteger(target.weight) ||
          target.weight < 1 ||
          target.weight > MAX_SERVICE_TARGET_WEIGHT
        )
          throw new Error();
        canonical.add(url.href);
      } catch {
        throw new GatewayError(
          'BALANCER_CONFIG_INVALID',
          'Service balancing configuration is invalid',
          500,
        );
      }
    }
    const signature = JSON.stringify([algorithm, targets]);
    if (state.signature === signature) return;
    const retained = new Map<string, TargetState>();
    for (const target of targets) {
      const item = state.targets.get(target.url) ?? { ...target, active: 0 };
      item.weight = target.weight;
      retained.set(target.url, item);
    }
    state.targets = retained;
    state.signature = signature;
    state.counter = 0;
  }
  private capacity(): never {
    throw new GatewayError(
      'BALANCER_CAPACITY_EXCEEDED',
      'Service balancing capacity is exhausted',
      503,
    );
  }
}
