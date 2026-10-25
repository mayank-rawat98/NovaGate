import { parsePluginStatuses } from '@api-gateway/shared-types';

describe('gateway plugin report validation', () => {
  const plugin = {
    name: '@acme/stamp',
    package: '@acme/stamp',
    version: '1.2.3-rc.1',
    state: 'quarantined',
    protocols: ['http', 'http'],
    hooks: ['onRequest'],
    failures: 3,
    lastError: 'Error: onRequest exceeded 200 ms',
    quarantinedUntil: '2026-10-25T12:00:00.000Z',
  };

  it('keeps known fields and deduplicates lists', () => {
    expect(parsePluginStatuses([{ ...plugin, stack: 'secret' }])).toEqual([
      { ...plugin, protocols: ['http'] },
    ]);
    expect(parsePluginStatuses([])).toEqual([]);
  });

  it.each([
    ['a non-array', { plugins: [] }],
    [
      'too many entries',
      Array.from({ length: 17 }, (_, i) => ({ ...plugin, name: `@a/p${i}` })),
    ],
    ['a first-party name', [{ ...plugin, name: 'cors' }]],
    ['an unscoped package', [{ ...plugin, package: 'stamp' }]],
    ['duplicate names', [plugin, plugin]],
    ['a version range', [{ ...plugin, version: '^1.2.3' }]],
    ['an unknown state', [{ ...plugin, state: 'running' }]],
    ['an unknown protocol', [{ ...plugin, protocols: ['smtp'] }]],
    ['an unknown hook', [{ ...plugin, hooks: ['onBoot'] }]],
    ['negative failures', [{ ...plugin, failures: -1 }]],
    ['fractional failures', [{ ...plugin, failures: 1.5 }]],
    ['an oversized error', [{ ...plugin, lastError: 'x'.repeat(201) }]],
    ['an invalid date', [{ ...plugin, quarantinedUntil: 'tomorrow' }]],
    ['a null entry', [null]],
  ])('rejects %s', (_label, value) => {
    expect(parsePluginStatuses(value)).toBeNull();
  });
});
