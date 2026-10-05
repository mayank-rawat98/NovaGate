import { ConfigService } from '@nestjs/config';
import { OtelService } from './otel.service';
import { MetricsService } from '../metrics/metrics.service';
import type { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import type { GatewayTelemetryService } from './gateway-telemetry.service';
import type { TracingSettings } from '../../config/configuration';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const REQUEST = '7fbd0af8-c17d-4e21-ab0b-a20799382118';
function fixture(settings: Partial<TracingSettings> = {}) {
  let tenant: string | null = TENANT;
  const telemetry = { sendTraces: jest.fn().mockReturnValue(true) };
  const metrics = new MetricsService();
  const service = new OtelService(
    new ConfigService({ tracing: { sampleRate: 1, ...settings } }),
    { getTenantId: () => tenant } as unknown as GatewayConfigManagerService,
    telemetry as unknown as GatewayTelemetryService,
    metrics,
  );
  return {
    service,
    telemetry,
    metrics,
    tenant: (value: string | null) => {
      tenant = value;
    },
  };
}
describe('bounded OpenTelemetry contexts and export', () => {
  it('preserves valid parent context, gives attempts distinct IDs and does not forward baggage', async () => {
    const f = fixture();
    const parent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    const root = f.service.startServer(
      {
        traceparent: parent,
        baggage: 'authorization=private-token',
        tracestate: 'vendor=value',
      },
      REQUEST,
    );
    const child = root.child('upstream HTTP');
    expect(root.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
    expect(child.headers()).toEqual({
      traceparent: `00-${root.traceId}-${child.spanId}-01`,
      tracestate: 'vendor=value',
    });
    child.set({
      'http.route': '/users/:id',
      authorization: 'private-token',
      'http.target': '/private?token=secret',
    });
    child.end(502);
    root.end(200);
    root.end(500);
    f.service.flush();
    expect(f.telemetry.sendTraces).toHaveBeenCalledTimes(1);
    const spans = f.telemetry.sendTraces.mock.calls[0][0];
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual(
      expect.objectContaining({
        parentSpanId: root.spanId,
        status: 'error',
        kind: 'client',
      }),
    );
    expect(JSON.stringify(spans)).not.toMatch(
      /private|secret|authorization|http.target/,
    );
    expect(f.service.activeSpans).toBe(0);
    await f.service.onModuleDestroy();
  });
  it('isolates concurrent requests and replaces malformed/zero/duplicate traceparent', async () => {
    const f = fixture();
    const roots = [];
    for (const traceparent of [
      'invalid',
      '00-00000000000000000000000000000000-0123456789abcdef-01',
      ['00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'],
    ]) {
      const root = f.service.startServer({ traceparent }, REQUEST);
      roots.push(root);
      expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(root.traceId).not.toBe('00000000000000000000000000000000');
    }
    expect(new Set(roots.map((root) => root.traceId)).size).toBe(3);
    for (const root of roots) root.end(200);
    await f.service.onModuleDestroy();
  });
  it('honors unsampled parents while sampling new roots', async () => {
    const f = fixture();
    const root = f.service.startServer(
      {
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-00',
      },
      REQUEST,
    );
    const child = root.child('upstream');
    child.end();
    root.end();
    f.service.flush();
    expect(root.headers().traceparent.endsWith('-00')).toBe(true);
    expect(f.telemetry.sendTraces).not.toHaveBeenCalled();
    expect(f.service.activeSpans).toBe(0);
    await f.service.onModuleDestroy();
  });
  it('bounds active recording spans and releases admission after idempotent end', async () => {
    const f = fixture({ maxActiveSpans: 1 });
    const first = f.service.startServer({}, REQUEST);
    const excess = f.service.startServer({}, REQUEST);
    expect(f.service.activeSpans).toBe(1);
    expect(excess.headers().traceparent.endsWith('-00')).toBe(true);
    excess.end();
    first.end();
    first.end();
    const recovery = f.service.startServer({}, REQUEST);
    expect(recovery.headers().traceparent.endsWith('-01')).toBe(true);
    recovery.end();
    await f.service.onModuleDestroy();
  });
  it('bounds queued spans and discards old tenant generations', async () => {
    const f = fixture({ maxQueuedSpans: 1 });
    f.service.startServer({}, REQUEST).end(200);
    f.service.startServer({}, REQUEST).end(200);
    expect(f.service.queuedSpans).toBe(1);
    const old = f.service.startServer({}, REQUEST);
    f.tenant('bbccddee-1111-2222-3333-444455556666');
    old.end(200);
    f.service.flush();
    expect(f.service.queuedSpans).toBe(0);
    expect(f.telemetry.sendTraces).not.toHaveBeenCalled();
    await f.service.onModuleDestroy();
  });
  it('does not attribute a late child of an old request to a replacement tenant', async () => {
    const f = fixture();
    const root = f.service.startServer({}, REQUEST);
    f.tenant('bbccddee-1111-2222-3333-444455556666');
    root.child('late upstream').end(200);
    root.end(200);
    f.service.flush();
    expect(f.telemetry.sendTraces).not.toHaveBeenCalled();
    expect(f.service.activeSpans).toBe(0);
    await f.service.onModuleDestroy();
  });
  it('bounds UTF-8 attributes and batch bytes without truncating short ASCII route patterns', async () => {
    const f = fixture({ maxBatchBytes: 8192, maxBatchSpans: 2 });
    for (let i = 0; i < 3; i++) {
      const root = f.service.startServer({}, REQUEST);
      root.set({
        'http.route': 'x'.repeat(200),
        'gateway.service.id': '🧭'.repeat(200),
      });
      root.end(200);
    }
    f.service.flush();
    const batches = f.telemetry.sendTraces.mock.calls.map(([batch]) => batch);
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    for (const batch of batches) {
      expect(
        Buffer.byteLength(JSON.stringify({ type: 'traces', payload: batch })),
      ).toBeLessThanOrEqual(8192);
      for (const span of batch) {
        expect(span.attributes['http.route']).toHaveLength(200);
        expect(
          Buffer.byteLength(span.attributes['gateway.service.id']),
        ).toBeLessThanOrEqual(256);
      }
    }
    await f.service.onModuleDestroy();
  });
  it('isolates exporter exceptions from span completion', async () => {
    const f = fixture({ maxBatchSpans: 1 });
    f.telemetry.sendTraces.mockImplementation(() => {
      throw new Error('private exporter failure');
    });
    expect(() => f.service.startServer({}, REQUEST).end(200)).not.toThrow();
    expect(f.service.activeSpans).toBe(0);
    expect(f.service.queuedSpans).toBe(0);
    await f.service.onModuleDestroy();
  });
  it('drops batches on transport backpressure and clears timer/active scopes on shutdown', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.telemetry.sendTraces.mockReturnValue(false);
      f.service.onModuleInit();
      f.service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      f.service.startServer({}, REQUEST);
      await f.service.onModuleDestroy();
      expect(f.service.activeSpans).toBe(0);
      expect(f.service.queuedSpans).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      expect(f.telemetry.sendTraces).toHaveBeenCalledTimes(1);
      f.service.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
