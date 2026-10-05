/** Call only before opening an application stream. Trust errors are excluded. */
export function isHttp2NegotiationFallback(
  error: NodeJS.ErrnoException,
): boolean {
  return [
    'ERR_HTTP2_ERROR',
    'ERR_HTTP2_SESSION_ERROR',
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL',
  ].includes(error.code ?? '');
}
