/** Database request-log retention, aged by trusted receipt time. */
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const MAX_LOG_RETENTION_DAYS = 90;
export interface LogRetentionCoverage {
  days: number;
  revision: string;
  /** Inclusive UTC receipt cutoff, preserving database microseconds. */
  receivedFrom: string;
  timeBasis: 'receipt';
}
export interface LogRetentionState extends LogRetentionCoverage {
  cleanup: 'pending' | 'retrying' | 'healthy';
  lastCheckedAt: string | null;
}
export interface SaveLogRetention {
  days: number;
  expectedRevision: string;
}
