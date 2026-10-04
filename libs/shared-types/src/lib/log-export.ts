export interface LogExportFilter {
  from: string;
  to: string;
  minStatusCode?: number;
  pathPrefix?: string;
  consumerId?: string;
}

export type LogExportStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired';
export interface LogExportJob {
  id: string;
  status: LogExportStatus;
  filter: LogExportFilter;
  attempts: number;
  rowCount: number;
  bytes: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
  expiresAt: string;
}
export interface LogExportList {
  enabled: boolean;
  jobs: LogExportJob[];
  retentionDays: number;
}
