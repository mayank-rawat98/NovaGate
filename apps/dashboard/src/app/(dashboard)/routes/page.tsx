'use client';

import { useState, useId } from 'react';
import useSWR from 'swr';
import { WorkspaceDialog } from '../../../components/workspace-dialog';
import { DataLoadNotice } from '../../../components/data-load-notice';
import { toast } from 'sonner';
import { Pencil, Trash2, Plus, X, Puzzle } from 'lucide-react';
import {
  getRoutes,
  getServices,
  createRoute,
  updateRoute,
  deleteRoute,
} from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import type {
  Route,
  Service,
  CreateRouteDto,
  OAuth2PluginConfig,
} from '../../../lib/api-client';

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-green-100 text-green-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-purple-100 text-purple-700',
  DELETE: 'bg-red-100 text-red-700',
  ANY: 'bg-gray-800 text-white',
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'] as const;
const RETRY_METHODS = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'DELETE',
] as const;
const DEFAULT_RETRY_CODES = '502,503,504';
const DEFAULT_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

type PanelTab = 'basic' | 'advanced' | 'plugins';

// ─── Plugin form types ────────────────────────────────────────────────────────

interface PluginEntry {
  name: string;
  config: Record<string, unknown>;
}

interface CorsConfig {
  origins: string;
  methods: string;
  headers: string;
  credentials: boolean;
  maxAge: string;
}
interface IpConfig {
  allow: string;
  deny: string;
}
interface RateLimitConfig {
  max: string;
  windowMs: string;
}
interface RequestTransformConfig {
  addHeaders: string;
  removeHeaders: string;
  renameHeaders: string;
  addQueryParams: string;
  removeQueryParams: string;
}
interface ResponseTransformConfig {
  addHeaders: string;
  removeHeaders: string;
  statusOverride: string;
}
interface BasicAuthConfig {
  credentials: string;
  realm: string;
}
interface RequestSizeLimitConfig {
  maxBodyBytes: string;
}
interface OidcConfig {
  jwksUri: string;
  issuer: string;
  audience: string;
  claimsToForward: string;
}
interface HmacAuthConfig {
  header: string;
  algorithm: string;
  secrets: string;
  maxClockSkewSeconds: string;
  timestampHeader: string;
}
interface AclConfig {
  allow: string;
  deny: string;
}
interface MtlsConfig {
  required: boolean;
}

interface PluginsFormState {
  cors: boolean;
  corsConfig: CorsConfig;
  ipRestriction: boolean;
  ipConfig: IpConfig;
  rateLimit: boolean;
  rateLimitConfig: RateLimitConfig;
  requestTransform: boolean;
  requestTransformConfig: RequestTransformConfig;
  responseTransform: boolean;
  responseTransformConfig: ResponseTransformConfig;
  basicAuth: boolean;
  basicAuthConfig: BasicAuthConfig;
  requestSizeLimit: boolean;
  requestSizeLimitConfig: RequestSizeLimitConfig;
  oidc: boolean;
  oidcConfig: OidcConfig;
  oauth: boolean;
  oauthConfig: {
    mode: 'introspection' | 'outbound';
    endpoint: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    headerName: string;
    issuer: string;
    audience: string;
  };
  originalPlugins: PluginEntry[];
  hmacAuth: boolean;
  hmacAuthConfig: HmacAuthConfig;
  acl: boolean;
  aclConfig: AclConfig;
  mtls: boolean;
  mtlsConfig: MtlsConfig;
}

const EMPTY_PLUGINS_FORM: PluginsFormState = {
  cors: false,
  corsConfig: {
    origins: '',
    methods: '',
    headers: '',
    credentials: false,
    maxAge: '',
  },
  ipRestriction: false,
  ipConfig: { allow: '', deny: '' },
  rateLimit: false,
  rateLimitConfig: { max: '100', windowMs: '60000' },
  requestTransform: false,
  requestTransformConfig: {
    addHeaders: '',
    removeHeaders: '',
    renameHeaders: '',
    addQueryParams: '',
    removeQueryParams: '',
  },
  responseTransform: false,
  responseTransformConfig: {
    addHeaders: '',
    removeHeaders: '',
    statusOverride: '',
  },
  basicAuth: false,
  basicAuthConfig: { credentials: '', realm: '' },
  requestSizeLimit: false,
  requestSizeLimitConfig: { maxBodyBytes: '' },
  oidc: false,
  oidcConfig: { jwksUri: '', issuer: '', audience: '', claimsToForward: '' },
  oauth: false,
  oauthConfig: {
    mode: 'introspection',
    endpoint: '',
    clientId: '',
    clientSecret: '',
    scopes: '',
    headerName: 'authorization',
    issuer: '',
    audience: '',
  },
  originalPlugins: [],
  hmacAuth: false,
  hmacAuthConfig: {
    header: 'x-hub-signature-256',
    algorithm: 'sha256',
    secrets: '',
    maxClockSkewSeconds: '',
    timestampHeader: '',
  },
  acl: false,
  aclConfig: { allow: '', deny: '' },
  mtls: false,
  mtlsConfig: { required: true },
};

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  method: string;
  pathPattern: string;
  serviceId: string;
  authRequired: boolean;
  enabled: boolean;
  rateLimitOverride: string;
  retryEnabled: boolean;
  retryAttempts: string;
  retryOn: string;
  retryMethods: string[];
}

