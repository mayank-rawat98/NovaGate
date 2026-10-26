/** @jest-environment node */
import { streamMetrics } from './api-client';
import { getToken } from './auth';
jest.mock('./auth', () => ({
  getToken: jest.fn().mockReturnValue('fixture-session'),
  clearToken: jest.fn(),
}));
const sample = {
  rps: 1.25,
  p50Ms: 1,
  p95Ms: 2,
  p99Ms: 3,
  errorRate: 0,
  timestamp: new Date().toISOString(),
};
describe('Authenticated bounded metric SSE parsing', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  function wire(chunks: string[]) {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks)
              controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  }
  it('handles arbitrary chunk/CRLF boundaries and heartbeat comments while attaching the session header', async () => {
    const frame = `: heartbeat\r\n\r\nevent: metrics\r\ndata: ${JSON.stringify(sample)}\r\n\r\n`;
    wire([...frame]);
    const received = jest.fn();
    await expect(
      streamMetrics(
        'tenant',
        new AbortController().signal,
        received,
        jest.fn(),
      ),
    ).rejects.toThrow('ended');
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(sample);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.not.stringContaining('fixture-session'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture-session',
          Accept: 'text/event-stream',
        }),
      }),
    );
    expect(getToken).toHaveBeenCalled();
  });
  it.each([
    `event: metrics\ndata: ${JSON.stringify({ ...sample, rps: -1 })}\n\n`,
    `event: metrics\ndata: ${JSON.stringify({ ...sample, timestamp: 'invalid' })}\n\n`,
    'event: metrics\ndata: invalid\n\n',
    'x'.repeat(4097),
  ])(
    'rejects invalid or oversized frames instead of rendering them',
    async (frame) => {
      wire([frame]);
      const received = jest.fn();
      await expect(
        streamMetrics(
          'tenant',
          new AbortController().signal,
          received,
          jest.fn(),
        ),
      ).rejects.toThrow();
      expect(received).not.toHaveBeenCalled();
    },
  );
});
