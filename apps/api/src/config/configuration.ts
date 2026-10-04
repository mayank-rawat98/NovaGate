export const DEFAULT_UPSTREAM_HEALTH = {
  defaultIntervalMs: 10000,
  failureThreshold: 3,
  recoveryThreshold: 2,
  probeTimeoutMs: 3000,
  concurrency: 8,
  schedulerIntervalMs: 250,
  telemetryIntervalMs: 5000,
};
export type UpstreamHealthSettings = typeof DEFAULT_UPSTREAM_HEALTH;

export interface ProxyServiceConfig {
  name: string;
  targetUrl: string;
  pathPrefix: string;
}

export interface GatewayConfig {
  port: number;
  trustedProxies?: string[];
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
  };
  proxy: {
    timeout: number;
    services: ProxyServiceConfig[];
  };
  upstreamHealth: UpstreamHealthSettings;
  rateLimit: {
    windowMs: number;
    unauthMax: number;
    authMax: number;
  };
}

const parseProxyServices = (): ProxyServiceConfig[] => {
  const raw = process.env.PROXY_SERVICES ?? '[]';
  const parsed = JSON.parse(raw) as ProxyServiceConfig[];
  if (!Array.isArray(parsed)) {
    throw new Error('PROXY_SERVICES must be a JSON array');
  }
  return parsed;
};

export default (): GatewayConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10) || 3000,
  trustedProxies: (process.env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  redis: {
    url: process.env.REDIS_URL ?? '',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
  },
  proxy: {
    timeout: parseInt(process.env.PROXY_TIMEOUT_MS ?? '10000', 10) || 10000,
    services: parseProxyServices(),
  },
  upstreamHealth: {
    defaultIntervalMs: Number(
      process.env.HEALTH_DEFAULT_INTERVAL_MS ??
        DEFAULT_UPSTREAM_HEALTH.defaultIntervalMs,
    ),
    failureThreshold: Number(
      process.env.HEALTH_FAILURE_THRESHOLD ??
        DEFAULT_UPSTREAM_HEALTH.failureThreshold,
    ),
    recoveryThreshold: Number(
      process.env.HEALTH_RECOVERY_THRESHOLD ??
        DEFAULT_UPSTREAM_HEALTH.recoveryThreshold,
    ),
    probeTimeoutMs: Number(
      process.env.HEALTH_PROBE_TIMEOUT_MS ??
        DEFAULT_UPSTREAM_HEALTH.probeTimeoutMs,
    ),
    concurrency: Number(
      process.env.HEALTH_PROBE_CONCURRENCY ??
        DEFAULT_UPSTREAM_HEALTH.concurrency,
    ),
    schedulerIntervalMs: DEFAULT_UPSTREAM_HEALTH.schedulerIntervalMs,
    telemetryIntervalMs: DEFAULT_UPSTREAM_HEALTH.telemetryIntervalMs,
  },
  rateLimit: {
    windowMs:
      parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10) || 60000,
    unauthMax: parseInt(process.env.RATE_LIMIT_UNAUTH_MAX ?? '100', 10) || 100,
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? '500', 10) || 500,
  },
});
