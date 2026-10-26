export interface LogExportSelection {
  minStatusCode?: number;
  pathPrefix?: string;
  consumerId?: string;
}
export interface LogExportFilter extends LogExportSelection {
  from: string;
  to: string;
}

/** Receipt windows are independent of the gateway's request clock. */
export type LogExportTimeBasis = 'request' | 'receipt';
export type LogExportCadence = 'near_real_time' | 'hourly';
export interface LogExportScheduleConfiguration {
  enabled: boolean;
  cadence: LogExportCadence;
  filter: LogExportSelection;
}
export interface LogExportSchedule extends LogExportScheduleConfiguration {
  id: string;
  revision: string;
  startedAt: string;
  cursor: string;
  nextWindowAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastJobId?: string;
  error?: string;
  /** Receipt windows partially or wholly outside retained coverage before selection. */
  retentionSkippedWindows?: number;
}
export interface LogExportScheduleState {
  available: boolean;
  schedule: LogExportSchedule | null;
  settlementSeconds: number;
  pendingJobs: number;
  failedJobs: number;
  backlogSeconds: number;
  queueLimit: number;
}
export interface SaveLogExportSchedule extends LogExportScheduleConfiguration {
  /** null creates; the last fetched revision updates without overwriting others. */
  expectedRevision: string | null;
}

export type LogExportStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired';
export interface LogExportJob {
  retention?: import('./log-retention.ts').LogRetentionCoverage;
  id: string;
  status: LogExportStatus;
  filter: LogExportFilter;
  attempts: number;
  retryCount: number;
  rowCount: number;
  bytes: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
  expiresAt: string;
  kind: 'manual' | 'scheduled';
  timeBasis: LogExportTimeBasis;
  scheduleId?: string;
}
export interface LogExportList {
  enabled: boolean;
  jobs: LogExportJob[];
  retentionDays: number;
}
