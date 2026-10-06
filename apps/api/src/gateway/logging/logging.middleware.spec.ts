import {
  logPrivacyPolicy,
  redactRequestLog,
  stricterLogPrivacy,
  validateLogPrivacy,
} from '@api-gateway/shared-types';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import { LoggingMiddleware } from './logging.middleware';
import type { MetricsService } from '../metrics/metrics.service';
import type { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';
import type {
  RequestWithUser,
  ResponseWithLocals,
} from '../shared/request-context';

describe('HTTP response lifetime observation', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());
  function fixture(
    getTenantId: () => string | null = () => null,
    getConfig = () => ({ logPrivacy: logPrivacyPolicy(undefined) }),
  ) {
    const metrics = {
      incrementActiveConnections: jest.fn(),
      decrementActiveConnections: jest.fn(),
      incrementHttpRequests: jest.fn(),
      observeRequestDuration: jest.fn(),
      recordCompletedHttp: jest.fn(),
    };
    const telemetry = { logRequest: jest.fn() };
    const middleware = new LoggingMiddleware(
      metrics as unknown as MetricsService,
      telemetry as unknown as GatewayTelemetryService,
      undefined,
      { getTenantId, getConfig } as unknown as GatewayConfigManagerService,
    );
    const req = {
      method: 'GET',
      headers: {
        'x-request-id': 'private-token',
        'user-agent': 'private-agent',
      },
      originalUrl: '/users/private?token=secret',
      ip: '127.0.0.1',
    } as unknown as RequestWithUser;
    const res = Object.assign(new EventEmitter(), {
      locals: {},
      setHeader: jest.fn(),
      statusCode: 200,
      writableFinished: false,
    }) as unknown as ResponseWithLocals;
    const next = jest.fn();
    middleware.use(req, res, next);
    return { middleware, metrics, telemetry, req, res, next };
  }
  it('defaults to omitted observation fields without altering security inputs', () => {
    const f = fixture();
    f.res.emit('finish');
    const entry = f.telemetry.logRequest.mock.calls[0][0];
    expect(entry.clientIp).toBe('[redacted]');
    expect(entry).not.toHaveProperty('userAgent');
    expect(f.req.ip).toBe('127.0.0.1');
    expect(f.req.headers['user-agent']).toBe('private-agent');
    const output = jest
      .mocked(Logger.prototype.log)
      .mock.calls.map((call) => call[0])
      .join('');
    expect(output).not.toContain('127.0.0.1');
    expect(output).not.toContain('private-agent');
  });
  it('captures only explicitly retained bounded fields and tightens unfinished requests', () => {
    let policy: { clientIp: 'retain' | 'omit'; userAgent: 'retain' | 'omit' } =
      { clientIp: 'retain', userAgent: 'retain' };
    const f = fixture(
      () => 'tenant',
      () => ({ logPrivacy: policy }),
    );
    f.res.emit('finish');
    expect(f.telemetry.logRequest.mock.calls[0][0]).toMatchObject({
      clientIp: '127.0.0.1',
      userAgent: 'private-agent',
    });
    const running = fixture(
      () => 'tenant',
      () => ({ logPrivacy: policy }),
    );
    policy = { clientIp: 'omit', userAgent: 'omit' };
    running.res.emit('finish');
    expect(running.telemetry.logRequest.mock.calls[0][0]).toMatchObject({
      clientIp: '[redacted]',
    });
    expect(running.telemetry.logRequest.mock.calls[0][0]).not.toHaveProperty(
      'userAgent',
    );
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { clientIp: 'retain', userAgent: 'invalid' },
    { clientIp: 'retain', userAgent: 'retain', extra: true },
  ])('fails closed for legacy or malformed privacy policies: %#', (value) => {
    expect(logPrivacyPolicy(value)).toEqual({
      clientIp: 'omit',
      userAgent: 'omit',
    });
    expect(() => validateLogPrivacy(value)).toThrow();
    const raw = {
      clientIp: 'private-ip',
      userAgent: 'private-agent',
      consumerId: 'consumer',
      path: '/safe',
    };
    expect(redactRequestLog(raw, value)).toEqual({
      clientIp: '[redacted]',
      consumerId: 'consumer',
      path: '/safe',
    });
    expect(raw.clientIp).toBe('private-ip');
  });
  it('uses omission when either request-start or request-finish policy omits a field', () => {
    expect(
      stricterLogPrivacy(
        { clientIp: 'retain', userAgent: 'omit' },
        { clientIp: 'omit', userAgent: 'retain' },
      ),
    ).toEqual({ clientIp: 'omit', userAgent: 'omit' });
  });
  it('does not label an arbitrary authenticated principal as a registered consumer', () => {
    const f = fixture();
    f.req.user = { id: 'external-user-fixture' };
    Object.assign(f.res, { writableFinished: true });
    f.res.emit('finish');
    expect(f.telemetry.logRequest.mock.calls[0][0]).not.toHaveProperty(
      'consumerId',
    );
    expect(f.req.user.id).toBe('external-user-fixture');
  });
  it('records captured consumer attribution while retaining the original authentication identity', () => {
    const f = fixture();
    const id = '56789012-1234-1234-1234-123456789abc';
    f.req.user = { id: 'external-user-fixture', consumerId: id.toUpperCase() };
    Object.assign(f.res, { writableFinished: true });
    f.res.emit('finish');
    expect(f.telemetry.logRequest.mock.calls[0][0].consumerId).toBe(id);
    expect(f.req.user.id).toBe('external-user-fixture');
  });
  it('reports only at completion and retains the original request tenant through replacement', () => {
    let tenant = 'original';
    const f = fixture(() => tenant);
    expect(f.metrics.recordCompletedHttp).not.toHaveBeenCalled();
    tenant = 'replacement';
    f.res.statusCode = 503;
    Object.assign(f.res, { writableFinished: true });
    f.res.emit('finish');
    f.res.emit('close');
    expect(f.metrics.recordCompletedHttp).toHaveBeenCalledTimes(1);
    expect(f.metrics.recordCompletedHttp).toHaveBeenCalledWith(
      503,
      expect.any(Number),
      'original',
      false,
    );
  });
  it('attributes the final downstream timeout once at response completion', () => {
    const f = fixture(() => 'tenant');
    f.res.locals.errorCode = 'DOWNSTREAM_TIMEOUT';
    f.res.statusCode = 504;
    Object.assign(f.res, { writableFinished: true });
    f.res.emit('finish');
    f.res.emit('close');
    expect(f.metrics.recordCompletedHttp).toHaveBeenCalledTimes(1);
    expect(f.metrics.recordCompletedHttp).toHaveBeenCalledWith(
      504,
      expect.any(Number),
      'tenant',
      true,
    );
  });
  it('holds active accounting until response finish and records the final filter status once', () => {
    const f = fixture();
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.metrics.incrementActiveConnections).toHaveBeenCalledTimes(1);
    expect(f.telemetry.logRequest).not.toHaveBeenCalled();
    f.res.locals.routePattern = '/users/:id';
    f.res.statusCode = 500;
    Object.defineProperty(f.res, 'writableFinished', { value: true });
    f.res.emit('finish');
    f.res.emit('close');
    expect(f.metrics.decrementActiveConnections).toHaveBeenCalledTimes(1);
    expect(f.telemetry.logRequest).toHaveBeenCalledTimes(1);
    expect(
      Number.isInteger(f.telemetry.logRequest.mock.calls[0][0].responseTimeMs),
    ).toBe(true);
    expect(f.metrics.incrementHttpRequests).toHaveBeenCalledWith(
      'GET',
      '/users/:id',
      500,
    );
    expect(f.res.listenerCount('finish')).toBe(0);
    expect(f.res.listenerCount('close')).toBe(0);
    expect(JSON.stringify(f.telemetry.logRequest.mock.calls)).not.toMatch(
      /private|secret|user-agent/,
    );
  });
  it('classifies a response closed before finish as incomplete rather than a successful 200', () => {
    const f = fixture();
    f.res.emit('close');
    f.res.emit('finish');
    expect(f.metrics.incrementHttpRequests).toHaveBeenCalledWith(
      'GET',
      'unmatched',
      499,
    );
    expect(f.metrics.decrementActiveConnections).toHaveBeenCalledTimes(1);
    expect(f.telemetry.logRequest).toHaveBeenCalledTimes(1);
  });
  it('does not attach duplicate observation when invoked twice', () => {
    const f = fixture();
    f.middleware.use(f.req, f.res, f.next);
    f.res.emit('close');
    expect(f.metrics.incrementActiveConnections).toHaveBeenCalledTimes(1);
    expect(f.telemetry.logRequest).toHaveBeenCalledTimes(1);
    expect(f.next).toHaveBeenCalledTimes(2);
  });
  it('uses monotonic duration despite wall-clock changes and bounds method labels', () => {
    const f = fixture();
    f.req.method = 'CUSTOM_PRIVATE_METHOD';
    jest.spyOn(Date, 'now').mockReturnValue(-1e12);
    f.res.emit('close');
    expect(f.metrics.observeRequestDuration).toHaveBeenCalledWith(
      'OTHER',
      'unmatched',
      expect.any(Number),
    );
    expect(
      f.telemetry.logRequest.mock.calls[0][0].responseTimeMs,
    ).toBeGreaterThanOrEqual(0);
    expect(f.telemetry.logRequest.mock.calls[0][0].responseTimeMs).toBeLessThan(
      1000,
    );
  });
  it('isolates failed observation operations and still releases accounting', () => {
    const f = fixture();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    f.metrics.incrementHttpRequests.mockImplementation(() => {
      throw new Error('private');
    });
    f.telemetry.logRequest.mockImplementation(() => {
      throw new Error('private');
    });
    expect(() => f.res.emit('close')).not.toThrow();
    expect(f.metrics.decrementActiveConnections).toHaveBeenCalledTimes(1);
    expect(f.metrics.observeRequestDuration).toHaveBeenCalledTimes(1);
  });
});
