import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';
const ID = 'aabbccdd-1111-2222-3333-444455556666';
const RULE = {
  name: ' High error rate ',
  metric: 'error_rate',
  operator: '>',
  threshold: 0.1,
  windowMinutes: 1,
  channelIds: [ID.toUpperCase()],
};
describe('Alert rule configuration boundaries', () => {
  const rules = new AlertRulesService({} as DataSource, new ConfigService());
  it('normalizes names and channel IDs with metric-specific request defaults', () => {
    expect(rules.normalizeRule(RULE)).toEqual({
      ...RULE,
      name: 'High error rate',
      channelIds: [ID],
      minRequests: 1,
      enabled: true,
    });
    expect(
      rules.normalizeRule({ ...RULE, metric: 'rps', channelIds: [] }),
    ).toMatchObject({ minRequests: 0, channelIds: [] });
    expect(
      rules.normalizeRule({ ...RULE, enabled: false, minRequests: 20 }),
    ).toMatchObject({ enabled: false, minRequests: 20 });
  });
  it.each(
    [
      null,
      [],
      {},
      { ...RULE, tenantId: ID },
      { ...RULE, name: ' ' },
      { ...RULE, name: 'x'.repeat(101) },
      { ...RULE, name: 'line\ncontrol' },
      { ...RULE, metric: 'untrusted_expression' },
      { ...RULE, operator: '!=' },
      { ...RULE, threshold: NaN },
      { ...RULE, threshold: Infinity },
      { ...RULE, threshold: -1 },
      { ...RULE, threshold: '0.1' },
      { ...RULE, threshold: 1.01 },
      { ...RULE, metric: 'rps', threshold: 1000000001 },
      { ...RULE, metric: 'p95_latency_ms', threshold: 3600001 },
      { ...RULE, metric: 'downstream_timeout_rate', threshold: 1.01 },
      { ...RULE, windowMinutes: 0 },
      { ...RULE, windowMinutes: 1.5 },
      { ...RULE, windowMinutes: 61 },
      { ...RULE, windowMinutes: '1' },
      { ...RULE, minRequests: -1 },
      { ...RULE, minRequests: Infinity },
      { ...RULE, minRequests: 1.5 },
      { ...RULE, minRequests: 1000001 },
      { ...RULE, enabled: 'true' },
      { ...RULE, channelIds: null },
      { ...RULE, channelIds: ['not-an-id'] },
      { ...RULE, channelIds: [ID, ID.toUpperCase()] },
      { ...RULE, channelIds: Array(6).fill(ID) },
    ].map((input) => [input]),
  )('rejects unsupported or unsafe configuration %j', (input) => {
    expect(() => rules.normalizeRule(input)).toThrow(BadRequestException);
  });
  it('accepts legitimate metric/operator boundaries without changing the caller input', () => {
    for (const operator of ['>', '<', '>=', '<=']) {
      expect(
        rules.normalizeRule({
          ...RULE,
          metric: 'p95_latency_ms',
          threshold: 3600000,
          windowMinutes: 60,
          operator,
        }).operator,
      ).toBe(operator);
    }
    expect(RULE.name).toBe(' High error rate ');
    expect(RULE.channelIds[0]).toBe(ID.toUpperCase());
  });
});

describe('Alert storage admission and lifecycle', () => {
  it('bounds actual transactions and waits for outstanding work when stopping', async () => {
    const releases: Array<(value: unknown[]) => void> = [];
    const transaction = jest.fn(
      () => new Promise<unknown[]>((resolve) => releases.push(resolve)),
    );
    const service = new AlertRulesService(
      { transaction } as unknown as DataSource,
      new ConfigService(),
    );
    const jobs = Array.from({ length: 32 }, () => service.listChannels(ID));
    await expect(service.listChannels(ID)).rejects.toThrow('storage is busy');
    await Promise.resolve();
    expect(transaction).toHaveBeenCalledTimes(32);
    let stopped = false;
    const shutdown = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(service.listChannels(ID)).rejects.toThrow('storage is busy');
    releases.forEach((resolve) => resolve([]));
    await Promise.all(jobs);
    await shutdown;
    expect(stopped).toBe(true);
  });
  it('releases admission after database failure without hiding the error', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue(new Error('database deadline'));
    const service = new AlertRulesService(
      { transaction } as unknown as DataSource,
      new ConfigService(),
    );
    for (let i = 0; i < 33; i++)
      await expect(service.listChannels(ID)).rejects.toThrow(
        'database deadline',
      );
    expect(transaction).toHaveBeenCalledTimes(33);
    await service.onModuleDestroy();
  });
});
