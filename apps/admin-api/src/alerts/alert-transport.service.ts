import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { AlertWebhookPayload } from '@api-gateway/shared-types';
import { normalizeAlertCredentials } from './alert-channel-input';
import { alertTrustedOrigins } from './alert-egress-policy';
import {
  alertAbortError,
  AlertTransportError,
  postAlertJson,
} from './alert-http';

export const ALERT_DELIVERY_DEADLINE_MS = 5000;
export const ALERT_TRANSPORT_CAPACITY = 8;

function hasControl(value: string, includeSpace = false): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < (includeSpace ? 33 : 32) ||
      character.charCodeAt(0) === 127,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[
        character
      ] ?? character
    );
  });
}
function validatePayload(payload: AlertWebhookPayload): void {
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  const event = payload?.event;
  if (
    payload?.version !== 1 ||
    !uuid.test(payload.deliveryId) ||
    !uuid.test(payload.tenantId) ||
    !event ||
    !uuid.test(event.id) ||
    (event.ruleId !== null && !uuid.test(event.ruleId)) ||
    typeof event.ruleName !== 'string' ||
    !event.ruleName.length ||
    event.ruleName.length > 100 ||
    hasControl(event.ruleName) ||
    !['firing', 'resolved'].includes(event.state) ||
    ![
      'error_rate',
      'downstream_timeout_rate',
      'p95_latency_ms',
      'rps',
    ].includes(event.metric) ||
    !['>', '<', '>=', '<='].includes(event.operator) ||
    !Number.isFinite(event.value) ||
    event.value < 0 ||
    !Number.isFinite(event.threshold) ||
    event.threshold < 0 ||
    !Number.isInteger(event.windowMinutes) ||
    event.windowMinutes < 1 ||
    event.windowMinutes > 60 ||
    typeof event.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(event.createdAt))
  )
    throw new AlertTransportError('invalid_payload');
}

@Injectable()
export class AlertTransportService implements OnModuleDestroy {
  private readonly trustedOrigins: ReadonlySet<string>;
  private readonly mailKey?: string;
  private readonly mailFrom: string;
  private readonly mailUrl: URL;
  private readonly pending = new Map<Promise<void>, AbortController>();
  private stopping = false;
  get emailEnabled(): boolean {
    return !!this.mailKey;
  }
  constructor(config: ConfigService) {
    this.trustedOrigins = alertTrustedOrigins(
      config.get('ALERT_HTTP_TRUSTED_ORIGINS'),
    );
    this.mailKey = config.get<string>('SMTP_API_KEY');
    this.mailFrom = config.get<string>('SMTP_FROM') ?? 'support@novagate.dev';
    try {
      const base = new URL(
        config.get<string>('SMTP_API_BASE_URL') ?? 'https://api.mailtr.co',
      );
      if (
        (this.mailKey &&
          (typeof this.mailKey !== 'string' ||
            this.mailKey.length > 4096 ||
            hasControl(this.mailKey, true))) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/' ||
        (!this.trustedOrigins.has(base.origin) &&
          (base.protocol !== 'https:' || !!base.port))
      )
        throw new Error();
      if (
        typeof this.mailFrom !== 'string' ||
        this.mailFrom.length > 320 ||
        this.mailFrom !== this.mailFrom.trim() ||
        hasControl(this.mailFrom)
      )
        throw new Error();
      // Preserve the existing Mailtr sender form: Name <address> or bare address.
      const mailbox = /^(?:[^<>]{1,100})<([^<>]+)>$/.exec(this.mailFrom);
      normalizeAlertCredentials({
        type: 'email',
        address: mailbox ? mailbox[1] : this.mailFrom,
      });
      this.mailUrl = new URL('/api/v1/emails/send', base);
    } catch {
      throw new Error('Invalid alert email transport configuration.');
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const controller of this.pending.values())
      controller.abort(new AlertTransportError('cancelled'));
    await Promise.allSettled([...this.pending.keys()]);
  }
  async deliver(
    input: unknown,
    payload: AlertWebhookPayload,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.stopping || signal.aborted)
      throw new AlertTransportError('cancelled');
    if (this.pending.size >= ALERT_TRANSPORT_CAPACITY)
      throw new AlertTransportError('busy', true);
    validatePayload(payload);
    let credentials: ReturnType<typeof normalizeAlertCredentials>;
    try {
      credentials = normalizeAlertCredentials(input, this.trustedOrigins);
    } catch {
      throw new AlertTransportError('blocked_destination');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(new AlertTransportError('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new AlertTransportError('timeout', true)),
      ALERT_DELIVERY_DEADLINE_MS,
    );
    timer.unref();
    const work = Promise.resolve().then(async () => {
      if (signal.aborted) cancel();
      if (controller.signal.aborted) throw alertAbortError(controller.signal);
      const event = payload.event;
      // Copy only documented event fields; never serialize internal database rows.
      const bodyPayload: AlertWebhookPayload = {
        version: 1,
        deliveryId: payload.deliveryId,
        tenantId: payload.tenantId,
        event: {
          id: event.id,
          ruleId: event.ruleId,
          ruleName: event.ruleName,
          metric: event.metric,
          operator: event.operator,
          threshold: event.threshold,
          windowMinutes: event.windowMinutes,
          state: event.state,
          value: event.value,
          createdAt: event.createdAt,
        },
      };
      const text = `NovaGate alert ${event.state}: ${event.ruleName}\n${event.metric}: ${event.value} (${event.operator} ${event.threshold}), window ${event.windowMinutes} minute(s).\nEvent: ${event.id}`;
      let url: URL;
      let body: Buffer;
      const headers: Record<string, string> = {
        'User-Agent': 'NovaGate-Alerts/1',
        'X-NovaGate-Delivery-Id': payload.deliveryId,
      };
      if (credentials.credentials.type === 'webhook') {
        const timestamp = String(Math.floor(Date.now() / 1000));
        url = new URL(credentials.credentials.url);
        body = Buffer.from(JSON.stringify(bodyPayload));
        headers['X-NovaGate-Timestamp'] = timestamp;
        headers['X-NovaGate-Signature'] =
          `v1=${createHmac('sha256', credentials.credentials.secret).update(timestamp).update('.').update(body).digest('hex')}`;
      } else if (credentials.credentials.type === 'slack') {
        url = new URL(credentials.credentials.webhookUrl);
        body = Buffer.from(
          JSON.stringify({
            text: text.replace(/[&<>]/g, escapeHtml),
            mrkdwn: false,
            unfurl_links: false,
            unfurl_media: false,
            blocks: [{ type: 'section', text: { type: 'plain_text', text } }],
          }),
        );
      } else {
        if (!this.mailKey) throw new AlertTransportError('configuration');
        url = this.mailUrl;
        headers.Authorization = `Bearer ${this.mailKey}`;
        headers['Idempotency-Key'] = payload.deliveryId;
        body = Buffer.from(
          JSON.stringify({
            from: this.mailFrom,
            to: [credentials.credentials.address],
            subject: `NovaGate alert ${event.state}: ${event.ruleName}`,
            text,
            html: `<pre>${escapeHtml(text)}</pre>`,
          }),
        );
      }
      await postAlertJson(
        url,
        body,
        headers,
        this.trustedOrigins,
        controller.signal,
      );
    });
    this.pending.set(work, controller);
    try {
      await work;
    } catch (error) {
      if (error instanceof AlertTransportError) throw error;
      throw new AlertTransportError('connection_failed', true);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.pending.delete(work);
    }
  }
}
