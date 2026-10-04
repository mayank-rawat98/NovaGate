import * as http from 'node:http';
import { DEFAULT_WEBSOCKET } from '../../config/configuration';
import { WsFailure, wsHandshake } from './ws-wire';

function request(url: string) {
  return {
    method: 'GET',
    url,
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'),
      'sec-websocket-version': '13',
    },
    rawHeaders: [],
  } as unknown as http.IncomingMessage;
}
describe('WebSocket upgrade credential validation', () => {
  it.each([
    '/ws?token=%QQ',
    '/ws?token=%E0%A4%A',
    '/ws?token=',
    '/ws?token=a&token=b',
  ])(
    'rejects malformed or ambiguous query credentials without an uncaught decode error: %s',
    (url) => {
      expect(() =>
        wsHandshake(request(url), Buffer.alloc(0), {
          ...DEFAULT_WEBSOCKET,
          allowQueryToken: true,
        }),
      ).toThrow(WsFailure);
    },
  );
  it('strips only query credentials and preserves signed query bytes', () => {
    const req = request('/ws?signature=a%2fb&token=secret&other=x+y');
    expect(
      wsHandshake(req, Buffer.alloc(0), {
        ...DEFAULT_WEBSOCKET,
        allowQueryToken: true,
      }),
    ).toBe('secret');
    expect(req.url).toBe('/ws?signature=a%2fb&other=x+y');
  });
  it('rejects coalesced bytes before dispatch', () => {
    expect(() =>
      wsHandshake(request('/ws'), Buffer.alloc(2), {
        ...DEFAULT_WEBSOCKET,
        maxBufferedHeadBytes: 1,
      }),
    ).toThrow('Buffered upgrade data');
  });
});
