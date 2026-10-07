import { DataSource } from 'typeorm';
import { LogRetentionService } from './log-retention.service';
const ID = 'aabbccdd-1111-2222-3333-444455556666';
describe('Retention input, admission and shutdown', () => {
  it.each([
    null,
    [],
    {},
    { days: 0, expectedRevision: ID },
    { days: 91, expectedRevision: ID },
    { days: 1.5, expectedRevision: ID },
    { days: '30', expectedRevision: ID },
    { days: 30, expectedRevision: 'bad' },
    { days: 30, expectedRevision: ID, extra: true },
  ])('rejects malformed settings before SQL %#', (body) => {
    const transaction = jest.fn();
    const service = new LogRetentionService({
      transaction,
    } as unknown as DataSource);
    expect(() => service.save(ID, body)).toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('owns eight actual operations and drains them before shutting down', async () => {
    const completions: Array<(value: unknown) => void> = [];
    const transaction = jest.fn(
      () => new Promise((resolve) => completions.push(resolve)),
    );
    const service = new LogRetentionService({
      transaction,
    } as unknown as DataSource);
    const reads = Array.from({ length: 8 }, () => service.get(ID));
    await expect(service.get(ID)).rejects.toThrow('busy');
    let stopped = false;
    const stop = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(service.get(ID)).rejects.toThrow('busy');
    completions.forEach((resolve) => resolve({}));
    await Promise.all(reads);
    await stop;
    expect(stopped).toBe(true);
  });
});
