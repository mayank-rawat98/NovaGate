import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { PluginContext } from '@api-gateway/shared-types';
import { RequestBodyService } from './request-body.service';

function requestContext(plugins: PluginContext['route']['plugins'] = []): {
  ctx: PluginContext;
  stream: PassThrough;
  response: EventEmitter;
} {
  const stream = new PassThrough();
  Object.assign(stream, { headers: {} });
  const response = new EventEmitter();
  return {
    stream,
    response,
    ctx: {
      req: stream as unknown as PluginContext['req'],
      res: response as unknown as PluginContext['res'],
      route: {
        id: 'route',
        method: 'POST',
        pathPattern: '/',
        serviceId: 'service',
        enabled: true,
        authRequired: false,
        plugins,
      },
      tenantId: 'tenant',
      requestId: 'fixture',
      service: undefined,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    },
  };
}
describe('shared bounded request body capture', () => {
  it('shares one original byte capture across different body readers and keeps capacity through response', async () => {
    const reader = new RequestBodyService(
      new ConfigService({ bodyCapture: { maxPendingRequests: 1 } }),
    );
    const first = requestContext();
    const one = reader.read(first.ctx),
      two = reader.read(first.ctx);
    const body = Buffer.from([0, 255, 128, 1]);
    first.stream.end(body);
    expect(await one).toEqual(body);
    expect(await two).toEqual(body);
    const second = requestContext();
    await expect(reader.read(second.ctx)).rejects.toMatchObject({
      status: 503,
    });
    first.response.emit('finish');
    first.response.emit('close');
    const next = reader.read(second.ctx);
    second.stream.end('next');
    expect((await next).toString()).toBe('next');
    second.response.emit('finish');
    first.stream.destroy();
    second.stream.destroy();
  });
  it('uses the smallest HMAC/GraphQL/route/global byte limit before any ordered reader', async () => {
    const reader = new RequestBodyService(
      new ConfigService({
        hmac: { maxBodyBytes: 4 },
        graphql: { maxBodyBytes: 8 },
        bodyCapture: { maxBodyBytes: 16 },
      }),
    );
    const fixture = requestContext([
      { name: 'request-size-limit', config: { maxBodyBytes: 32 } },
      { name: 'graphql-guard', config: {} },
      { name: 'hmac-auth', config: {} },
    ]);
    const body = reader.read(fixture.ctx);
    fixture.stream.end('12345');
    await expect(body).rejects.toMatchObject({ status: 413 });
    expect(fixture.stream.listenerCount('data')).toBe(0);
    fixture.stream.destroy();
  });
  it('bounds stalled uploads by an absolute deadline and recovers admission', async () => {
    const reader = new RequestBodyService(
      new ConfigService({
        bodyCapture: { timeoutMs: 100, maxPendingRequests: 1 },
      }),
    );
    const first = requestContext();
    const body = reader.read(first.ctx);
    first.stream.write('partial');
    await expect(body).rejects.toMatchObject({ status: 408 });
    expect(first.stream.listenerCount('data')).toBe(0);
    const second = requestContext();
    const next = reader.read(second.ctx);
    second.stream.end('next');
    expect((await next).toString()).toBe('next');
    second.response.emit('finish');
    first.stream.destroy();
    second.stream.destroy();
  });
  it('releases on cancellation without leaving listeners or admitting the aborted bytes', async () => {
    const reader = new RequestBodyService(
      new ConfigService({ bodyCapture: { maxPendingRequests: 1 } }),
    );
    const fixture = requestContext();
    const controller = new AbortController();
    fixture.ctx.signal = controller.signal;
    const body = reader.read(fixture.ctx);
    fixture.stream.write('partial');
    controller.abort();
    await expect(body).rejects.toMatchObject({ status: 400 });
    expect(fixture.stream.listenerCount('data')).toBe(0);
    fixture.response.emit('close');
    const next = requestContext();
    const bytes = reader.read(next.ctx);
    next.stream.end('next');
    expect((await bytes).toString()).toBe('next');
    next.response.emit('finish');
    fixture.stream.destroy();
    next.stream.destroy();
  });
  it('rejects over-limit cached bodies and malformed route limits', async () => {
    const reader = new RequestBodyService(
      new ConfigService({ bodyCapture: { maxBodyBytes: 4 } }),
    );
    const cached = requestContext();
    Object.assign(cached.ctx.req, { rawBody: Buffer.from('12345') });
    await expect(reader.read(cached.ctx)).rejects.toMatchObject({
      status: 413,
    });
    const invalid = requestContext([
      { name: 'request-size-limit', config: { maxBodyBytes: -1 } },
    ]);
    await expect(reader.read(invalid.ctx)).rejects.toMatchObject({
      status: 500,
    });
    cached.stream.destroy();
    invalid.stream.destroy();
  });
});
