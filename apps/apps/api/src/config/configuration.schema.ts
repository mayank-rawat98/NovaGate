import Joi from 'joi';

export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  REDIS_URL: Joi.string().uri().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  PROXY_TIMEOUT_MS: Joi.number().default(10000),
  PROXY_SERVICES: Joi.string().default('[]'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_UNAUTH_MAX: Joi.number().default(100),
  RATE_LIMIT_AUTH_MAX: Joi.number().default(500),
}).required();
