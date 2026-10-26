import { OutboundHttpError, sendOutboundHttp } from '../shared/outbound-http';

export const ALERT_HTTP_MAX_BYTES = 16384;
export const ALERT_HTTP_MAX_DNS_ANSWERS = 16;
export type AlertTransportErrorCode =
  | 'configuration'
  | 'invalid_payload'
  | 'blocked_destination'
  | 'dns_failed'
  | 'timeout'
  | 'cancelled'
  | 'connection_failed'
  | 'response_too_large'
  | 'redirect_refused'
  | 'http_client_error'
  | 'http_retryable'
  | 'busy';
const MESSAGES: Record<AlertTransportErrorCode, string> = {
  configuration: 'Alert delivery is not configured.',
  invalid_payload: 'Alert payload is invalid or exceeds the size limit.',
  blocked_destination: 'Alert destination is blocked by the egress policy.',
  dns_failed: 'Alert destination could not be resolved safely.',
  timeout: 'Alert delivery exceeded its deadline.',
  cancelled: 'Alert delivery was cancelled.',
  connection_failed: 'Alert destination connection failed.',
  response_too_large: 'Alert response exceeds the size limit.',
  redirect_refused: 'Alert destination redirects are refused.',
  http_client_error: 'Alert destination rejected the request.',
  http_retryable: 'Alert destination is temporarily unavailable.',
  busy: 'Alert delivery capacity is busy.',
};
/** Errors never include destination paths, credentials or remote response text. */
export class AlertTransportError extends OutboundHttpError {
  constructor(
    override readonly code: AlertTransportErrorCode,
    override readonly retryable = false,
  ) {
    super(code, retryable);
    this.message = MESSAGES[code];
    this.name = 'AlertTransportError';
  }
}
export function alertAbortError(signal: AbortSignal): AlertTransportError {
  return signal.reason instanceof AlertTransportError
    ? signal.reason
    : new AlertTransportError('cancelled');
}

/** Preserve alert wire/error contracts through the shared egress boundary. */
export async function postAlertJson(
  url: URL,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
  trustedOrigins: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  try {
    await sendOutboundHttp(
      url,
      body,
      { ...headers, 'Content-Type': 'application/json' },
      trustedOrigins,
      signal,
      {
        method: 'POST',
        maxBodyBytes: ALERT_HTTP_MAX_BYTES,
        maxResponseBytes: ALERT_HTTP_MAX_BYTES,
      },
    );
  } catch (error) {
    if (error instanceof OutboundHttpError)
      throw new AlertTransportError(error.code, error.retryable);
    throw new AlertTransportError('connection_failed', true);
  }
}
