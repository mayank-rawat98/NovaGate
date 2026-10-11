import type {
  LogExportDeliveryBatch,
  LogExportDestinationType,
  LogExportRecord,
} from '@api-gateway/shared-types';
import { EXPORT_MAX_BODY_BYTES } from './export-delivery-payload';
import { OutboundHttpError } from '../shared/outbound-http';

/** Shared by admission and transport so envelope overhead cannot strand a batch. */
export function encodeExportRecord(
  type: LogExportDestinationType,
  batch: Pick<
    LogExportDeliveryBatch,
    'tenantId' | 'destinationId' | 'deliveryId'
  >,
  record: LogExportRecord,
): string {
  if (type !== 'datadog') return JSON.stringify(record);
  return JSON.stringify({
    ddsource: 'novagate',
    service: 'novagate-gateway',
    message: JSON.stringify(record),
    novagate: {
      version: 1,
      tenantId: batch.tenantId.toLowerCase(),
      destinationId: batch.destinationId.toLowerCase(),
      deliveryId: batch.deliveryId.toLowerCase(),
      recordId: record.id,
    },
  });
}
export function exportDeliveryBody(
  type: LogExportDestinationType,
  batch: LogExportDeliveryBatch,
): Buffer {
  if (!batch.records.length) throw new OutboundHttpError('invalid_payload');
  const records = batch.records.map((record) =>
    encodeExportRecord(type, batch, record),
  );
  const body = Buffer.from(
    type === 'datadog' ? `[${records.join(',')}]` : records.join('\n') + '\n',
  );
  if (body.length > EXPORT_MAX_BODY_BYTES)
    throw new OutboundHttpError('invalid_payload');
  return body;
}