const EMPTY_FORM: FormState = {
  method: 'ANY',
  pathPattern: '',
  serviceId: '',
  authRequired: false,
  enabled: true,
  rateLimitOverride: '',
  retryEnabled: false,
  retryAttempts: '3',
  retryOn: DEFAULT_RETRY_CODES,
  retryMethods: DEFAULT_RETRY_METHODS,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseKV(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const idx = line.indexOf(':');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function buildPluginsArray(pf: PluginsFormState): PluginEntry[] {
  const result: PluginEntry[] = [];

  if (pf.cors) {
    const cfg: Record<string, unknown> = {
      origins: pf.corsConfig.origins
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (pf.corsConfig.methods)
      cfg.methods = pf.corsConfig.methods
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (pf.corsConfig.headers)
      cfg.headers = pf.corsConfig.headers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (pf.corsConfig.credentials) cfg.credentials = true;
    if (pf.corsConfig.maxAge) cfg.maxAge = Number(pf.corsConfig.maxAge);
    result.push({ name: 'cors', config: cfg });
  }

  if (pf.ipRestriction) {
    const cfg: Record<string, unknown> = {};
    if (pf.ipConfig.allow)
      cfg.allow = pf.ipConfig.allow
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    if (pf.ipConfig.deny)
      cfg.deny = pf.ipConfig.deny
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    result.push({ name: 'ip-restriction', config: cfg });
  }

  if (pf.requestSizeLimit && pf.requestSizeLimitConfig.maxBodyBytes) {
    result.push({
      name: 'request-size-limit',
      config: { maxBodyBytes: Number(pf.requestSizeLimitConfig.maxBodyBytes) },
    });
  }

  if (pf.rateLimit && pf.rateLimitConfig.max) {
    const cfg: Record<string, unknown> = {
      max: Number(pf.rateLimitConfig.max),
    };
    if (pf.rateLimitConfig.windowMs)
      cfg.windowMs = Number(pf.rateLimitConfig.windowMs);
    result.push({ name: 'rate-limit', config: cfg });
  }

  if (pf.requestTransform) {
    const cfg: Record<string, unknown> = {};
    if (pf.requestTransformConfig.addHeaders)
      cfg.addHeaders = parseKV(pf.requestTransformConfig.addHeaders);
    if (pf.requestTransformConfig.removeHeaders)
      cfg.removeHeaders = pf.requestTransformConfig.removeHeaders
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (pf.requestTransformConfig.renameHeaders)
      cfg.renameHeaders = parseKV(pf.requestTransformConfig.renameHeaders);
    if (pf.requestTransformConfig.addQueryParams)
      cfg.addQueryParams = parseKV(pf.requestTransformConfig.addQueryParams);
    if (pf.requestTransformConfig.removeQueryParams)
      cfg.removeQueryParams = pf.requestTransformConfig.removeQueryParams
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    result.push({ name: 'request-transform', config: cfg });
  }

  if (pf.responseTransform) {
    const cfg: Record<string, unknown> = {};
    if (pf.responseTransformConfig.addHeaders)
      cfg.addHeaders = parseKV(pf.responseTransformConfig.addHeaders);
    if (pf.responseTransformConfig.removeHeaders)
      cfg.removeHeaders = pf.responseTransformConfig.removeHeaders
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (pf.responseTransformConfig.statusOverride)
      cfg.statusOverride = Number(pf.responseTransformConfig.statusOverride);
    result.push({ name: 'response-transform', config: cfg });
  }

  if (pf.basicAuth) {
    const credentials = pf.basicAuthConfig.credentials
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [username, passwordHash] = line.split(':');
        return {
          username: username?.trim() ?? '',
          passwordHash: passwordHash?.trim() ?? '',
        };
      });
    const cfg: Record<string, unknown> = { credentials };
    if (pf.basicAuthConfig.realm) cfg.realm = pf.basicAuthConfig.realm;
    result.push({ name: 'basic-auth', config: cfg });
  }

  if (pf.oidc && pf.oidcConfig.jwksUri && pf.oidcConfig.issuer) {
    const cfg: Record<string, unknown> = {
      jwksUri: pf.oidcConfig.jwksUri,
      issuer: pf.oidcConfig.issuer,
    };
    if (pf.oidcConfig.audience) cfg.audience = pf.oidcConfig.audience;
    if (pf.oidcConfig.claimsToForward)
      cfg.claimsToForward = pf.oidcConfig.claimsToForward
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    result.push({ name: 'oidc', config: cfg });
  }

  if (pf.oauth) {
    const config: OAuth2PluginConfig = {
      ...(pf.oauthConfig.mode === 'introspection'
        ? { introspectionEndpoint: pf.oauthConfig.endpoint }
        : { tokenEndpoint: pf.oauthConfig.endpoint }),
      clientId: pf.oauthConfig.clientId,
      clientSecret: pf.oauthConfig.clientSecret,
      ...(pf.oauthConfig.scopes
        ? { scopes: pf.oauthConfig.scopes.split(/[,\s]+/).filter(Boolean) }
        : {}),
      ...(pf.oauthConfig.headerName
        ? { headerName: pf.oauthConfig.headerName }
        : {}),
      ...(pf.oauthConfig.issuer ? { issuer: pf.oauthConfig.issuer } : {}),
      ...(pf.oauthConfig.audience ? { audience: pf.oauthConfig.audience } : {}),
    };
    result.push({ name: 'oauth2-client-credentials', config: { ...config } });
  }

  if (pf.hmacAuth && pf.hmacAuthConfig.secrets) {
    const cfg: Record<string, unknown> = {
      header: pf.hmacAuthConfig.header || 'x-hub-signature-256',
      algorithm: pf.hmacAuthConfig.algorithm || 'sha256',
      secrets: pf.hmacAuthConfig.secrets
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (pf.hmacAuthConfig.maxClockSkewSeconds)
      cfg.maxClockSkewSeconds = Number(pf.hmacAuthConfig.maxClockSkewSeconds);
    if (pf.hmacAuthConfig.timestampHeader)
      cfg.timestampHeader = pf.hmacAuthConfig.timestampHeader;
    result.push({ name: 'hmac-auth', config: cfg });
  }

  if (pf.acl && (pf.aclConfig.allow || pf.aclConfig.deny)) {
    const cfg: Record<string, unknown> = {};
    if (pf.aclConfig.allow)
      cfg.allow = pf.aclConfig.allow
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (pf.aclConfig.deny)
      cfg.deny = pf.aclConfig.deny
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    result.push({ name: 'acl', config: cfg });
  }

  if (pf.mtls) {
    result.push({ name: 'mtls', config: { required: pf.mtlsConfig.required } });
  }

  const modeled: Record<string, string[]> = {
    cors: ['origins', 'methods', 'headers', 'credentials', 'maxAge'],
    'ip-restriction': ['allow', 'deny'],
    'rate-limit': ['max', 'windowMs'],
    'request-size-limit': ['maxBodyBytes'],
    'request-transform': [
      'addHeaders',
      'removeHeaders',
      'renameHeaders',
      'addQueryParams',
      'removeQueryParams',
    ],
    'response-transform': ['addHeaders', 'removeHeaders', 'statusOverride'],
    'basic-auth': ['credentials', 'realm'],
    oidc: ['jwksUri', 'issuer', 'audience', 'claimsToForward'],
    'oauth2-client-credentials': [
      'introspectionEndpoint',
      'tokenEndpoint',
      'clientId',
      'clientSecret',
      'scopes',
      'headerName',
      'issuer',
      'audience',
    ],
    'hmac-auth': [
      'header',
      'algorithm',
      'secrets',
      'maxClockSkewSeconds',
      'timestampHeader',
    ],
    acl: ['allow', 'deny'],
    mtls: ['required'],
  };
  const remaining = [...result];
  const ordered: PluginEntry[] = [];
  for (const original of pf.originalPlugins) {
    if (!modeled[original.name]) {
      ordered.push(original);
      continue;
    }
    const index = remaining.findIndex((entry) => entry.name === original.name);
    if (index >= 0)
      ordered.push({
        name: original.name,
        config: {
          ...Object.fromEntries(
            Object.entries(original.config).filter(
              ([name]) => !modeled[original.name].includes(name),
            ),
          ),
          ...remaining.splice(index, 1)[0].config,
        },
      });
  }
  return [...ordered, ...remaining];
}

function pluginsToForm(plugins: PluginEntry[] | undefined): PluginsFormState {
  if (!plugins?.length) return EMPTY_PLUGINS_FORM;
  const state = { ...EMPTY_PLUGINS_FORM, originalPlugins: plugins };

  for (const p of plugins) {
    const cfg = p.config;
    if (p.name === 'cors') {
      state.cors = true;
      state.corsConfig = {
        origins: (cfg.origins as string[] | undefined)?.join('\n') ?? '',
        methods: (cfg.methods as string[] | undefined)?.join(',') ?? '',
        headers: (cfg.headers as string[] | undefined)?.join(',') ?? '',
        credentials: (cfg.credentials as boolean | undefined) ?? false,
        maxAge: cfg.maxAge != null ? String(cfg.maxAge) : '',
      };
    } else if (p.name === 'ip-restriction') {
      state.ipRestriction = true;
      state.ipConfig = {
        allow: (cfg.allow as string[] | undefined)?.join('\n') ?? '',
        deny: (cfg.deny as string[] | undefined)?.join('\n') ?? '',
      };
    } else if (p.name === 'request-size-limit') {
      state.requestSizeLimit = true;
      state.requestSizeLimitConfig = {
        maxBodyBytes: cfg.maxBodyBytes != null ? String(cfg.maxBodyBytes) : '',
      };
    } else if (p.name === 'rate-limit') {
      state.rateLimit = true;
      state.rateLimitConfig = {
        max: cfg.max != null ? String(cfg.max) : '100',
        windowMs: cfg.windowMs != null ? String(cfg.windowMs) : '60000',
      };
    } else if (p.name === 'request-transform') {
      state.requestTransform = true;
      const kvStr = (obj: unknown) =>
        obj
          ? Object.entries(obj as Record<string, string>)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
          : '';
      const arrStr = (arr: unknown) =>
        Array.isArray(arr) ? (arr as string[]).join(',') : '';
      state.requestTransformConfig = {
        addHeaders: kvStr(cfg.addHeaders),
        removeHeaders: arrStr(cfg.removeHeaders),
        renameHeaders: kvStr(cfg.renameHeaders),
        addQueryParams: kvStr(cfg.addQueryParams),
        removeQueryParams: arrStr(cfg.removeQueryParams),
      };
    } else if (p.name === 'response-transform') {
      state.responseTransform = true;
      const kvStr = (obj: unknown) =>
        obj
          ? Object.entries(obj as Record<string, string>)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
          : '';
      const arrStr = (arr: unknown) =>
        Array.isArray(arr) ? (arr as string[]).join(',') : '';
      state.responseTransformConfig = {
        addHeaders: kvStr(cfg.addHeaders),
        removeHeaders: arrStr(cfg.removeHeaders),
        statusOverride:
          cfg.statusOverride != null ? String(cfg.statusOverride) : '',
      };
    } else if (p.name === 'basic-auth') {
      state.basicAuth = true;
      const creds =
        (cfg.credentials as
          | Array<{ username: string; passwordHash: string }>
          | undefined) ?? [];
      state.basicAuthConfig = {
        credentials: creds
          .map((c) => `${c.username}:${c.passwordHash}`)
          .join('\n'),
        realm: (cfg.realm as string | undefined) ?? '',
      };
    } else if (p.name === 'oidc') {
      state.oidc = true;
      state.oidcConfig = {
        jwksUri: (cfg.jwksUri as string | undefined) ?? '',
        issuer: (cfg.issuer as string | undefined) ?? '',
        audience: (cfg.audience as string | undefined) ?? '',
        claimsToForward:
          (cfg.claimsToForward as string[] | undefined)?.join(',') ?? '',
      };
    } else if (p.name === 'oauth2-client-credentials') {
      state.oauth = true;
      const oauth = cfg as unknown as OAuth2PluginConfig;
      state.oauthConfig = {
        mode: oauth.introspectionEndpoint ? 'introspection' : 'outbound',
        endpoint: oauth.introspectionEndpoint ?? oauth.tokenEndpoint ?? '',
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        scopes: oauth.scopes?.join(', ') ?? '',
        headerName: oauth.headerName ?? 'authorization',
        issuer: oauth.issuer ?? '',
        audience: oauth.audience ?? '',
      };
    } else if (p.name === 'hmac-auth') {
      state.hmacAuth = true;
      state.hmacAuthConfig = {
        header: (cfg.header as string | undefined) ?? 'x-hub-signature-256',
        algorithm: (cfg.algorithm as string | undefined) ?? 'sha256',
        secrets: (cfg.secrets as string[] | undefined)?.join('\n') ?? '',
        maxClockSkewSeconds:
          cfg.maxClockSkewSeconds != null
            ? String(cfg.maxClockSkewSeconds)
            : '',
        timestampHeader: (cfg.timestampHeader as string | undefined) ?? '',
      };
    } else if (p.name === 'acl') {
      state.acl = true;
      state.aclConfig = {
        allow: (cfg.allow as string[] | undefined)?.join(', ') ?? '',
        deny: (cfg.deny as string[] | undefined)?.join(', ') ?? '',
      };
    } else if (p.name === 'mtls') {
      state.mtls = true;
      state.mtlsConfig = {
        required: (cfg.required as boolean | undefined) ?? true,
      };
    }
  }

  return state;
}

function routeToForm(route: Route): FormState {
  return {
    method: route.method,
    pathPattern: route.pathPattern,
    serviceId: route.serviceId,
    authRequired: route.authRequired,
    enabled: route.enabled,
    rateLimitOverride: route.rateLimitOverride?.toString() ?? '',
    retryEnabled: !!route.retry,
    retryAttempts: route.retry?.attempts?.toString() ?? '3',
    retryOn: route.retry?.on?.join(',') ?? DEFAULT_RETRY_CODES,
    retryMethods: route.retry?.methods ?? DEFAULT_RETRY_METHODS,
  };
}

function formToDto(
  form: FormState,
  pluginsForm: PluginsFormState,
): CreateRouteDto {
  const dto: CreateRouteDto = {
    method: form.method,
    pathPattern: form.pathPattern,
    serviceId: form.serviceId,
    authRequired: form.authRequired,
    enabled: form.enabled,
  };
  if (form.rateLimitOverride)
    dto.rateLimitOverride = Number(form.rateLimitOverride);
  if (form.retryEnabled) {
    dto.retry = {
      attempts: Math.max(1, parseInt(form.retryAttempts, 10) || 3),
      on: form.retryOn
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n)),
      methods: form.retryMethods,
    };
  }
  const plugins = buildPluginsArray(pluginsForm);
  if (plugins.length > 0) dto.plugins = plugins;
  return dto;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${value ? 'bg-blue-600' : 'bg-gray-200'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${value ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

function PluginSection({
  title,
  description,
  enabled,
  onToggle,
  badge,
  children,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">{title}</span>
            {badge && (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                {badge}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400">{description}</p>
        </div>
        <Toggle label={`${title} plugin`} value={enabled} onChange={onToggle} />
      </div>
      {enabled && children && (
        <div className="flex flex-col gap-3 pl-1">{children}</div>
      )}
    </div>
  );
}

function Textarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-gray-600">
        {label}
      </label>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-gray-300 px-3 py-2 font-mono text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-gray-600">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

// ─── Plugins tab ──────────────────────────────────────────────────────────────

function PluginsTab({
  pf,
  setPf,
}: {
  pf: PluginsFormState;
  setPf: (patch: Partial<PluginsFormState>) => void;
}) {
  const oauthModeId = useId();
  const activeCount = [
    pf.cors,
    pf.ipRestriction,
    pf.requestSizeLimit,
    pf.rateLimit,
    pf.requestTransform,
    pf.responseTransform,
    pf.basicAuth,
    pf.oidc,
    pf.oauth,
    pf.hmacAuth,
    pf.acl,
    pf.mtls,
  ].filter(Boolean).length;

  return (
    <div className="flex flex-col gap-5">
      {activeCount === 0 && (
        <p className="text-sm text-gray-400">
          Enable plugins below to add request/response processing to this route.
        </p>
      )}

      <PluginSection
        title="CORS"
        description="Allow cross-origin requests from browsers"
        enabled={pf.cors}
        onToggle={(v) => setPf({ cors: v })}
      >
        <Textarea
          label="Allowed Origins (one per line, or *)"
          value={pf.corsConfig.origins}
          onChange={(v) =>
            setPf({ corsConfig: { ...pf.corsConfig, origins: v } })
          }
          placeholder={'https://app.example.com\n*'}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Methods (comma-sep, optional)"
            value={pf.corsConfig.methods}
            onChange={(v) =>
              setPf({ corsConfig: { ...pf.corsConfig, methods: v } })
            }
            placeholder="GET,POST,PUT"
          />
          <TextInput
            label="Headers (optional)"
            value={pf.corsConfig.headers}
            onChange={(v) =>
              setPf({ corsConfig: { ...pf.corsConfig, headers: v } })
            }
            placeholder="Authorization,X-Api-Key"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
            <span className="text-xs font-medium text-gray-600">
              Allow Credentials
            </span>
            <Toggle
              label="Allow credentials"
              value={pf.corsConfig.credentials}
              onChange={(v) =>
                setPf({ corsConfig: { ...pf.corsConfig, credentials: v } })
              }
            />
          </div>
          <TextInput
            label="Preflight Cache (seconds)"
            value={pf.corsConfig.maxAge}
            onChange={(v) =>
              setPf({ corsConfig: { ...pf.corsConfig, maxAge: v } })
            }
            placeholder="86400"
            type="number"
          />
        </div>
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="IP Restriction"
        description="Allow or deny IPs by CIDR range"
        enabled={pf.ipRestriction}
        onToggle={(v) => setPf({ ipRestriction: v })}
      >
        <div className="grid grid-cols-2 gap-3">
          <Textarea
            label="Allow List (one CIDR per line)"
            value={pf.ipConfig.allow}
            onChange={(v) => setPf({ ipConfig: { ...pf.ipConfig, allow: v } })}
            placeholder={'10.0.0.0/8\n192.168.1.0/24'}
          />
          <Textarea
            label="Deny List (takes precedence)"
            value={pf.ipConfig.deny}
            onChange={(v) => setPf({ ipConfig: { ...pf.ipConfig, deny: v } })}
            placeholder="203.0.113.0/24"
          />
        </div>
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="Request Size Limit"
        description="Reject requests whose body exceeds the limit"
        enabled={pf.requestSizeLimit}
        onToggle={(v) => setPf({ requestSizeLimit: v })}
      >
        <TextInput
          label="Max Body Bytes"
          value={pf.requestSizeLimitConfig.maxBodyBytes}
          onChange={(v) =>
            setPf({ requestSizeLimitConfig: { maxBodyBytes: v } })
          }
          placeholder="1048576"
          type="number"
        />
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="Rate Limit"
        description="Per-route request rate limiting (independent of global)"
        enabled={pf.rateLimit}
        onToggle={(v) => setPf({ rateLimit: v })}
      >
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Max Requests"
            value={pf.rateLimitConfig.max}
            onChange={(v) =>
              setPf({ rateLimitConfig: { ...pf.rateLimitConfig, max: v } })
            }
            placeholder="100"
            type="number"
          />
          <TextInput
            label="Window (ms)"
            value={pf.rateLimitConfig.windowMs}
            onChange={(v) =>
              setPf({ rateLimitConfig: { ...pf.rateLimitConfig, windowMs: v } })
            }
            placeholder="60000"
            type="number"
          />
        </div>
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="Request Transform"
        description="Add, remove, or rename request headers and query params"
        enabled={pf.requestTransform}
        onToggle={(v) => setPf({ requestTransform: v })}
      >
        <Textarea
          label="Add Headers (one per line: Header-Name: value)"
          value={pf.requestTransformConfig.addHeaders}
          onChange={(v) =>
            setPf({
              requestTransformConfig: {
                ...pf.requestTransformConfig,
                addHeaders: v,
              },
            })
          }
          placeholder="X-Tenant-ID: acme"
        />
        <TextInput
          label="Remove Headers (comma-sep)"
          value={pf.requestTransformConfig.removeHeaders}
          onChange={(v) =>
            setPf({
              requestTransformConfig: {
                ...pf.requestTransformConfig,
                removeHeaders: v,
              },
            })
          }
          placeholder="X-Internal-Token,X-Debug"
        />
        <Textarea
          label="Rename Headers (one per line: Old-Name: New-Name)"
          value={pf.requestTransformConfig.renameHeaders}
          onChange={(v) =>
            setPf({
              requestTransformConfig: {
                ...pf.requestTransformConfig,
                renameHeaders: v,
              },
            })
          }
          placeholder="X-Old-Auth: Authorization"
        />
        <Textarea
          label="Add Query Params (one per line: key: value)"
          value={pf.requestTransformConfig.addQueryParams}
          onChange={(v) =>
            setPf({
              requestTransformConfig: {
                ...pf.requestTransformConfig,
                addQueryParams: v,
              },
            })
          }
          placeholder="version: v2"
        />
        <TextInput
          label="Remove Query Params (comma-sep)"
          value={pf.requestTransformConfig.removeQueryParams}
          onChange={(v) =>
            setPf({
              requestTransformConfig: {
                ...pf.requestTransformConfig,
                removeQueryParams: v,
              },
            })
          }
          placeholder="debug,internal"
        />
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="Response Transform"
        description="Add, remove headers or override status code on responses"
        enabled={pf.responseTransform}
        onToggle={(v) => setPf({ responseTransform: v })}
      >
        <Textarea
          label="Add Headers (one per line: Header-Name: value)"
          value={pf.responseTransformConfig.addHeaders}
          onChange={(v) =>
            setPf({
              responseTransformConfig: {
                ...pf.responseTransformConfig,
                addHeaders: v,
              },
            })
          }
          placeholder="X-Gateway: NovaGate"
        />
        <TextInput
          label="Remove Headers (comma-sep)"
          value={pf.responseTransformConfig.removeHeaders}
          onChange={(v) =>
            setPf({
              responseTransformConfig: {
                ...pf.responseTransformConfig,
                removeHeaders: v,
              },
            })
          }
          placeholder="X-Powered-By,Server"
        />
        <TextInput
          label="Status Override (optional)"
          value={pf.responseTransformConfig.statusOverride}
          onChange={(v) =>
            setPf({
              responseTransformConfig: {
                ...pf.responseTransformConfig,
                statusOverride: v,
              },
            })
          }
          placeholder="200"
          type="number"
        />
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="Basic Auth"
        description="Require HTTP Basic Authentication credentials"
        enabled={pf.basicAuth}
        onToggle={(v) => setPf({ basicAuth: v })}
      >
        <Textarea
          label="Credentials (one per line: username:sha256-hash)"
          value={pf.basicAuthConfig.credentials}
          onChange={(v) =>
            setPf({
              basicAuthConfig: { ...pf.basicAuthConfig, credentials: v },
            })
          }
          placeholder="alice:e3b0c44298fc1c149afb..."
          hint="Provide SHA-256 hex digest of password"
          rows={4}
        />
        <TextInput
          label="Realm (optional)"
          value={pf.basicAuthConfig.realm}
          onChange={(v) =>
            setPf({ basicAuthConfig: { ...pf.basicAuthConfig, realm: v } })
          }
          placeholder="My API"
        />
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="OIDC"
        description="Validate inbound Bearer tokens using JWKS (Auth0, Cognito, Keycloak)"
        enabled={pf.oidc}
        onToggle={(v) => setPf({ oidc: v })}
      >
        <TextInput
          label="JWKS URI"
          value={pf.oidcConfig.jwksUri}
          onChange={(v) =>
            setPf({ oidcConfig: { ...pf.oidcConfig, jwksUri: v } })
          }
          placeholder="https://your-domain/.well-known/jwks.json"
        />
        <TextInput
          label="Issuer"
          value={pf.oidcConfig.issuer}
          onChange={(v) =>
            setPf({ oidcConfig: { ...pf.oidcConfig, issuer: v } })
          }
          placeholder="https://your-domain/"
        />
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Audience (optional)"
            value={pf.oidcConfig.audience}
            onChange={(v) =>
              setPf({ oidcConfig: { ...pf.oidcConfig, audience: v } })
            }
            placeholder="my-api"
          />
          <TextInput
            label="Forward Claims (comma-sep)"
            value={pf.oidcConfig.claimsToForward}
            onChange={(v) =>
              setPf({ oidcConfig: { ...pf.oidcConfig, claimsToForward: v } })
            }
            placeholder="sub,email"
          />
        </div>
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="OAuth 2.0"
        description="Verify client tokens or obtain credentials for an upstream service"
        enabled={pf.oauth}
        onToggle={(v) => setPf({ oauth: v })}
      >
        <div className="flex flex-col gap-1 text-sm text-gray-700">
          <label htmlFor={oauthModeId}>OAuth purpose</label>
          <select
            id={oauthModeId}
            className="rounded-md border border-gray-300 px-3 py-2"
            value={pf.oauthConfig.mode}
            onChange={(e) =>
              setPf({
                oauthConfig: {
                  ...pf.oauthConfig,
                  mode: e.target.value as 'introspection' | 'outbound',
                  issuer: '',
                  audience: '',
                },
              })
            }
          >
            <option value="introspection">Verify incoming client tokens</option>
            <option value="outbound">Obtain upstream credentials</option>
          </select>
        </div>
        <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
          {pf.oauthConfig.mode === 'introspection'
            ? 'Checks each client token with your identity provider. Only verified active tokens can satisfy required route authentication.'
            : 'Adds a service token to upstream requests. This does not authenticate your clients; configure separate incoming authentication for protected routes.'}
        </p>
        <TextInput
          label={
            pf.oauthConfig.mode === 'introspection'
              ? 'Introspection endpoint'
              : 'Token endpoint'
          }
          value={pf.oauthConfig.endpoint}
          onChange={(v) =>
            setPf({ oauthConfig: { ...pf.oauthConfig, endpoint: v } })
          }
          placeholder="https://identity.example.com/oauth"
        />
        <TextInput
          label="OAuth client ID"
          value={pf.oauthConfig.clientId}
          onChange={(v) =>
            setPf({ oauthConfig: { ...pf.oauthConfig, clientId: v } })
          }
        />
        <label className="flex flex-col gap-1 text-sm text-gray-700">
          OAuth client secret
          <input
            type="password"
            autoComplete="new-password"
            className="rounded-md border border-gray-300 px-3 py-2"
            value={pf.oauthConfig.clientSecret}
            onChange={(e) =>
              setPf({
                oauthConfig: {
                  ...pf.oauthConfig,
                  clientSecret: e.target.value,
                },
              })
            }
          />
        </label>
        {pf.oauthConfig.mode === 'introspection' ? (
          <>
            <TextInput
              label="OAuth expected issuer (optional)"
              value={pf.oauthConfig.issuer}
              onChange={(v) =>
                setPf({ oauthConfig: { ...pf.oauthConfig, issuer: v } })
              }
            />
            <TextInput
              label="OAuth expected audience (optional)"
              value={pf.oauthConfig.audience}
              onChange={(v) =>
                setPf({ oauthConfig: { ...pf.oauthConfig, audience: v } })
              }
            />
          </>
        ) : (
          <>
            <TextInput
              label="OAuth scopes (comma separated)"
              value={pf.oauthConfig.scopes}
              onChange={(v) =>
                setPf({ oauthConfig: { ...pf.oauthConfig, scopes: v } })
              }
            />
            <TextInput
              label="Upstream token header"
              value={pf.oauthConfig.headerName}
              onChange={(v) =>
                setPf({ oauthConfig: { ...pf.oauthConfig, headerName: v } })
              }
              placeholder="authorization"
            />
          </>
        )}
        <p className="text-xs text-gray-500">
          Use HTTPS. Private HTTP providers require explicit gateway operator
          configuration.
        </p>
      </PluginSection>
      <hr className="border-gray-100" />

      <PluginSection
        title="HMAC Auth"
        description="Validate HMAC request signatures (Stripe, GitHub webhooks)"
        enabled={pf.hmacAuth}
        onToggle={(v) => setPf({ hmacAuth: v })}
      >
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Signature Header"
            value={pf.hmacAuthConfig.header}
            onChange={(v) =>
              setPf({ hmacAuthConfig: { ...pf.hmacAuthConfig, header: v } })
            }
            placeholder="x-hub-signature-256"
          />
          <div className="flex flex-col gap-1">
            <label
              htmlFor="routes-field-1"
              className="text-xs font-medium text-gray-600"
            >
              Algorithm
            </label>
            <select
              id="routes-field-1"
              value={pf.hmacAuthConfig.algorithm}
              onChange={(e) =>
                setPf({
                  hmacAuthConfig: {
                    ...pf.hmacAuthConfig,
                    algorithm: e.target.value,
                  },
                })
              }
              className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="sha256">SHA-256</option>
              <option value="sha512">SHA-512</option>
            </select>
          </div>
        </div>
        <Textarea
          label="Secrets (one per line — supports rotation)"
          value={pf.hmacAuthConfig.secrets}
          onChange={(v) =>
            setPf({ hmacAuthConfig: { ...pf.hmacAuthConfig, secrets: v } })
          }
          placeholder="whsec_abc123..."
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Timestamp Header (optional)"
            value={pf.hmacAuthConfig.timestampHeader}
            onChange={(v) =>
              setPf({
                hmacAuthConfig: { ...pf.hmacAuthConfig, timestampHeader: v },
              })
            }
            placeholder="x-timestamp"
          />
          <TextInput
            label="Max Clock Skew (seconds)"
            value={pf.hmacAuthConfig.maxClockSkewSeconds}
            onChange={(v) =>
              setPf({
                hmacAuthConfig: {
                  ...pf.hmacAuthConfig,
                  maxClockSkewSeconds: v,
                },
              })
            }
            placeholder="300"
            type="number"
          />
        </div>
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="ACL"
        description="Allow or deny access based on consumer groups"
        enabled={pf.acl}
        onToggle={(v) => setPf({ acl: v })}
      >
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Allow Groups (comma-sep)"
            value={pf.aclConfig.allow}
            onChange={(v) =>
              setPf({ aclConfig: { ...pf.aclConfig, allow: v } })
            }
            placeholder="admin, internal"
          />
          <TextInput
            label="Deny Groups (takes precedence)"
            value={pf.aclConfig.deny}
            onChange={(v) => setPf({ aclConfig: { ...pf.aclConfig, deny: v } })}
            placeholder="banned"
          />
        </div>
        <p className="text-xs text-gray-400">
          Consumers without any of the allowed groups are denied. Set groups on
          consumers in the Consumers page.
        </p>
      </PluginSection>

      <hr className="border-gray-100" />

      <PluginSection
        title="mTLS"
        description="Require a client certificate signed by the tenant CA"
        enabled={pf.mtls}
        onToggle={(v) => setPf({ mtls: v })}
      >
        <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2">
          <span className="text-xs font-medium text-gray-600">
            Enforce (reject if no cert)
          </span>
          <Toggle
            label="Require client certificate"
            value={pf.mtlsConfig.required}
            onChange={(v) => setPf({ mtlsConfig: { required: v } })}
          />
        </div>
        <p className="text-xs text-gray-400">
          Upload the CA certificate in Settings → Security to enable certificate
          validation.
        </p>
      </PluginSection>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RoutesPage() {
  const tenantId = useTenantId() ?? '';

  const {
    data: routes,
    error: loadError,
    mutate,
  } = useSWR(
    tenantId ? `routes-${tenantId}` : null,
    () => getRoutes(tenantId),
    { refreshInterval: 30000 },
  );
  const { data: services } = useSWR(
    tenantId ? `services-${tenantId}` : null,
    () => getServices(tenantId),
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('basic');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pluginsForm, setPluginsForm] =
    useState<PluginsFormState>(EMPTY_PLUGINS_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setPluginsForm(EMPTY_PLUGINS_FORM);
    setPanelTab('basic');
    setPanelOpen(true);
  }

  function openEdit(route: Route) {
    setEditId(route.id);
    setForm(routeToForm(route));
    setPluginsForm(pluginsToForm(route.plugins));
    setPanelTab('basic');
    setPanelOpen(true);
  }

  function setF(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function setPf(patch: Partial<PluginsFormState>) {
    setPluginsForm((pf) => ({ ...pf, ...patch }));
  }

  function toggleRetryMethod(method: string) {
    setForm((f) => ({
      ...f,
      retryMethods: f.retryMethods.includes(method)
        ? f.retryMethods.filter((m) => m !== method)
        : [...f.retryMethods, method],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    try {
      const dto = formToDto(form, pluginsForm);
      if (editId) {
        await updateRoute(tenantId, editId, dto);
        toast.success('Route updated');
      } else {
        await createRoute(tenantId, dto);
        toast.success('Route created');
      }
      setPanelOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save route');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !tenantId) return;
    setDeleting(true);
    try {
      await deleteRoute(tenantId, deleteTarget);
      setDeleteTarget(null);
      await mutate();
      toast.success('Route deleted');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to delete route',
      );
    } finally {
      setDeleting(false);
    }
  }

  const serviceMap = Object.fromEntries(
    (services ?? []).map((s: Service) => [s.id, s.name]),
  );
  const activePluginCount = [
    pluginsForm.cors,
    pluginsForm.ipRestriction,
    pluginsForm.requestSizeLimit,
    pluginsForm.rateLimit,
    pluginsForm.requestTransform,
    pluginsForm.responseTransform,
    pluginsForm.basicAuth,
    pluginsForm.oidc,
    pluginsForm.oauth,
    pluginsForm.hmacAuth,
    pluginsForm.acl,
    pluginsForm.mtls,
  ].filter(Boolean).length;

  return (
    <div className="p-4 sm:p-8">
      {loadError && <DataLoadNotice label="Routes" onRetry={() => mutate()} />}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">Routes</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Add Route
        </button>
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-label="Routes table"
        className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Method
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Path Pattern
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Service
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Auth
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                Features
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {!routes ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  {loadError ? 'Data unavailable' : 'Loading…'}
                </td>
              </tr>
            ) : routes.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-gray-400"
                >
                  No routes configured
                </td>
              </tr>
            ) : (
              routes.map((route) => (
                <tr
                  key={route.id}
                  className={`border-b border-gray-100 last:border-0 ${!route.enabled ? 'bg-slate-50' : ''}`}
                >
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-semibold ${METHOD_COLORS[route.method] ?? 'bg-gray-100 text-gray-700'}`}
                    >
                      {route.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">
                    {route.pathPattern}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {serviceMap[route.serviceId] ?? (
                      <span className="text-gray-400">{route.serviceId}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {route.authRequired ? (
                      <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Yes
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                        No
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {route.enabled ? (
                      <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                        Active
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-400">
                        Disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {route.retry && (
                        <span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-600">
                          Retry
                        </span>
                      )}
                      {route.plugins && route.plugins.length > 0 && (
                        <span className="flex items-center gap-0.5 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600">
                          <Puzzle className="h-3 w-3" />
                          {route.plugins.length} plugin
                          {route.plugins.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {deleteTarget === route.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-600">Delete?</span>
                          <button
                            onClick={handleDelete}
                            disabled={deleting}
                            className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {deleting ? '…' : 'Delete'}
                          </button>
                          <button
                            onClick={() => setDeleteTarget(null)}
                            className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            aria-label={`Edit ${route.method} ${route.pathPattern}`}
                            onClick={() => openEdit(route)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            aria-label={`Delete ${route.method} ${route.pathPattern}`}
                            onClick={() => setDeleteTarget(route.id)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Slide-over panel */}
      {panelOpen && (
        <WorkspaceDialog
          label="Routes form"
          onClose={() => setPanelOpen(false)}
        >
          <div className="relative z-50 flex h-full w-full max-w-[600px] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-base font-semibold text-gray-900">
                {editId ? 'Edit Route' : 'Add Route'}
              </h2>
              <button
                aria-label="Close form"
                onClick={() => setPanelOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 px-6">
              {(['basic', 'advanced', 'plugins'] as PanelTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setPanelTab(tab)}
                  className={`relative px-4 py-3 text-sm font-medium capitalize transition-colors ${
                    panelTab === tab
                      ? 'border-b-2 border-blue-600 text-blue-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab}
                  {tab === 'plugins' && activePluginCount > 0 && (
                    <span className="ml-1.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-xs text-white">
                      {activePluginCount}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <form
              onSubmit={handleSubmit}
              className="flex flex-1 flex-col overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto p-6">
                {panelTab === 'basic' && (
                  <div className="flex flex-col gap-5">
                    {/* Method */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="routes-field-2"
                        className="text-sm font-medium text-gray-700"
                      >
                        Method
                      </label>
                      <select
                        id="routes-field-2"
                        aria-label="HTTP method"
                        value={form.method}
                        onChange={(e) => setF({ method: e.target.value })}
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      >
                        {METHODS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Path Pattern */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="routes-field-3"
                        className="text-sm font-medium text-gray-700"
                      >
                        Path Pattern
                      </label>
                      <input
                        id="routes-field-3"
                        type="text"
                        required
                        placeholder="/api/users"
                        aria-label="Path pattern"
                        value={form.pathPattern}
                        onChange={(e) => setF({ pathPattern: e.target.value })}
                        className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                      <p className="text-xs text-gray-400">
                        Prefix match — /api/users matches /api/users/123
                      </p>
                    </div>

                    {/* Service */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="routes-field-4"
                        className="text-sm font-medium text-gray-700"
                      >
                        Service
                      </label>
                      <select
                        id="routes-field-4"
                        required
                        aria-label="Service"
                        value={form.serviceId}
                        onChange={(e) => setF({ serviceId: e.target.value })}
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="">Select a service…</option>
                        {(services ?? []).map((s: Service) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Auth Required + Enabled */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2.5">
                        <span className="text-sm font-medium text-gray-700">
                          Auth Required
                        </span>
                        <Toggle
                          label="Authentication required"
                          value={form.authRequired}
                          onChange={(v) => setF({ authRequired: v })}
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2.5">
                        <span className="text-sm font-medium text-gray-700">
                          Enabled
                        </span>
                        <Toggle
                          label="Route enabled"
                          value={form.enabled}
                          onChange={(v) => setF({ enabled: v })}
                        />
                      </div>
                    </div>

                    {/* Rate Limit Override */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="routes-field-5"
                        className="text-sm font-medium text-gray-700"
                      >
                        Rate Limit Override{' '}
                        <span className="font-normal text-gray-400">
                          (req/min, optional)
                        </span>
                      </label>
                      <input
                        id="routes-field-5"
                        type="number"
                        min={1}
                        placeholder="Leave blank to use global limit"
                        aria-label="Rate limit override"
                        value={form.rateLimitOverride}
                        onChange={(e) =>
                          setF({ rateLimitOverride: e.target.value })
                        }
                        className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                )}

                {panelTab === 'advanced' && (
                  <div className="flex flex-col gap-5">
                    {/* Retry Policy */}
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-gray-700">
                            Retry Policy
                          </span>
                          <p className="text-xs text-gray-400">
                            Automatically retry on transient upstream errors
                          </p>
                        </div>
                        <Toggle
                          label="Retry policy"
                          value={form.retryEnabled}
                          onChange={(v) => setF({ retryEnabled: v })}
                        />
                      </div>
                      {form.retryEnabled && (
                        <div className="flex flex-col gap-3 pl-1">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                              <label
                                htmlFor="routes-field-6"
                                className="text-xs font-medium text-gray-600"
                              >
                                Max Attempts
                              </label>
                              <input
                                id="routes-field-6"
                                type="number"
                                min={1}
                                max={10}
                                aria-label="Retry attempts"
                                value={form.retryAttempts}
                                onChange={(e) =>
                                  setF({ retryAttempts: e.target.value })
                                }
                                className="rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label
                                htmlFor="routes-field-7"
                                className="text-xs font-medium text-gray-600"
                              >
                                Retry on Status Codes
                              </label>
                              <input
                                id="routes-field-7"
                                type="text"
                                placeholder="502,503,504"
                                aria-label="Retry status codes"
                                value={form.retryOn}
                                onChange={(e) =>
                                  setF({ retryOn: e.target.value })
                                }
                                className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                              />
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium text-gray-600">
                              Retry Methods{' '}
                              <span className="font-normal text-gray-400">
                                (POST/PUT/DELETE require idempotent downstream)
                              </span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                              {RETRY_METHODS.map((m) => (
                                <label
                                  key={m}
                                  className="flex cursor-pointer items-center gap-1.5"
                                >
                                  <input
                                    type="checkbox"
                                    checked={form.retryMethods.includes(m)}
                                    onChange={() => toggleRetryMethod(m)}
                                    className="rounded border-gray-300 text-blue-600"
                                  />
                                  <span className="text-xs text-gray-700">
                                    {m}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {panelTab === 'plugins' && (
                  <PluginsTab pf={pluginsForm} setPf={setPf} />
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-gray-200 p-6">
                <button
                  type="button"
                  aria-label="Close form"
                  onClick={() => setPanelOpen(false)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editId ? 'Save Changes' : 'Add Route'}
                </button>
              </div>
            </form>
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}
