import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  DEFAULT_PORTAL_KEYS_PER_DEVELOPER,
  MAX_PORTAL_KEYS_PER_DEVELOPER,
  PORTAL_TITLE_MAX,
  type PortalCatalog,
  type PortalCatalogRoute,
  type PortalSettings,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import {
  CATALOG_COLUMNS,
  CATALOG_FILTER,
  CATALOG_ORDER,
  catalogRoute,
} from './portal-catalog';

export const INITIAL_PORTAL_REVISION = '00000000-0000-0000-0000-000000000000';
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const HOST =
  /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/;
const GROUP = /^[A-Za-z\d][A-Za-z\d._:-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const CATALOG_LIMIT = 500;

interface SettingsRow {
  enabled: boolean;
  title: string;
  custom_domain: string | null;
  api_base_url: string | null;
  signup: 'open' | 'closed';
  default_groups: string[];
  max_keys_per_developer: number;
  revision: string;
  updated_at: Date | null;
}

export function canonicalTenant(tenantId: string): string {
  return tenantSchema(tenantId).slice(7).replace(/_/g, '-');
}

export function normalizeHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  return HOST.test(host) ? host : undefined;
}

/** An https origin (optionally with a path prefix) without credentials, query or fragment. */
export function publicOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !normalizeHost(url.hostname)
    )
      return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

