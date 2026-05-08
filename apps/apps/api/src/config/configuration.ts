export interface ProxyServiceConfig {
  name: string;
  targetUrl: string;
  pathPrefix: string;
}

export interface GatewayConfig {
  port: number;
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
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10) || 60000,
    unauthMax: parseInt(process.env.RATE_LIMIT_UNAUTH_MAX ?? '100', 10) || 100,
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX ?? '500', 10) || 500,
  },
});
