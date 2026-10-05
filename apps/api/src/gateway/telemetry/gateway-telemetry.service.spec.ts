import { Logger } from '@nestjs/common';
import type { RequestLog } from '@api-gateway/shared-types';
import { GatewayTelemetryService } from './gateway-telemetry.service';
import type { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';

const log: RequestLog = {
  id: 'fixture',
  method: 'GET',
  path: '/users/:id',
  statusCode: 200,
  responseTimeMs: 1,
  requestId: 'fixture',
  clientIp: '127.0.0.1',
  timestamp: '2026-10-05T00:00:00Z',
};
describe('bounded telemetry flush lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('starts one flush timer and clears it while flushing remaining logs on shutdown', () => {
    const connector = { send: jest.fn() };
    const service = new GatewayTelemetryService(
      connector as unknown as ControlPlaneConnectorService,
    );
    service.onModuleInit();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    service.logRequest(log);
    jest.advanceTimersByTime(500);
    expect(connector.send).toHaveBeenCalledWith({
      type: 'logs',
      payload: [log],
    });
    service.logRequest(log);
    service.onModuleDestroy();
    expect(connector.send).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    service.logRequest(log);
    service.onModuleInit();
    jest.advanceTimersByTime(1000);
    expect(connector.send).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('flushes at the batch bound and cannot throw connector failures into the response path', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const connector = {
      send: jest.fn().mockImplementation(() => {
        throw new Error('private');
      }),
    };
    const service = new GatewayTelemetryService(
      connector as unknown as ControlPlaneConnectorService,
    );
    for (let i = 0; i < 99; i++) service.logRequest(log);
    expect(connector.send).not.toHaveBeenCalled();
    expect(() => service.logRequest(log)).not.toThrow();
    expect(connector.send).toHaveBeenCalledTimes(1);
    service.logRequest(log);
    service.onModuleInit();
    expect(() => jest.advanceTimersByTime(500)).not.toThrow();
    expect(connector.send).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
