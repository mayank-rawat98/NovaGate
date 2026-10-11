import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPublicOutboundAddress } from './outbound-egress-policy';

const HTTP_MAX_DNS_ANSWERS = 16;
export type OutboundHttpErrorCode =
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
/** Never persist remote messages, URL paths, response bodies or credentials. */
export class OutboundHttpError extends Error {
  constructor(
    readonly code: OutboundHttpErrorCode,
    readonly retryable = false,
  ) {
    super(`Outbound request failed (${code}).`);
    this.name = 'OutboundHttpError';
  }
}
export function outboundAbortError(signal: AbortSignal): OutboundHttpError {
  return signal.reason instanceof OutboundHttpError
    ? signal.reason
    : new OutboundHttpError('cancelled');
}

async function resolveDestination(
  hostname: string,
  trusted: boolean,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  if (signal.aborted) throw outboundAbortError(signal);
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!trusted && !isPublicOutboundAddress(hostname))
      throw new OutboundHttpError('blocked_destination');
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
    if (signal.aborted) throw outboundAbortError(signal);
    const addresses: Array<{ address: string; family: 4 | 6 }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const code = (result.reason as NodeJS.ErrnoException)?.code;
        if (code !== 'ENODATA' && code !== 'ENOTFOUND')
          throw new OutboundHttpError('dns_failed', true);
        continue;
      }
      if (result.value.length > HTTP_MAX_DNS_ANSWERS)
        throw new OutboundHttpError('blocked_destination');
      for (const address of result.value) {
        const family = i === 0 ? 4 : 6;
        if (
          isIP(address) !== family ||
          (!trusted && !isPublicOutboundAddress(address))
        )
          throw new OutboundHttpError('blocked_destination');
        addresses.push({ address, family });
      }
    }
    if (!addresses.length) throw new OutboundHttpError('dns_failed', true);
    if (addresses.length > HTTP_MAX_DNS_ANSWERS)
      throw new OutboundHttpError('blocked_destination');
    return addresses[0];
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** One pinned request; caller owns an absolute deadline and retries. Capacity remains held until close. */
export async function sendOutboundHttp(
  url: URL,
  body: Buffer,
  headers: Readonly<Record<string, string>>,
  trustedOrigins: ReadonlySet<string>,
  signal: AbortSignal,
  options: {
    method: 'POST' | 'PUT';
    maxBodyBytes: number;
    maxResponseBytes: number;
  },
): Promise<void> {
  if (body.length > options.maxBodyBytes)
    throw new OutboundHttpError('invalid_payload');
  if (
    !Buffer.isBuffer(body) ||
    !Number.isSafeInteger(options.maxBodyBytes) ||
    options.maxBodyBytes < 1 ||
    !Number.isSafeInteger(options.maxResponseBytes) ||
    options.maxResponseBytes < 1 ||
    !['POST', 'PUT'].includes(options.method) ||
    Object.keys(headers).length > 32 ||
    Object.entries(headers).some(
      ([name, value]) =>
        !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(name) ||
        typeof value !== 'string' ||
        Array.from(value).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    ) ||
    Object.entries(headers).reduce(
      (size, [name, value]) =>
        size + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
      0,
    ) > 8192
  )
    throw new OutboundHttpError('invalid_payload');
  const trusted = trustedOrigins.has(url.origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (!trusted && (url.protocol !== 'https:' || !!url.port))
  )
    throw new OutboundHttpError('blocked_destination');
  const pinned = await resolveDestination(hostname, trusted, signal);
  if (signal.aborted) throw outboundAbortError(signal);
  await new Promise<void>((resolve, reject) => {
    let request: ClientRequest;
    let error: OutboundHttpError | undefined;
    let complete = false;
    const fail = (failure: OutboundHttpError) => {
      error ??= failure;
      request.destroy();
    };
    const abort = () => fail(outboundAbortError(signal));
    try {
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: options.method,
          agent: false,
          // Explicit family disables automatic family selection/re-resolution.
          family: pinned.family,
          lookup: (_name, _options, callback) =>
            callback(null, pinned.address, pinned.family),
          rejectUnauthorized: true,
          maxHeaderSize: 8192,
          headers: {
            ...headers,
            'Content-Length': String(body.length),
            Connection: 'close',
          },
        },
        (response) => {
          let bytes = 0;
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            fail(
              new OutboundHttpError(
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
          if (length && Number(length) > options.maxResponseBytes)
            fail(new OutboundHttpError('response_too_large'));
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > options.maxResponseBytes)
              fail(new OutboundHttpError('response_too_large'));
          });
          response.on('end', () => {
            complete = true;
          });
          response.on('error', () => {
            fail(new OutboundHttpError('connection_failed', true));
          });
        },
      );
    } catch {
      reject(new OutboundHttpError('connection_failed', true));
      return;
    }
    request.on('error', () => {
      error ??= new OutboundHttpError('connection_failed', true);
    });
    request.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) error ??= outboundAbortError(signal);
      if (error) reject(error);
      else if (complete) resolve();
      else reject(new OutboundHttpError('connection_failed', true));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else request.end(body);
  });
}
