import Joi from 'joi';
import { DEFAULT_UPSTREAM_HEALTH, DEFAULT_GRPC } from './configuration';
import { BlockList, isIP } from 'net';

export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  TRUSTED_PROXY_CIDRS: Joi.string()
    .allow('')
    .default('')
    .custom((value: string, helpers) => {
      try {
        for (const cidr of value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)) {
          const [address, prefix] = cidr.split('/');
          const version = isIP(address);
          if (!version || cidr.split('/').length > 2)
            return helpers.error('any.invalid');
          const type = version === 4 ? 'ipv4' : 'ipv6';
          const list = new BlockList();
          if (prefix === undefined) list.addAddress(address, type);
          else {
            if (!/^\d+$/.test(prefix)) return helpers.error('any.invalid');
            list.addSubnet(address, Number(prefix), type);
          }
        }
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }),
  HEALTH_DEFAULT_INTERVAL_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60000)
    .default(DEFAULT_UPSTREAM_HEALTH.defaultIntervalMs),
  HEALTH_FAILURE_THRESHOLD: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(DEFAULT_UPSTREAM_HEALTH.failureThreshold),
  HEALTH_RECOVERY_THRESHOLD: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(DEFAULT_UPSTREAM_HEALTH.recoveryThreshold),
  HEALTH_PROBE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(100)
    .max(10000)
    .default(DEFAULT_UPSTREAM_HEALTH.probeTimeoutMs),
  HEALTH_PROBE_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(64)
    .default(DEFAULT_UPSTREAM_HEALTH.concurrency),
  GRPC_ENABLED: Joi.string().valid('true', 'false').default('false'),
  GRPC_ALLOW_INSECURE: Joi.string().valid('true', 'false').default('false'),
  GRPC_HOST: Joi.alternatives()
    .try(Joi.string().ip(), Joi.string().hostname())
    .default(DEFAULT_GRPC.host),
  GRPC_PORT: Joi.number()
    .integer()
    .min(1)
    .max(65535)
    .default(DEFAULT_GRPC.port),
  GRPC_TLS_CERT_FILE: Joi.string().empty(''),
  GRPC_TLS_KEY_FILE: Joi.string().empty(''),
  GRPC_MAX_MESSAGE_BYTES: Joi.number()
    .integer()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(DEFAULT_GRPC.maxMessageBytes),
  GRPC_MAX_HEADER_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(65536)
    .default(DEFAULT_GRPC.maxHeaderBytes),
  GRPC_MAX_CONCURRENT_STREAMS: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(DEFAULT_GRPC.maxConcurrentStreams),
  GRPC_MAX_SESSIONS_PER_TARGET: Joi.number()
    .integer()
    .min(1)
    .max(32)
    .default(DEFAULT_GRPC.maxSessionsPerTarget),
  GRPC_MAX_ACTIVE_CALLS: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(DEFAULT_GRPC.maxActiveCalls),
  GRPC_DEADLINE_MS: Joi.number()
    .integer()
    .min(100)
    .max(3600000)
    .default(DEFAULT_GRPC.deadlineMs),
  GRPC_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(3600000)
    .default(DEFAULT_GRPC.idleTimeoutMs),
  GRPC_SHUTDOWN_GRACE_MS: Joi.number()
    .integer()
    .min(0)
    .max(60000)
    .default(DEFAULT_GRPC.shutdownGraceMs),
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  PROXY_TIMEOUT_MS: Joi.number().default(10000),
  PROXY_SERVICES: Joi.string().default('[]'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_UNAUTH_MAX: Joi.number().default(100),
  RATE_LIMIT_AUTH_MAX: Joi.number().default(500),
})
  .and('GRPC_TLS_CERT_FILE', 'GRPC_TLS_KEY_FILE')
  .custom((value, helpers) => {
    if (
      value.GRPC_ENABLED === 'true' &&
      value.GRPC_ALLOW_INSECURE !== 'true' &&
      !value.GRPC_TLS_CERT_FILE
    )
      return helpers.error('any.invalid');
    return value;
  })
  .required();
