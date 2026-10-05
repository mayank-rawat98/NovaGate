import { GatewayTimeoutException, type ArgumentsHost } from '@nestjs/common';
import { GatewayExceptionFilter } from './gateway-exception.filter';
import { GatewayError } from './gateway-error';
import type { GatewayTelemetryService } from '../telemetry/gateway-telemetry.service';

describe('Final HTTP failure attribution', () => {
  it.each([
    [new GatewayTimeoutException('Timed out'), 'DOWNSTREAM_TIMEOUT', 504],
    [
      new GatewayError('DOWNSTREAM_TIMEOUT', 'Timed out', 504),
      'DOWNSTREAM_TIMEOUT',
      504,
    ],
    [
      new GatewayError('DOWNSTREAM_ERROR', 'Failed', 502),
      'DOWNSTREAM_ERROR',
      502,
    ],
  ])(
    'sets the error code before completing the response: %p',
    (error, code, status) => {
      const sendError = jest.fn();
      const filter = new GatewayExceptionFilter({
        sendError,
      } as unknown as GatewayTelemetryService);
      const response = {
        locals: {} as Record<string, unknown>,
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(() => {
          expect(response.locals.errorCode).toBe(code);
        }),
      };
      const host = {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => ({ headers: {} }),
        }),
      } as ArgumentsHost;
      filter.catch(error, host);
      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.json).toHaveBeenCalledTimes(1);
      expect(sendError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: code }),
      );
    },
  );
});
