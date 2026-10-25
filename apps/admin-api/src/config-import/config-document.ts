import { BadRequestException } from '@nestjs/common';
import Joi from 'joi';
import { isAlias, parseDocument, visit } from 'yaml';
import {
  DECLARATIVE_CONFIG_MAX_BYTES,
  DECLARATIVE_CONFIG_MAX_ENTRIES,
  MAX_SERVICE_TARGET_WEIGHT,
  type DeclarativeConfig,
} from '@api-gateway/shared-types';
import {
  validateHealthSettings,
  validateTargets,
} from '../proxy-config/services.controller';
import {
  validateGraphql,
  validatePlugins,
} from '../proxy-config/routes.controller';
import { validateRoutePortal } from '../portal/portal-catalog';

export const routeKey = (route: { method: string; pathPattern: string }) =>
  `${route.method} ${route.pathPattern}`;
export const secretFields: Record<string, string[]> = {
  'oauth2-client-credentials': ['clientSecret'],
  'hmac-auth': ['secrets'],
  'basic-auth': ['credentials'],
  'request-transform': ['addHeaders', 'addQueryParams'],
  'response-transform': ['addHeaders'],
};
const privateFields = (name: string) =>
  Object.hasOwn(secretFields, name) ? secretFields[name] : [];
const text = Joi.string()
  .max(128)
  .custom((value: string, helpers) =>
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
      ? helpers.error('any.invalid')
      : value,
  );
const names = Joi.array().max(64).items(text).unique();
const bool = Joi.boolean().strict();
const integer = (min: number, max: number) =>
  Joi.number().strict().integer().min(min).max(max);
const path = Joi.string()
  .max(1024)
  .pattern(/^\/(?!\/)[^\s?#\\]*$/);
const documentSchema = Joi.object({
  version: Joi.number().strict().valid(1).required(),
  services: Joi.array()
    .max(DECLARATIVE_CONFIG_MAX_ENTRIES)
    .items(
      Joi.object({
        name: text.required(),
        targets: Joi.array()
          .items(
            Joi.object({
              url: Joi.string().required(),
              weight: integer(1, MAX_SERVICE_TARGET_WEIGHT).required(),
            }),
          )
          .required(),
        healthCheckPath: path.default('/health'),
        timeoutMs: integer(100, 3600000).default(10000),
        healthCheckIntervalMs: integer(1000, 60000).default(10000),
        healthCheckProtocol: Joi.string().valid('http', 'grpc').default('http'),
        healthCheckService: Joi.string().allow('').max(256).default(''),
        unhealthyFallback: bool.default(false),
        h2: bool.default(false),
        supportsWebSocket: bool.default(false),
        loadBalancing: Joi.string()
          .valid('weighted-round-robin', 'least-connections')
          .default('weighted-round-robin'),
      }),
    )
    .required(),
  routes: Joi.array()
    .max(DECLARATIVE_CONFIG_MAX_ENTRIES)
    .items(
      Joi.object({
        method: Joi.string()
          .valid(
            'GET',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'HEAD',
            'OPTIONS',
            'ANY',
          )
          .required(),
        pathPattern: path.required(),
        serviceId: text.required(),
        authRequired: bool.default(false),
        enabled: bool.default(true),
        rateLimitOverride: integer(1, 1000000000).allow(null).default(null),
        retry: Joi.object({
          attempts: integer(0, 5).required(),
          on: Joi.array().max(64).items(integer(100, 599)).unique().required(),
          methods: Joi.array()
            .max(8)
            .items(
              Joi.string().valid(
                'GET',
                'POST',
                'PUT',
                'PATCH',
                'DELETE',
                'HEAD',
                'OPTIONS',
              ),
            )
            .unique()
            .required(),
        })
          .allow(null)
          .default(null),
        plugins: Joi.array()
          .max(13)
          .items(
            Joi.object({
              name: text.required(),
              config: Joi.object().unknown(true).required(),
            }),
          )
          .default([]),
        graphql: Joi.object().unknown(true).allow(null).default(null),
        // Validated precisely by validateRoutePortal; absent means unpublished.
        portal: Joi.object().unknown(true).allow(null),
      }),
    )
    .required(),
  consumers: Joi.array()
    .max(DECLARATIVE_CONFIG_MAX_ENTRIES)
    .items(
      Joi.object({
        name: text.required(),
        rateLimitTier: text.default('authenticated'),
        groups: names.default([]),
      }),
    )
    .required(),
});

/** No source excerpts in parser failures; aliases, tags and deep objects are refused. */
export function parseConfigDocument(input: unknown): unknown {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > DECLARATIVE_CONFIG_MAX_BYTES)
      throw new BadRequestException(
        'Configuration exceeds 64 KiB. Split or reduce it before importing.',
      );
    try {
      const doc = parseDocument(input, {
        uniqueKeys: true,
        strict: true,
        stringKeys: true,
        prettyErrors: false,
      });
      if (doc.errors.length || doc.warnings.length) throw new Error();
      visit(doc, (_, node) => {
        if (isAlias(node)) throw new Error();
      });
      value = doc.toJS({ maxAliasCount: 0 });
    } catch {
      throw new BadRequestException(
        'Invalid YAML or JSON. Use one document with unique string keys and no aliases or custom tags.',
      );
    }
  }
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 12000 || depth > 16)
      throw new BadRequestException(
        'Configuration is too complex. Reduce its nesting or entries.',
      );
    if (
      typeof item === 'number' &&
      (!Number.isFinite(item) || !Number.isSafeInteger(item))
    )
      throw new BadRequestException(
        'Configuration numbers must be safe integers.',
      );
    if (item && typeof item === 'object') {
      if (
        !Array.isArray(item) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      )
        throw new BadRequestException('Use plain configuration objects.');
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new BadRequestException('Reserved configuration key.');
        inspect(child, depth + 1);
      }
    }
  };
  inspect(value, 0);
  if (
    Buffer.byteLength(JSON.stringify(value) ?? '') >
    DECLARATIVE_CONFIG_MAX_BYTES
  )
    throw new BadRequestException('Configuration exceeds 64 KiB.');
  return value;
}

