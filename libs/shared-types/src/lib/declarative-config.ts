import type { ServiceConfig, RouteConfig } from './ws-messages.ts';

export const DECLARATIVE_CONFIG_MAX_BYTES = 65536;
export const DECLARATIVE_CONFIG_MAX_ENTRIES = 200;
export const CONFIG_PREVIEW_TTL_SECONDS = 600;

/** Complete desired configuration. References use unique service names. */
export interface DeclarativeConfig {
  version: 1;
  services: Array<Omit<ServiceConfig, 'id'>>;
  routes: Array<
    Omit<RouteConfig, 'id' | 'acl' | 'retry'> & {
      retry?: RouteConfig['retry'] | null;
    }
  >;
  consumers: Array<{
    name: string;
    rateLimitTier?: string;
    groups?: string[];
  }>;
}
export interface ConfigChange {
  resource: 'service' | 'route' | 'consumer';
  key: string;
  action: 'create' | 'update' | 'remove';
  /** Names only; never credential values, hashes or full configuration. */
  fields: string[];
}
export interface ConfigPreview {
  dryRun: true;
  revision: string;
  expiresAt: string;
  configVersion: number;
  changes: ConfigChange[];
  unchanged: number;
  warnings: string[];
}
export interface ConfigApplyResult {
  dryRun: false;
  configVersion: number;
  changed: number;
  delivery: 'queued' | 'unchanged';
  /** Returned only on creation; plaintext is never persisted. */
  consumerKeys: Array<{ id: string; name: string; apiKey: string }>;
}
