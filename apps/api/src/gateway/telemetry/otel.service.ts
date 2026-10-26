import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import {
  W3CTraceContextPropagator,
  hrTimeToMilliseconds,
} from '@opentelemetry/core';
import {
  TracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  SamplingDecision,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import {
  MAX_TRACE_ATTRIBUTE_BYTES,
  MAX_TRACE_ATTRIBUTES,
  MAX_TRACE_SPAN_BYTES,
  TRACE_ATTRIBUTE_KEYS,
  type TraceSpan,
} from '@api-gateway/shared-types';
import {
  DEFAULT_TRACING,
  type TracingSettings,
} from '../../config/configuration';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { GatewayTelemetryService } from './gateway-telemetry.service';
import { MetricsService } from '../metrics/metrics.service';
import type { GatewayTraceHandle } from '../shared/request-context';

const KEYS = new Set<string>(TRACE_ATTRIBUTE_KEYS);
function safeAttributes(
  input: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !KEYS.has(key) ||
      Object.keys(attributes).length >= MAX_TRACE_ATTRIBUTES
    )
      continue;
    if (typeof value === 'string') {
      let bounded = value.slice(0, MAX_TRACE_ATTRIBUTE_BYTES);
      while (Buffer.byteLength(bounded) > MAX_TRACE_ATTRIBUTE_BYTES)
        bounded = bounded.slice(0, -1);
      attributes[key] = bounded;
    } else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      attributes[key] = value;
  }
  return attributes;
}

@Injectable()
export class OtelService implements OnModuleInit, OnModuleDestroy {
  private readonly settings: TracingSettings;
  private readonly provider: TracerProvider;
  private readonly propagator = new W3CTraceContextPropagator();
  private readonly metadata = new WeakMap<object, { tenant: string | null }>();
  private readonly open = new Map<object, () => void>();
  private queue: Array<{
    span: TraceSpan;
    bytes: number;
    tenant: string | null;
  }> = [];
  private queueBytes = 0;
  private active = 0;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly tracer;

