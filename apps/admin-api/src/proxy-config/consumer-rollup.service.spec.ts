import { DataSource } from 'typeorm';
import { ConsumerRollupService } from './consumer-rollup.service';

describe('Consumer rollup lifecycle ownership', () => {
  it('coalesces concurrent sweeps, drains actual transactions and refuses new work on shutdown', async () => {
    let finish: ((found: boolean) => void) | undefined;
    const transaction = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const service = new ConsumerRollupService({
      transaction,
    } as unknown as DataSource);
    const work = service.sweep();
    expect(service.sweep()).toBe(work);
    expect(transaction).toHaveBeenCalledTimes(1);
    let drained = false;
    const stop = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await service.sweep();
    expect(transaction).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Expected admitted transaction');
    finish(false);
    await work;
    await stop;
    expect(drained).toBe(true);
  });
});
