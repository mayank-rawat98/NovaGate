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
  /** Configuration state; enabled never establishes provider indexing or health. */
  state: 'draft' | 'enabled' | 'paused';
  credentialStatus: 'available' | 'unavailable';
  createdAt: string;
  updatedAt: string;
}
export interface LogExportDestinationList {
  configurationAvailable: boolean;
  /** Installation capability; saving credentials never enables a schedule. */
  deliveryAvailable: boolean;
  limit: number;
  destinations: LogExportDestination[];
}

/** Explicit wire fields only; receipt metadata and arbitrary database columns are excluded. */
export type LogExportRecord = import('./ws-messages.ts').RequestLog;
/** One immutable worker batch. Retries retain deliveryId and privacy-projected records. */
export interface LogExportDeliveryBatch {
  version: 1;
  tenantId: string;
  destinationId: string;
  deliveryId: string;
  records: LogExportRecord[];
  /** Tenant privacy is mandatory; a destination may only further omit fields. */
  privacy: import('./log-privacy.ts').LogPrivacyPolicy;
  payloadPrivacy?: import('./log-privacy.ts').LogPrivacyPolicy;
}

export type LogExportDeliveryStatus =
  | 'queued'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'expired';
/** Payloads, source IDs, credentials and provider responses never appear in history. */
export interface LogExportDelivery {
  id: string;
  destinationId: string;
  source: 'scheduled' | 'selected_records';
  status: LogExportDeliveryStatus;
  attempts: number;
  recordCount: number;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  nextAttemptAt: string;
  error?: string;
}

/** Cumulative workspace counts for scheduled terminal metadata removed from history.
 * Decimal strings preserve PostgreSQL BIGINT values without JavaScript rounding. */
export interface LogExportDeliveryHistory {
  deliveries: LogExportDelivery[];
  coverage: {
    scope: 'workspace';
    retentionHours: number;
    scheduledTerminalLimit: number;
    readLimit: number;
    prunedScheduledBatches: {
      delivered: string;
      failed: string;
      expired: string;
    };
    prunedScheduledRecords: {
      delivered: string;
      failed: string;
      expired: string;
    };
    lastPrunedAt?: string;
  };
}

export interface LogExportDeliveryScheduleConfiguration {
  enabled: boolean;
  cadence: import('./log-export.ts').LogExportCadence;
  filter: import('./log-export.ts').LogExportSelection;
  payloadPrivacy: import('./log-privacy.ts').LogPrivacyPolicy;
}
export interface SaveLogExportDeliverySchedule
  extends LogExportDeliveryScheduleConfiguration {
  expectedRevision: string | null;
  expectedDestinationRevision: string;
}
export interface LogExportDeliverySchedule
  extends LogExportDeliveryScheduleConfiguration {
  destinationId: string;
  destinationRevision: string;
  revision: string;
  startedAt: string;
  cursor: string;
  nextWindowAt: string;
  lastCheckedAt?: string;
  admittedRecords: number;
  filteredRecords: number;
  invalidRecords: number;
  /** Duration of unprocessed receipt coverage lost to retention; not a row count. */
  retentionSkippedSeconds: number;
  error?: string;
}

export interface LogExportDeliveryState {
  available: boolean;
  credentialStatus: 'available' | 'unavailable';
  destinationRevision: string;
  schedule: LogExportDeliverySchedule | null;
  tenantPrivacy: import('./log-privacy.ts').LogPrivacyPolicy;
  retentionDays: number;
  receiptFloor: string;
  pendingBatches: number;
  processingBatches: number;
  limits: {
    pendingBatches: number;
    settlementSeconds: number;
    maxAttempts: number;
    payloadLifetimeHours: number;
  };
}
export interface RemoveLogExportDeliverySchedule {
  expectedRevision: string;
  expectedDestinationRevision: string;
}
