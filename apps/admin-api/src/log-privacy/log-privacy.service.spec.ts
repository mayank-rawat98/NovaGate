import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';
import { LogPrivacyService } from './log-privacy.service';
const ID = 'aabbccdd-1111-2222-3333-444455556666';
describe('Privacy operations admission and shutdown', () => {
  it('owns admitted operations until actual completion and rejects writes during shutdown', async () => {
    const completions: Array<(value: unknown) => void> = [];
    const transaction = jest.fn(
      () => new Promise((resolve) => completions.push(resolve)),
    );
    const service = new LogPrivacyService(
      { transaction } as unknown as DataSource,
      {} as ConfigPushService,
    );
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
  it.each([
    null,
    [],
    {},
    {
      policy: { clientIp: 'omit', userAgent: 'omit' },
      expectedRevision: 'invalid',
    },
    {
      policy: { clientIp: 'retain', userAgent: 'retain', extra: true },
      expectedRevision: ID,
    },
  ])('rejects malformed mutation before admitting SQL: %#', (body) => {
    const transaction = jest.fn();
    const service = new LogPrivacyService(
      { transaction } as unknown as DataSource,
      {} as ConfigPushService,
    );
    expect(() => service.save(ID, body)).toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});