  constructor(
    config: ConfigService,
    private readonly manager: GatewayConfigManagerService,
    private readonly telemetry: GatewayTelemetryService,
    private readonly metrics: MetricsService,
  ) {
    this.settings = {
      ...DEFAULT_TRACING,
      ...config.get<TracingSettings>('tracing'),
    };
    const parentSampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(this.settings.sampleRate),
    });
    const processor: SpanProcessor = {
      onStart: () => {
        this.active++;
        this.metrics.setTraceActiveSpans(this.active);
      },
      onEnd: (span) => {
        this.active--;
        this.open.delete(span);
        this.metrics.setTraceActiveSpans(this.active);
        this.enqueue(span);
      },
      forceFlush: async () => {
        this.flush();
      },
      shutdown: async () => {
        this.flush();
      },
    };
    this.provider = new TracerProvider({
      sampler: {
        shouldSample: (...args) => {
          if (!this.settings.enabled || this.stopping)
            return { decision: SamplingDecision.NOT_RECORD };
          if (this.active >= this.settings.maxActiveSpans) {
            this.metrics.incrementTraceDropped('active-capacity');
            return { decision: SamplingDecision.NOT_RECORD };
          }
          return parentSampler.shouldSample(...args);
        },
        toString: () => 'NovaGateBoundedParentSampler',
      },
      spanProcessors: [processor],
      spanLimits: {
        attributeCountLimit: MAX_TRACE_ATTRIBUTES,
        attributeValueLengthLimit: MAX_TRACE_ATTRIBUTE_BYTES,
        eventCountLimit: 0,
        linkCountLimit: 0,
      },
    });
    this.tracer = this.provider.getTracer('novagate.gateway', '1');
  }
  get activeSpans(): number {
    return this.active;
  }
  get queuedSpans(): number {
    return this.queue.length;
  }
  onModuleInit(): void {
    if (this.timer || this.stopping || !this.settings.enabled) return;
    this.timer = setInterval(() => this.flush(), this.settings.flushIntervalMs);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const end of [...this.open.values()]) end();
    this.flush();
    await this.provider.shutdown();
  }
  startServer(
    headers: Record<string, unknown>,
    requestId: string,
    protocol = 'http',
  ): GatewayTraceHandle {
    // Only trace context crosses the trust boundary; baggage is never extracted.
    const carrier: Record<string, string> = {};
    if (
      typeof headers.traceparent === 'string' &&
      headers.traceparent.length <= 256
    )
      carrier.traceparent = headers.traceparent;
    if (
      typeof headers.tracestate === 'string' &&
      Buffer.byteLength(headers.tracestate) <= 512
    )
      carrier.tracestate = headers.tracestate;
    const parent = this.propagator.extract(ROOT_CONTEXT, carrier, {
      keys: Object.keys,
      get: (value, key) => value[key],
    });
    return this.begin('Gateway request', SpanKind.SERVER, parent, {
      'gateway.request.id': requestId,
      'gateway.protocol': protocol,
    });
  }
  private begin(
    name: string,
    kind: SpanKind,
    parent: Context,
    attributes: Record<string, unknown>,
    tenant: string | null = this.manager.getTenantId(),
  ): GatewayTraceHandle {
    const initial = safeAttributes(attributes);
    const span: Span = this.tracer.startSpan(
      name.slice(0, 128),
      { kind, attributes: initial },
      parent,
    );
    const context = trace.setSpan(parent, span);
    this.metadata.set(span, { tenant });
    let ended = false;
    const end = (statusCode?: number) => {
      if (ended) return;
      ended = true;
      if (statusCode !== undefined) {
        if (initial['gateway.protocol'] === 'http')
          span.setAttribute('http.response.status_code', statusCode);
        if (statusCode === 499) span.setAttribute('gateway.incomplete', true);
        span.setStatus({
          code: statusCode >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
      }
      span.end();
    };
    if (span.isRecording()) this.open.set(span, () => end(499));
    const ids = span.spanContext();
    return {
      traceId: ids.traceId,
      spanId: ids.spanId,
      headers: () => {
        const carrier: Record<string, string> = {};
        this.propagator.inject(context, carrier, {
          set: (value, key, content) => {
            value[key] = content;
          },
        });
        return carrier;
      },
      set: (values) => {
        if (!ended) span.setAttributes(safeAttributes(values));
      },
      end,
      child: (childName, values = {}) =>
        this.begin(
          childName,
          SpanKind.CLIENT,
          context,
          {
            'gateway.protocol': initial['gateway.protocol'],
            'gateway.request.id': initial['gateway.request.id'],
            ...values,
          },
          tenant,
        ),
    };
  }
  private enqueue(span: ReadableSpan): void {
    const tenant = this.metadata.get(span)?.tenant ?? null;
    if (!tenant || tenant !== this.manager.getTenantId()) {
      this.metrics.incrementTraceDropped('tenant-change');
      return;
    }
    const ids = span.spanContext();
    const wire: TraceSpan = {
      traceId: ids.traceId,
      spanId: ids.spanId,
      ...(span.parentSpanContext
        ? { parentSpanId: span.parentSpanContext.spanId }
        : {}),
      name: span.name,
      kind:
        span.kind === SpanKind.SERVER
          ? 'server'
          : span.kind === SpanKind.CLIENT
            ? 'client'
            : 'internal',
      timestamp: new Date(hrTimeToMilliseconds(span.startTime)).toISOString(),
      durationMs: hrTimeToMilliseconds(span.duration),
      status:
        span.status.code === SpanStatusCode.ERROR
          ? 'error'
          : span.status.code === SpanStatusCode.OK
            ? 'ok'
            : 'unset',
      attributes: safeAttributes(span.attributes),
    };
    const bytes = Buffer.byteLength(JSON.stringify(wire));
    if (
      bytes > MAX_TRACE_SPAN_BYTES ||
      bytes + 33 > this.settings.maxBatchBytes ||
      this.queue.length >= this.settings.maxQueuedSpans ||
      this.queueBytes + bytes > this.settings.maxQueueBytes
    ) {
      this.metrics.incrementTraceDropped('queue-capacity');
      return;
    }
    this.queue.push({ span: wire, bytes, tenant });
    this.queueBytes += bytes;
    this.metrics.setTraceQueuedSpans(this.queue.length);
    if (this.queue.length >= this.settings.maxBatchSpans) this.flush();
  }
  flush(): void {
    const tenant = this.manager.getTenantId();
    while (this.queue.length) {
      const batch: TraceSpan[] = [];
      let bytes = 32;
      while (this.queue.length && batch.length < this.settings.maxBatchSpans) {
        const next = this.queue[0];
        if (next.tenant !== tenant) {
          this.queue.shift();
          this.queueBytes -= next.bytes;
          this.metrics.incrementTraceDropped('tenant-change');
          continue;
        }
        if (bytes + next.bytes + 1 > this.settings.maxBatchBytes) break;
        this.queue.shift();
        this.queueBytes -= next.bytes;
        batch.push(next.span);
        bytes += next.bytes + 1;
      }
      if (!batch.length) break;
      let sent = false;
      try {
        sent = this.telemetry.sendTraces(batch, this.settings.maxBufferedBytes);
      } catch {
        /* Never throw export failures into a response. */
      }
      if (!sent)
        for (const _span of batch)
          this.metrics.incrementTraceDropped('transport-backpressure');
    }
    this.metrics.setTraceQueuedSpans(this.queue.length);
  }
}
