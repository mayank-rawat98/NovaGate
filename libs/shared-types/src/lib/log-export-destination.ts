/** Write-only connection details. These never appear in a destination read. */
export type LogExportDestinationCredentials =
  | {
      type: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      forcePathStyle: boolean;
    }
  | { type: 'webhook'; url: string; signingSecret: string }
  | { type: 'datadog'; site: DatadogLogSite; apiKey: string };

export const DATADOG_LOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com',
  'ddog-gov.com',
  'us2.ddog-gov.com',
] as const;
export type DatadogLogSite = (typeof DATADOG_LOG_SITES)[number];
export type LogExportDestinationType = LogExportDestinationCredentials['type'];
export interface CreateLogExportDestination {
  name: string;
  credentials: LogExportDestinationCredentials;
}
export interface UpdateLogExportDestination {
  name: string;
  expectedRevision: string;
  /** Omit to retain; replacement is complete and keeps the provider type. */
  credentials?: LogExportDestinationCredentials;
}
export interface LogExportDestination {
  id: string;
  revision: string;
  name: string;
  type: LogExportDestinationType;
  /** Origin/site only: never includes a URL path, query, token or access key. */
  destination: string;
  state: 'draft';
  credentialStatus: 'available' | 'unavailable';
  createdAt: string;
  updatedAt: string;
}
export interface LogExportDestinationList {
  configurationAvailable: boolean;
  /** Drafts cannot send until bounded provider delivery is implemented. */
  deliveryAvailable: false;
  limit: number;
  destinations: LogExportDestination[];
}
