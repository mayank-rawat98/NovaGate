import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPublicAlertAddress } from './alert-egress-policy';

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
export class AlertTransportError extends Error {
  constructor(
    readonly code: AlertTransportErrorCode,
    readonly retryable = false,
  ) {
    super(MESSAGES[code]);
    this.name = 'AlertTransportError';
  }
}
export function alertAbortError(signal: AbortSignal): AlertTransportError {
  return signal.reason instanceof AlertTransportError
    ? signal.reason
    : new AlertTransportError('cancelled');
}

async function resolveDestination(
  hostname: string,
  trusted: boolean,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  if (signal.aborted) throw alertAbortError(signal);
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!trusted && !isPublicAlertAddress(hostname))
      throw new AlertTransportError('blocked_destination');
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  // Dedicated cancellable c-ares resolver, avoiding uncancellable OS lookup work.
  // Both families must finish and every answer must satisfy the policy.
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signal.aborted) throw alertAbortError(signal);
    const addresses: Array<{ address: string; family: 4 | 6 }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const code = (result.reason as NodeJS.ErrnoException)?.code;
        if (code !== 'ENODATA' && code !== 'ENOTFOUND')
          throw new AlertTransportError('dns_failed', true);
        continue;
      }
      if (result.value.length > ALERT_HTTP_MAX_DNS_ANSWERS)
        throw new AlertTransportError('blocked_destination');
      for (const address of result.value) {
        const family = i === 0 ? 4 : 6;
        if (
          isIP(address) !== family ||
          (!trusted && !isPublicAlertAddress(address))
        )
          throw new AlertTransportError('blocked_destination');
        addresses.push({ address, family });
      }
    }
    if (!addresses.length) throw new AlertTransportError('dns_failed', true);
    if (addresses.length > ALERT_HTTP_MAX_DNS_ANSWERS)
      throw new AlertTransportError('blocked_destination');
    return addresses[0];
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** One POST, no redirects, no connection pool, full bounded response consumption. */
export async function postAlertJson(
  url: URL,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
  trustedOrigins: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  if (body.length > ALERT_HTTP_MAX_BYTES)
    throw new AlertTransportError('invalid_payload');
  const trusted = trustedOrigins.has(url.origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (!trusted && (url.protocol !== 'https:' || !!url.port))
  )
    throw new AlertTransportError('blocked_destination');
  const pinned = await resolveDestination(hostname, trusted, signal);
  if (signal.aborted) throw alertAbortError(signal);
  await new Promise<void>((resolve, reject) => {
    let request: ClientRequest;
    let error: AlertTransportError | undefined;
    let complete = false;
    const fail = (failure: AlertTransportError) => {
      error ??= failure;
      request.destroy();
    };
    const abort = () => fail(alertAbortError(signal));
    try {
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: 'POST',
          agent: false,
          // Explicit family disables automatic family selection/re-resolution.
          family: pinned.family,
          lookup: (_name, _options, callback) =>
            callback(null, pinned.address, pinned.family),
          rejectUnauthorized: true,
          maxHeaderSize: 8192,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
            Connection: 'close',
          },
        },
        (response) => {
          let bytes = 0;
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            fail(
              new AlertTransportError(
                status >= 300 && status < 400
                  ? 'redirect_refused'
                  : status === 408 || status === 429 || status >= 500
                    ? 'http_retryable'
                    : 'http_client_error',
                status === 408 || status === 429 || status >= 500,
              ),
            );
          }
          const length = response.headers['content-length'];
          if (length && Number(length) > ALERT_HTTP_MAX_BYTES)
            fail(new AlertTransportError('response_too_large'));
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > ALERT_HTTP_MAX_BYTES)
              fail(new AlertTransportError('response_too_large'));
          });
          response.on('end', () => {
            complete = true;
          });
          response.on('error', () => {
            fail(new AlertTransportError('connection_failed', true));
          });
        },
      );
    } catch {
      reject(new AlertTransportError('connection_failed', true));
      return;
    }
    request.on('error', () => {
      error ??= new AlertTransportError('connection_failed', true);
    });
    request.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) error ??= alertAbortError(signal);
      if (error) reject(error);
      else if (complete) resolve();
      else reject(new AlertTransportError('connection_failed', true));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else request.end(body);
  });
}
