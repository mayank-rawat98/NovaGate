import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { WebSocketSettings } from '../../config/configuration';

export class WsFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: http.OutgoingHttpHeaders = {},
  ) {
    super(message);
  }
}
const invalid = () =>
  new WsFailure(400, 'WS_INVALID_UPGRADE', 'Invalid WebSocket upgrade');
const tokens = (value: string | string[] | undefined) =>
  typeof value === 'string'
    ? value.split(',').map((s) => s.trim().toLowerCase())
    : [];
export function wsHeaderBytes(
  headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders,
): number {
  return Object.entries(headers).reduce(
    (total, [name, value]) =>
      total +
      Buffer.byteLength(name) +
      Buffer.byteLength(String(value ?? '')) +
      4,
    2,
  );
}
export function wsHandshake(
  req: http.IncomingMessage,
  head: Buffer,
  settings: WebSocketSettings,
): string | undefined {
  if (
    Buffer.byteLength(req.url ?? '') +
      req.rawHeaders.reduce(
        (total, value) => total + Buffer.byteLength(value) + 2,
        2,
      ) >
    settings.maxHeaderBytes
  )
    throw new WsFailure(
      431,
      'WS_HEADERS_TOO_LARGE',
      'WebSocket headers exceed configured limit',
    );
  if (head.length > settings.maxBufferedHeadBytes)
    throw new WsFailure(
      413,
      'REQUEST_TOO_LARGE',
      'Buffered upgrade data exceeds configured limit',
    );
  const key = req.headers['sec-websocket-key'];
  if (
    req.method !== 'GET' ||
    req.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !tokens(req.headers.connection).includes('upgrade') ||
    req.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    Buffer.from(key, 'base64').length !== 16 ||
    Buffer.from(key, 'base64').toString('base64') !== key ||
    req.headers['transfer-encoding'] ||
    (req.headers['content-length'] && req.headers['content-length'] !== '0')
  )
    throw invalid();
  for (const name of [
    'authorization',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-protocol',
  ]) {
    if (
      req.rawHeaders.filter(
        (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name,
      ).length > 1
    )
      throw invalid();
  }
  const url = req.url ?? '/';
  if (!url.startsWith('/') || /[\r\n#]/.test(url)) throw invalid();
  const queryStart = url.indexOf('?');
  const path = queryStart < 0 ? url : url.slice(0, queryStart);
  const query = queryStart < 0 ? undefined : url.slice(queryStart + 1);
  let token: string | undefined;
  const retained: string[] = [];
  try {
    for (const part of query?.split('&') ?? []) {
      const separator = part.indexOf('=');
      const name = decodeURIComponent(
        (separator < 0 ? part : part.slice(0, separator)).replace(/\+/g, ' '),
      );
      if (name !== 'token') {
        retained.push(part);
        continue;
      }
      if (
        token !== undefined ||
        req.headers.authorization ||
        !settings.allowQueryToken
      )
        throw new WsFailure(
          401,
          'TOKEN_INVALID',
          'Query credentials are disabled or ambiguous',
        );
      token = decodeURIComponent(
        (separator < 0 ? '' : part.slice(separator + 1)).replace(/\+/g, ' '),
      );
      if (!token || /\s/.test(token)) throw invalid();
    }
  } catch (error) {
    if (error instanceof WsFailure) throw error;
    throw new WsFailure(400, 'TOKEN_INVALID', 'Malformed query credentials');
  }
  req.url = path + (retained.length ? `?${retained.join('&')}` : '');
  // Raw upgrades have no Express trust-proxy pipeline. Use only the socket peer.
  for (const name of Object.keys(req.headers)) {
    if (
      name === 'forwarded' ||
      name.startsWith('x-forwarded-') ||
      name === 'x-real-ip' ||
      name.startsWith('ssl_client_') ||
      name.startsWith('x-ssl-client-')
    )
      delete req.headers[name];
  }
  return token;
}
export function wsHeaders(
  headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders,
): http.OutgoingHttpHeaders {
  const stripped = new Set([
    'connection',
    'upgrade',
    'keep-alive',
    'proxy-connection',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'content-length',
    ...tokens(headers.connection as string),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined && !stripped.has(name.toLowerCase()),
    ),
  );
}
export function wsValidateResponse(
  response: http.IncomingMessage,
  key: string,
  protocols: string | undefined,
  extensions: string | undefined,
): void {
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  const selected = response.headers['sec-websocket-protocol'];
  const offeredExtensions = (extensions ?? '')
    .split(',')
    .map((item) => item.trim().split(';')[0]);
  const selectedExtensions = String(
    response.headers['sec-websocket-extensions'] ?? '',
  )
    .split(',')
    .filter(Boolean)
    .map((item) => item.trim().split(';')[0]);
  if (
    response.statusCode !== 101 ||
    response.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !tokens(response.headers.connection).includes('upgrade') ||
    response.headers['sec-websocket-accept'] !== accept ||
    (selected &&
      (typeof selected !== 'string' ||
        !protocols
          ?.split(',')
          .map((s) => s.trim())
          .includes(selected))) ||
    selectedExtensions.some((name) => !offeredExtensions.includes(name))
  )
    throw new WsFailure(
      502,
      'DOWNSTREAM_ERROR',
      'Upstream returned an invalid WebSocket handshake',
    );
}
export function wsSerialize(
  status: number,
  headers: http.OutgoingHttpHeaders,
): string {
  const lines = [`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}`];
  for (const [name, value] of Object.entries(headers)) {
    http.validateHeaderName(name);
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      http.validateHeaderValue(name, String(item));
      lines.push(`${name}: ${item}`);
    }
  }
  return lines.join('\r\n') + '\r\n\r\n';
}
