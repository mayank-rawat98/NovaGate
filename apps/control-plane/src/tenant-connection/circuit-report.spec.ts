import { parseCircuitStatuses } from '@api-gateway/shared-types';

describe('gateway circuit report validation', () => {
  const status = {
    serviceId: 'AAAAAAAA-1111-4111-8111-111111111111',
    state: 'open',
    requests: 5,
    failures: 3,
    changedAt: '2026-10-25T12:00:00.000Z',
    nextProbeAt: '2026-10-25T12:00:10.000Z',
  };

  it('keeps known fields and normalizes service IDs', () => {
    expect(parseCircuitStatuses([{ ...status, extra: 1 }])).toEqual([
      { ...status, serviceId: status.serviceId.toLowerCase() },
    ]);
    expect(parseCircuitStatuses([])).toEqual([]);
  });

  it.each([
    ['a non-array', { services: [] }],
    ['too many entries', Array.from({ length: 201 }, () => status)],
    ['a non-UUID service', [{ ...status, serviceId: 'users' }]],
    [
      'duplicate services',
      [status, { ...status, serviceId: status.serviceId.toLowerCase() }],
    ],
    ['an unknown state', [{ ...status, state: 'tripped' }]],
    ['more failures than requests', [{ ...status, failures: 6 }]],
    ['an oversized window', [{ ...status, requests: 101, failures: 0 }]],
    ['fractional counts', [{ ...status, requests: 1.5 }]],
    ['an invalid time', [{ ...status, changedAt: 'now' }]],
    ['a missing probe time', [{ ...status, nextProbeAt: undefined }]],
  ])('rejects %s', (_label, value) => {
    expect(parseCircuitStatuses(value)).toBeNull();
  });
});