const otherPluginSchemas: Record<string, Joi.ObjectSchema> = {
  cors: Joi.object({
    origins: names.required(),
    methods: names,
    headers: names,
    credentials: bool,
    maxAge: integer(0, 86400),
  }),
  'ip-restriction': Joi.object({ allow: names, deny: names }),
  'rate-limit': Joi.object({
    max: integer(1, 1000000000).required(),
    windowMs: integer(1, 3600000),
  }),
  'request-size-limit': Joi.object({
    maxBodyBytes: integer(1, 1073741824).required(),
  }),
  'request-transform': Joi.object({
    addHeaders: Joi.object().pattern(
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
      Joi.string()
        .max(4096)
        .pattern(/^[^\r\n]*$/),
    ),
    removeHeaders: names,
    renameHeaders: Joi.object().pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, text),
    addQueryParams: Joi.object().pattern(text, Joi.string().max(4096)),
    removeQueryParams: names,
  }),
  'response-transform': Joi.object({
    addHeaders: Joi.object().pattern(
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
      Joi.string()
        .max(4096)
        .pattern(/^[^\r\n]*$/),
    ),
    removeHeaders: names,
    statusOverride: integer(100, 599),
  }),
  'basic-auth': Joi.object({
    realm: text,
    credentials: Joi.array()
      .min(1)
      .max(64)
      .items(
        Joi.object({
          username: text.required(),
          passwordHash: Joi.string()
            .pattern(/^[a-f\d]{64}$/i)
            .required(),
        }),
      )
      .required(),
  }),
  acl: Joi.object({ allow: names, deny: names }),
};

export function normalizeConfigDocument(
  input: unknown,
  existingRoutes: DeclarativeConfig['routes'] = [],
): DeclarativeConfig {
  const result = documentSchema.validate(input, { convert: false });
  if (result.error)
    throw new BadRequestException(
      'Invalid configuration fields. Include version: 1 and services/routes/consumers arrays; use the documented field types and limits.',
    );
  const document = result.value as DeclarativeConfig;
  if (
    document.services.length +
      document.routes.length +
      document.consumers.length >
    DECLARATIVE_CONFIG_MAX_ENTRIES
  )
    throw new BadRequestException(
      'Import supports at most 200 entries in total.',
    );
  const unique = (values: string[]) => {
    if (new Set(values).size !== values.length)
      throw new BadRequestException(
        'Service names, consumer names and route method/path pairs must be unique.',
      );
  };
  unique(document.services.map((s) => s.name));
  unique(document.consumers.map((c) => c.name));
  unique(document.routes.map(routeKey));
  const serviceNames = new Set(document.services.map((s) => s.name));
  for (const service of document.services) {
    validateHealthSettings(service);
    service.targets = validateTargets(service.targets);
  }
  for (const route of document.routes) {
    if (!serviceNames.has(route.serviceId))
      throw new BadRequestException(
        'Every route serviceId must name a service in this document.',
      );
    const old = existingRoutes.find(
      (candidate) => routeKey(candidate) === routeKey(route),
    );
    for (const plugin of route.plugins ?? []) {
      const stored = old?.plugins?.find((p) => p.name === plugin.name);
      for (const field of privateFields(plugin.name))
        if (
          !Object.hasOwn(plugin.config, field) &&
          stored &&
          Object.hasOwn(stored.config, field)
        )
          plugin.config[field] = stored.config[field];
      if (
        Object.hasOwn(otherPluginSchemas, plugin.name) &&
        otherPluginSchemas[plugin.name].validate(plugin.config, {
          convert: false,
        }).error
      )
        throw new BadRequestException(
          'Invalid plugin configuration. Check its documented types and limits.',
        );
    }
    validatePlugins(route.plugins);
    validateGraphql(route.graphql);
    const portal = validateRoutePortal(route.portal);
    if (portal) route.portal = portal;
    else delete route.portal;
    if (
      (route.plugins ?? []).some(
        (plugin) =>
          ['oauth2-client-credentials', 'hmac-auth', 'basic-auth'].includes(
            plugin.name,
          ) &&
          privateFields(plugin.name).some(
            (field) => !Object.hasOwn(plugin.config, field),
          ),
      )
    )
      throw new BadRequestException(
        'New authentication plugins require credentials. Exported documents preserve omitted credentials only on matching existing routes.',
      );
  }
  return document;
}

export function redactConfigDocument(
  document: DeclarativeConfig,
): DeclarativeConfig {
  const safe = structuredClone(document);
  for (const route of safe.routes)
    for (const plugin of route.plugins ?? [])
      for (const field of privateFields(plugin.name))
        delete plugin.config[field];
  return safe;
}
