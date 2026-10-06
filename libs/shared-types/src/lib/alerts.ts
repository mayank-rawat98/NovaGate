/** Public alert contracts. Credential values exist only in write requests. */
export const ALERT_METRICS = [
  'error_rate',
  'p95_latency_ms',
  'rps',
  'downstream_timeout_rate',
] as const;
export const ALERT_OPERATORS = ['>', '<', '>=', '<='] as const;
export const MAX_ALERT_RULES_PER_TENANT = 100;
export const MAX_ALERT_CHANNELS_PER_TENANT = 16;
export const MAX_CHANNELS_PER_ALERT_RULE = 5;
export const MAX_ALERT_WINDOW_MINUTES = 60;
export const MAX_ALERT_NAME_LENGTH = 100;
export const MAX_ALERT_MIN_REQUESTS = 1000000;
export type AlertMetric = (typeof ALERT_METRICS)[number];
export type AlertOperator = (typeof ALERT_OPERATORS)[number];
export type AlertChannelType = 'webhook' | 'email' | 'slack';
export interface AlertRuleConfig {
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  minRequests: number;
  channelIds: string[];
  enabled: boolean;
}
export type CreateAlertRuleDto = Omit<
  AlertRuleConfig,
  'enabled' | 'minRequests'
> &
  Partial<Pick<AlertRuleConfig, 'enabled' | 'minRequests'>>;
export type UpdateAlertRuleDto = CreateAlertRuleDto & { revision: number };
export interface AlertEvaluation {
  state: 'ok' | 'firing' | 'no_data';
  value: number | null;
  requestCount: number;
  coverage: number;
  evaluatedAt: string;
}
export interface AlertRule extends AlertRuleConfig {
  id: string;
  revision: number;
  evaluation: AlertEvaluation | null;
  createdAt: string;
  updatedAt: string;
}
export interface AlertChannel {
  id: string;
  name: string;
  type: AlertChannelType;
  /** Display-safe destination: webhook origin or email recipient, never secret URL paths. */
  destination: string;
  hasSecret: boolean;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type CreateAlertChannelDto = {
  name: string;
  enabled?: boolean;
} & (
  | { type: 'webhook'; url: string; secret: string }
  | { type: 'slack'; webhookUrl: string }
  | { type: 'email'; address: string }
);
/** Metadata edits keep credentials; replacing them is an explicit complete write. */
export type UpdateAlertChannelDto = {
  name: string;
  enabled: boolean;
  revision: number;
  credentials?:
    | { type: 'webhook'; url: string; secret: string }
    | { type: 'slack'; webhookUrl: string }
    | { type: 'email'; address: string };
};
export type AlertDeliveryState =
  | 'queued'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'cancelled';
export interface AlertDelivery {
  id: string;
  channelId: string | null;
  channelName: string;
  type: AlertChannelType;
  status: AlertDeliveryState;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
}
export interface AlertEvent {
  id: string;
  ruleId: string | null;
  ruleName: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  windowMinutes: number;
  state: 'firing' | 'resolved';
  value: number;
  createdAt: string;
  deliveries: AlertDelivery[];
}
export interface AlertConfiguration {
  rules: AlertRule[];
  channels: AlertChannel[];
  deliveryEnabled: boolean;
}

/** Stable delivery ID allows receivers to deduplicate retry/recovery deliveries. */
export interface AlertWebhookPayload {
  version: 1;
  deliveryId: string;
  tenantId: string;
  event: Omit<AlertEvent, 'deliveries'>;
}