@Injectable()
export class PortalService implements OnModuleDestroy {
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly db: DataSource) {}

  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.operations]);
  }

  /** Public reads share a larger budget than workspace edits. */
  async admitted<T>(limit: number, fn: () => Promise<T>): Promise<T> {
    if (this.stopping || this.operations.size >= limit)
      throw new ServiceUnavailableException(
        'The developer portal is busy. Try again shortly.',
      );
    const work = fn();
    this.operations.add(work);
    try {
      return await work;
    } finally {
      this.operations.delete(work);
    }
  }

  private async bounded(manager: EntityManager) {
    await manager.query(
      `SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'`,
    );
  }

  private settings(row: SettingsRow | undefined, name: string): PortalSettings {
    return row
      ? {
          enabled: row.enabled,
          title: row.title,
          customDomain: row.custom_domain,
          apiBaseUrl: row.api_base_url,
          signup: row.signup,
          defaultGroups: row.default_groups,
          maxKeysPerDeveloper: row.max_keys_per_developer,
          revision: row.revision,
          updatedAt: row.updated_at
            ? new Date(row.updated_at).toISOString()
            : null,
        }
      : {
          enabled: false,
          title: `${name} API`.slice(0, PORTAL_TITLE_MAX),
          customDomain: null,
          apiBaseUrl: null,
          signup: 'open',
          defaultGroups: [],
          maxKeysPerDeveloper: DEFAULT_PORTAL_KEYS_PER_DEVELOPER,
          revision: INITIAL_PORTAL_REVISION,
          updatedAt: null,
        };
  }

  async readSettings(
    manager: EntityManager,
    tenant: string,
    lock = false,
  ): Promise<PortalSettings> {
    const [owner] = await manager.query(
      `SELECT name FROM public.tenants WHERE id=$1${lock ? ' FOR NO KEY UPDATE' : ''}`,
      [tenant],
    );
    if (!owner) throw new NotFoundException('Workspace not found');
    const [row]: SettingsRow[] = await manager.query(
      `SELECT enabled,title,custom_domain,api_base_url,signup,default_groups,max_keys_per_developer,revision,updated_at
       FROM public.portal_settings WHERE tenant_id=$1`,
      [tenant],
    );
    return this.settings(row, owner.name);
  }

  getSettings(tenantId: string): Promise<PortalSettings> {
    const tenant = canonicalTenant(tenantId);
    return this.admitted(8, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        return this.readSettings(manager, tenant);
      }),
    );
  }

  saveSettings(tenantId: string, input: unknown): Promise<PortalSettings> {
    const tenant = canonicalTenant(tenantId);
    const next = this.validate(input);
    return this.admitted(8, () =>
      this.db
        .transaction(async (manager) => {
          await this.bounded(manager);
          const current = await this.readSettings(manager, tenant, true);
          if (current.revision !== next.expectedRevision)
            throw new ConflictException(
              'Portal settings changed. Reload the current settings before saving.',
            );
          const [row]: SettingsRow[] = await manager.query(
            `INSERT INTO public.portal_settings
               (tenant_id,enabled,title,custom_domain,api_base_url,signup,default_groups,max_keys_per_developer,revision,updated_at)
             VALUES ($1,$2,$3,$4,$8,$5,$6,$7,gen_random_uuid(),clock_timestamp())
             ON CONFLICT (tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,title=EXCLUDED.title,
               custom_domain=EXCLUDED.custom_domain,api_base_url=EXCLUDED.api_base_url,signup=EXCLUDED.signup,default_groups=EXCLUDED.default_groups,
               max_keys_per_developer=EXCLUDED.max_keys_per_developer,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at
             RETURNING enabled,title,custom_domain,api_base_url,signup,default_groups,max_keys_per_developer,revision,updated_at`,
            [
              tenant,
              next.enabled,
              next.title,
              next.customDomain,
              next.signup,
              JSON.stringify(next.defaultGroups),
              next.maxKeysPerDeveloper,
              next.apiBaseUrl,
            ],
          );
          return this.settings(row, '');
        })
        .catch((error: { code?: string; constraint?: string }) => {
          if (
            error?.code === '23505' &&
            error.constraint === 'portal_settings_custom_domain_key'
          )
            throw new ConflictException(
              'Another workspace already uses this portal domain.',
            );
          throw error;
        }),
    );
  }

  private validate(input: unknown) {
    const fail = (message: string): never => {
      throw new BadRequestException(message);
    };
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Portal settings are required');
    const body = input as Record<string, unknown>;
    const keys = [
      'enabled',
      'title',
      'customDomain',
      'apiBaseUrl',
      'signup',
      'defaultGroups',
      'maxKeysPerDeveloper',
      'expectedRevision',
    ];
    if (
      Object.keys(body).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(body, key))
    )
      fail(`Send exactly: ${keys.join(', ')}`);
    if (
      typeof body.expectedRevision !== 'string' ||
      !UUID.test(body.expectedRevision)
    )
      fail('A current portal settings revision is required');
    if (typeof body.enabled !== 'boolean')
      fail('enabled must be true or false');
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > PORTAL_TITLE_MAX || CONTROL.test(title))
      fail(`Give the portal a title of 1 to ${PORTAL_TITLE_MAX} characters`);
    let customDomain: string | null = null;
    if (body.customDomain !== null && body.customDomain !== '') {
      const host = normalizeHost(body.customDomain);
      if (!host)
        fail(
          'Use a host name such as portal.example.com, without a scheme or path',
        );
      customDomain = host as string;
    }
    let apiBaseUrl: string | null = null;
    if (body.apiBaseUrl !== null && body.apiBaseUrl !== '') {
      apiBaseUrl = publicOrigin(body.apiBaseUrl) ?? null;
      if (!apiBaseUrl)
        fail(
          'Use the HTTPS origin callers use for your gateway, such as https://api.example.com',
        );
    }
    if (body.signup !== 'open' && body.signup !== 'closed')
      fail('signup must be open or closed');
    const groups = body.defaultGroups;
    if (
      !Array.isArray(groups) ||
      groups.length > 16 ||
      !groups.every(
        (group) => typeof group === 'string' && GROUP.test(group),
      ) ||
      new Set(groups).size !== groups.length
    )
      fail(
        'Default groups are up to 16 distinct names of letters, digits, dot, underscore, colon or hyphen',
      );
    const max = body.maxKeysPerDeveloper;
    if (
      typeof max !== 'number' ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > MAX_PORTAL_KEYS_PER_DEVELOPER
    )
      fail(
        `Each developer can hold 1 to ${MAX_PORTAL_KEYS_PER_DEVELOPER} active keys`,
      );
    return {
      enabled: body.enabled as boolean,
      title,
      customDomain,
      apiBaseUrl,
      signup: body.signup as 'open' | 'closed',
      defaultGroups: groups as string[],
      maxKeysPerDeveloper: max as number,
      expectedRevision: (body.expectedRevision as string).toLowerCase(),
    };
  }

  /** Resolves an enabled portal's custom domain to its workspace. */
  resolveDomain(value: unknown): Promise<{ tenantId: string }> {
    const host = normalizeHost(value);
    if (!host) throw new NotFoundException('Portal not found');
    return this.admitted(64, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const [row] = await manager.query(
          `SELECT tenant_id FROM public.portal_settings WHERE custom_domain=$1 AND enabled`,
          [host],
        );
        if (!row) throw new NotFoundException('Portal not found');
        return { tenantId: row.tenant_id };
      }),
    );
  }

  /** Published routes. Public callers see only enabled portals. */
  catalog(tenantId: string, publicView: boolean): Promise<PortalCatalog> {
    const tenant = canonicalTenant(tenantId);
    return this.admitted(64, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const settings = await this.readSettings(manager, tenant).catch(
          (error) => {
            if (publicView && error instanceof NotFoundException)
              throw new NotFoundException('Portal not found');
            throw error;
          },
        );
        if (publicView && !settings.enabled)
          throw new NotFoundException('Portal not found');
        const rows = await manager.query(
          `SELECT ${CATALOG_COLUMNS} FROM ${tenantSchema(tenant)}.routes
           WHERE ${CATALOG_FILTER} ORDER BY ${CATALOG_ORDER} LIMIT ${CATALOG_LIMIT}`,
        );
        return {
          tenantId: tenant,
          title: settings.title,
          apiBaseUrl: settings.apiBaseUrl,
          signup: settings.signup,
          routes: rows.map(catalogRoute),
        };
      }),
    );
  }

  catalogEntry(tenantId: string, routeId: string): Promise<PortalCatalogRoute> {
    const tenant = canonicalTenant(tenantId);
    if (!UUID.test(routeId)) throw new NotFoundException('Route not found');
    return this.admitted(64, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const [settings] = await manager.query(
          `SELECT enabled FROM public.portal_settings WHERE tenant_id=$1`,
          [tenant],
        );
        if (!settings?.enabled) throw new NotFoundException('Portal not found');
        const [row] = await manager.query(
          `SELECT ${CATALOG_COLUMNS} FROM ${tenantSchema(tenant)}.routes WHERE id=$1 AND ${CATALOG_FILTER}`,
          [routeId],
        );
        if (!row) throw new NotFoundException('Route not found');
        return catalogRoute(row);
      }),
    );
  }
}
