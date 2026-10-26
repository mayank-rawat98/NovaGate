import {
  validateTracingConfiguration,
  DEFAULT_TRACE_INGESTION,
  DEFAULT_SOCKET_ADMISSION,
} from './tracing.configuration';
describe('control-plane tracing and admission budgets', () => {
  it('provides finite defaults', () => {
    const config = validateTracingConfiguration({});
    expect(config.traceIngestion).toEqual(DEFAULT_TRACE_INGESTION);
    expect(config.socketAdmission).toEqual(DEFAULT_SOCKET_ADMISSION);
  });
  it.each([
    { TRACE_INGESTION_MAX_CONCURRENT: 0 },
    { TRACE_MAX_ROWS_PER_TENANT: 'unlimited' },
    { TRACE_RETENTION_DAYS: 31 },
    { TRACE_INGESTION_STATEMENT_TIMEOUT_MS: 99 },
    { CONTROL_PLANE_MAX_MESSAGE_BYTES: 1048577 },
    { CONTROL_PLANE_MAX_QUEUED_MESSAGES: 1.5 },
    { CONTROL_PLANE_MAX_QUEUED_BYTES: -1 },
    { CONTROL_PLANE_MAX_CONNECTIONS: 0 },
  ])('rejects invalid budgets %j', (config) =>
    expect(() => validateTracingConfiguration(config)).toThrow('Invalid'),
  );
});
