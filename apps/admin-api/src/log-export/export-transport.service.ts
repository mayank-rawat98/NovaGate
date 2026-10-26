import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { LogExportDeliveryBatch } from '@api-gateway/shared-types';
import { destinationCredentials } from './export-destination-input';
import { exportDeliveryBody } from './export-delivery-encoding';
import {
  exportDeliveryRecords,
  EXPORT_MAX_BODY_BYTES,
} from './export-delivery-payload';
import { outboundTrustedOrigins } from '../shared/outbound-egress-policy';
import {
  outboundAbortError,
  OutboundHttpError,
  sendOutboundHttp,
} from '../shared/outbound-http';

interface SignedS3Request {
  method: string;
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
  query?: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body?: unknown;
}
export const EXPORT_TRANSPORT_CAPACITY = 4;
export const EXPORT_DELIVERY_DEADLINE_MS = 15000;
export const EXPORT_RESPONSE_MAX_BYTES = 16384;

/** One provider acknowledgement per call. Durable workers, not SDKs, own retries. */
@Injectable()
export class ExportTransportService implements OnModuleDestroy {
  private readonly trustedOrigins: ReadonlySet<string>;
  private readonly pending = new Map<Promise<void>, AbortController>();
  private stopping = false;
  constructor(config: ConfigService) {
    this.trustedOrigins = outboundTrustedOrigins(
      config.get('LOG_EXPORT_HTTP_TRUSTED_ORIGINS'),
      'LOG_EXPORT_HTTP_TRUSTED_ORIGINS',
    );
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const controller of this.pending.values())
      controller.abort(new OutboundHttpError('cancelled'));
    await Promise.allSettled([...this.pending.keys()]);
  }
  async deliver(
    input: unknown,
    batch: LogExportDeliveryBatch,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.stopping || signal.aborted)
      throw new OutboundHttpError('cancelled');
    if (this.pending.size >= EXPORT_TRANSPORT_CAPACITY)
      throw new OutboundHttpError('busy', true);
    const controller = new AbortController();
    const deadline = performance.now() + EXPORT_DELIVERY_DEADLINE_MS;
    const cancel = () => controller.abort(new OutboundHttpError('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new OutboundHttpError('timeout', true)),
      EXPORT_DELIVERY_DEADLINE_MS,
    );
    timer.unref();
    const work = Promise.resolve().then(async () => {
      if (signal.aborted) cancel();
      if (controller.signal.aborted)
        throw outboundAbortError(controller.signal);
      let connection;
      try {
        connection = destinationCredentials(
          input,
          this.trustedOrigins,
        ).credentials;
      } catch {
        throw new OutboundHttpError('blocked_destination');
      }
      const records = exportDeliveryRecords(batch, controller.signal, deadline);
      const headers: Record<string, string> = {
        'User-Agent': 'NovaGate-Log-Export/1',
        'X-NovaGate-Delivery-Id': batch.deliveryId.toLowerCase(),
        'Content-Type': 'application/x-ndjson',
      };
      const body = exportDeliveryBody(connection.type, { ...batch, records });
      if (performance.now() >= deadline)
        throw new OutboundHttpError('timeout', true);
      if (connection.type === 'webhook') {
        const timestamp = String(Math.floor(Date.now() / 1000));
        headers['X-NovaGate-Timestamp'] = timestamp;
        headers['X-NovaGate-Signature'] =
          `v1=${createHmac('sha256', connection.signingSecret).update(timestamp).update('.').update(headers['X-NovaGate-Delivery-Id']).update('.').update(body).digest('hex')}`;
        await this.send(
          new URL(connection.url),
          body,
          headers,
          'POST',
          controller.signal,
        );
      } else if (connection.type === 'datadog') {
        headers['Content-Type'] = 'application/json';
        headers['DD-API-KEY'] = connection.apiKey;
        await this.send(
          new URL(`https://http-intake.logs.${connection.site}/api/v2/logs`),
          body,
          headers,
          'POST',
          controller.signal,
        );
      } else {
        const key = `novagate/${batch.tenantId.toLowerCase()}/${batch.destinationId.toLowerCase()}/${batch.deliveryId.toLowerCase()}.ndjson`;
        const client = new S3Client({
          endpoint: connection.endpoint,
          region: connection.region,
          credentials: {
            accessKeyId: connection.accessKeyId,
            secretAccessKey: connection.secretAccessKey,
            ...(connection.sessionToken
              ? { sessionToken: connection.sessionToken }
              : {}),
          },
          forcePathStyle: connection.forcePathStyle,
          maxAttempts: 1,
          followRegionRedirects: false,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          requestHandler: {
            handle: async (request: SignedS3Request) => {
              if (
                request.method !== 'PUT' ||
                !Buffer.isBuffer(request.body) ||
                !request.body.equals(body)
              )
                throw new OutboundHttpError('invalid_payload');
              const url = new URL(
                `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}`,
              );
              for (const [name, values] of Object.entries(
                request.query ?? {},
              )) {
                for (const value of Array.isArray(values) ? values : [values])
                  url.searchParams.append(name, value ?? '');
              }
              await this.send(
                url,
                body,
                request.headers,
                'PUT',
                controller.signal,
              );
              // PutObject has no required response payload; do not expose remote text to the SDK.
              return {
                response: {
                  statusCode: 200,
                  headers: {},
                  body: Readable.from([]),
                },
              };
            },
          },
        });
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: connection.bucket,
              Key: key,
              Body: body,
              ContentType: 'application/x-ndjson',
              Metadata: {
                'novagate-delivery-id': batch.deliveryId.toLowerCase(),
              },
            }),
            { abortSignal: controller.signal },
          );
        } finally {
          client.destroy();
        }
      }
    });
    this.pending.set(work, controller);
    try {
      await work;
    } catch (error) {
      if (controller.signal.aborted)
        throw outboundAbortError(controller.signal);
      if (error instanceof OutboundHttpError) throw error;
      throw new OutboundHttpError('connection_failed', true);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.pending.delete(work);
    }
  }
  private send(
    url: URL,
    body: Buffer,
    headers: Readonly<Record<string, string>>,
    method: 'POST' | 'PUT',
    signal: AbortSignal,
  ): Promise<void> {
    return sendOutboundHttp(url, body, headers, this.trustedOrigins, signal, {
      method,
      maxBodyBytes: EXPORT_MAX_BODY_BYTES,
      maxResponseBytes: EXPORT_RESPONSE_MAX_BYTES,
    });
  }
}
