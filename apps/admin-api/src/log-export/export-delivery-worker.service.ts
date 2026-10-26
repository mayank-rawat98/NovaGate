import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { OutboundHttpError } from '../shared/outbound-http';
import {
  ExportTransportService,
  EXPORT_TRANSPORT_CAPACITY,
} from './export-transport.service';
import {
  ExportDeliveryStoreService,
  EXPORT_DELIVERY_MAX_ATTEMPTS,
} from './export-delivery-store.service';

export type ExportDeliveryAttemptResult =
  | 'delivered'
  | 'retrying'
  | 'failed'
  | 'revoked'
  | undefined;

/** One owned leased attempt. The receipt scheduler requests scheduled-only claims;
 * this provider has no bootstrap timer and cannot activate draft destinations. */
@Injectable()
export class ExportDeliveryWorkerService implements OnModuleDestroy {
  private readonly pending = new Map<
    Promise<ExportDeliveryAttemptResult>,
    AbortController
  >();
  private stopping = false;
  constructor(
    private readonly store: ExportDeliveryStoreService,
    private readonly transport: ExportTransportService,
  ) {}
  /** Admission remains occupied through claim, socket settlement, polling and finish. */
  get availableCapacity(): number {
    return this.stopping ? 0 : EXPORT_TRANSPORT_CAPACITY - this.pending.size;
  }
  async onModuleDestroy() {
    this.stopping = true;
    for (const controller of this.pending.values()) controller.abort();
    await Promise.allSettled([...this.pending.keys()]);
  }
  async deliverNext(
    tenantId: string,
    destinationId: string,
    signal: AbortSignal,
    scheduledOnly = false,
  ): Promise<ExportDeliveryAttemptResult> {
    if (this.stopping || signal.aborted)
      throw new OutboundHttpError('cancelled');
    if (this.pending.size >= EXPORT_TRANSPORT_CAPACITY)
      throw new OutboundHttpError('busy', true);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const work = Promise.resolve().then(
      async (): Promise<ExportDeliveryAttemptResult> => {
        const lease = await this.store.claim(
          tenantId,
          destinationId,
          scheduledOnly,
        );
        if (!lease) return undefined;
        let poll: Promise<void> | undefined;
        let timer: NodeJS.Timeout | undefined;
        const check = async () => {
          try {
            if (
              !(await this.store.leaseEligible(
                tenantId,
                lease.id,
                lease.leaseId,
              ))
            )
              controller.abort();
          } catch {
            controller.abort();
          }
        };
        let result:
          | { delivered: true }
          | { delivered: false; code: string; retryable: boolean };
        try {
          if (signal.aborted) cancel();
          await check();
          if (controller.signal.aborted)
            throw new OutboundHttpError('cancelled', true);
          timer = setInterval(() => {
            if (!poll)
              poll = check().finally(() => {
                poll = undefined;
              });
          }, 1000);
          timer.unref();
          await this.transport.deliver(
            lease.credentials,
            lease.batch,
            controller.signal,
          );
          result = { delivered: true };
        } catch (error) {
          result = {
            delivered: false,
            code:
              error instanceof OutboundHttpError
                ? error.code
                : 'delivery_failed',
            retryable:
              controller.signal.aborted ||
              (error instanceof OutboundHttpError && error.retryable),
          };
        } finally {
          clearInterval(timer);
          await poll;
        }
        if (
          !(await this.store.finish(tenantId, lease.id, lease.leaseId, result))
        )
          return 'revoked';
        if (result.delivered) return 'delivered';
        return result.retryable && lease.attempts < EXPORT_DELIVERY_MAX_ATTEMPTS
          ? 'retrying'
          : 'failed';
      },
    );
    this.pending.set(work, controller);
    try {
      return await work;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.pending.delete(work);
    }
  }
}
