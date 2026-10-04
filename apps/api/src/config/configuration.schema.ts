import Joi from 'joi';
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
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  PROXY_TIMEOUT_MS: Joi.number().default(10000),
  PROXY_SERVICES: Joi.string().default('[]'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_UNAUTH_MAX: Joi.number().default(100),
  RATE_LIMIT_AUTH_MAX: Joi.number().default(500),
}).required();
