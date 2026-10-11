import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { ExportDeliveryWorkerService } from './export-delivery-worker.service';

/** Bounded fair discovery. Public drafts have no schedule and are never dispatched. */
@Injectable()
export class ExportDeliverySchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExportDeliverySchedulerService.name);
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private readonly deliveries = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    private readonly store: ExportDeliveryStoreService,
    private readonly worker: ExportDeliveryWorkerService,
  ) {}
  onApplicationBootstrap() {
    if (!this.store.configurationAvailable || this.timer || this.stopping)
      return;
    this.timer = setInterval(() => this.startTick(), 2000);
    this.timer.unref();
    this.startTick();
  }
  private startTick() {
    void this.tick().catch(() =>
      this.logger.warn(
        'External receipt scheduling is temporarily unavailable.',
      ),
    );
  }
  async tick() {
    if (this.stopping || !this.store.configurationAvailable) return;
    if (this.work) return this.work;
    const work = this.runTick();
    this.work = work;
    try {
      await work;
    } finally {
      this.work = undefined;
    }
  }
  private async runTick() {
    await this.store.cleanup();
    const producers = await this.store.reserveProducerTargets();
    await Promise.all(
      producers.map(async (target) => {
        try {
          await this.store.produceNext(target.tenantId, target.destinationId);
        } catch {
          this.logger.warn(
            'An external receipt window will retry; continuing other destinations.',
          );
        }
      }),
    );
    if (this.stopping) return;
    const deliveries = await this.store.reserveDeliveryTargets(
      this.worker.availableCapacity,
      [...this.deliveries.keys()],
    );
    for (const target of deliveries) {
      if (this.stopping) break;
      // Provider latency must not occupy the discovery timer. Hold one owned
      // attempt per destination until the actual worker and socket settle.
      const attempt = this.worker
        .deliverNext(
          target.tenantId,
          target.destinationId,
          this.controller.signal,
          true,
        )
        .then(() => undefined)
        .catch(() => {
          this.logger.warn(
            'An external delivery attempt remains recoverable; continuing other destinations.',
          );
        })
        .finally(() => {
          this.deliveries.delete(target.destinationId);
        });
      this.deliveries.set(target.destinationId, attempt);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    this.controller.abort();
    try {
      await this.work;
    } finally {
      await Promise.allSettled([...this.deliveries.values()]);
    }
  }
}
