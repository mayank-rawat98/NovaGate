import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { sign, verify } from 'jsonwebtoken';
import { DataSource, EntityManager } from 'typeorm';
import {
  MAX_PORTAL_DEVELOPERS,
  PORTAL_DEVELOPER_SESSION_HOURS,
  type ConsumerUsageStats,
  type CreatedPortalKey,
  type PortalDeveloper,
  type PortalDeveloperProfile,
  type PortalDeveloperSession,
  type PortalKey,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';
import { platformJwtSecret } from '../auth/platform-jwt-secret';
import { ConfigPushService } from '../config-push/config-push.service';
import { ConsumerAnalyticsService } from '../proxy-config/consumer-analytics.service';
import { EmailService } from '../email/email.service';
import { canonicalTenant, PortalService } from './portal.service';

export const PORTAL_SESSION_AUDIENCE = 'novagate-portal';
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LOCK_ATTEMPTS = 10;
const LOCK_MINUTES = 15;
const VERIFY_HOURS = 24;
const BCRYPT_COST = 10;
const KEY_COLUMNS = `id,"portalKeyName" AS name,"createdAt","revokedAt"`;

export interface PortalPrincipal {
  developerId: string;
  tenantId: string;
}

/**
 * Developer sessions use a key derived from the platform secret with a
 * distinct audience, so they can never be accepted as workspace sessions.
 */
export function portalSessionSecret(): string {
  return createHmac('sha256', platformJwtSecret())
    .update('novagate-portal-developer-session-v1')
    .digest('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class PortalDevelopersService implements OnModuleDestroy {
  private readonly logger = new Logger(PortalDevelopersService.name);
  private readonly secret = portalSessionSecret();
  /** Compared for unknown accounts so login timing does not reveal them. */
  private readonly timingHash = bcrypt.hashSync(
    randomBytes(16).toString('hex'),
    BCRYPT_COST,
  );
  private hashing = 0;
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(
    private readonly db: DataSource,
    private readonly portal: PortalService,
    private readonly push: ConfigPushService,
    private readonly analytics: ConsumerAnalyticsService,
    private readonly email: EmailService,
  ) {}

  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.operations]);
  }

  private async admitted<T>(limit: number, fn: () => Promise<T>): Promise<T> {
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

  /** Bounds concurrent bcrypt work, which is deliberately CPU-expensive. */
  private async hashed<T>(fn: () => Promise<T>): Promise<T> {
    if (this.hashing >= 8)
      throw new ServiceUnavailableException(
        'Sign-in is busy. Try again shortly.',
      );
    this.hashing++;
    try {
      return await fn();
    } finally {
      this.hashing--;
    }
  }

  private async bounded(manager: EntityManager) {
    await manager.query(
      `SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'`,
    );
  }

  private session(
    tenant: string,
    developer: {
      id: string;
      email: string;
      name: string;
      session_version: number;
    },
  ): PortalDeveloperSession {
    const expiresAt = new Date(
      Date.now() + PORTAL_DEVELOPER_SESSION_HOURS * 3600000,
    );
    const token = sign(
      { tid: tenant, ver: developer.session_version },
      this.secret,
      {
        algorithm: 'HS256',
        audience: PORTAL_SESSION_AUDIENCE,
        subject: developer.id,
        expiresIn: PORTAL_DEVELOPER_SESSION_HOURS * 3600,
      },
    );
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      developer: {
        id: developer.id,
        email: developer.email,
        name: developer.name,
      },
    };
  }

  private credentials(input: unknown, register: boolean) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Email and password are required');
    const body = input as Record<string, unknown>;
    const allowed = register
      ? ['email', 'name', 'password']
      : ['email', 'password'];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new BadRequestException(`Only ${allowed.join(', ')} are accepted`);
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 320 || !EMAIL.test(email))
      throw new BadRequestException('Enter a valid email address');
    const password = typeof body.password === 'string' ? body.password : '';
    // bcrypt reads at most 72 bytes; refuse longer input rather than truncate it.
    if (register && (password.length < 10 || Buffer.byteLength(password) > 72))
      throw new BadRequestException(
        'Use a password of at least 10 characters and at most 72 bytes',
      );
    if (!register && (!password || Buffer.byteLength(password) > 72))
      throw new UnauthorizedException('Invalid email or password');
    let name = '';
    if (register) {
      name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 128 || CONTROL.test(name))
        throw new BadRequestException('Enter a name of 1 to 128 characters');
    }
    return { email, password, name };
  }

  private verifyUrl(
    tenant: string,
    customDomain: string | null,
    token: string,
  ) {
    const base = customDomain
      ? `https://${customDomain}`
      : `${(process.env.PORTAL_URL ?? 'http://localhost:3004').replace(/\/+$/, '')}/w/${tenant}`;
    return `${base}/verify?token=${token}`;
  }

  /** Enumeration-safe: every accepted request returns the same result. */
  register(tenantId: string, input: unknown): Promise<void> {
    const tenant = canonicalTenant(tenantId);
    const { email, password, name } = this.credentials(input, true);
    return this.admitted(32, async () => {
      const passwordHash = await this.hashed(() =>
        bcrypt.hash(password, BCRYPT_COST),
      );
      const token = randomBytes(32).toString('hex');
      const outcome = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const settings = await this.portal.readSettings(manager, tenant);
        if (!settings.enabled) throw new NotFoundException('Portal not found');
        if (settings.signup !== 'open')
          throw new ForbiddenException(
            'Registration is closed for this portal. Contact the API provider.',
          );
        const schema = tenantSchema(tenant);
        const [existing] = await manager.query(
          `SELECT id,status FROM ${schema}.portal_developers WHERE lower(email)=$1 FOR UPDATE`,
          [email],
        );
        if (existing) {
          if (existing.status !== 'pending') return undefined;
          // Refresh an unfinished signup; the new password replaces the old one.
          await manager.query(
            `UPDATE ${schema}.portal_developers SET name=$2,password_hash=$3,verify_token_hash=$4,
               verify_expires=clock_timestamp()+make_interval(hours=>${VERIFY_HOURS}),session_version=session_version+1
             WHERE id=$1`,
            [existing.id, name, passwordHash, digest(token)],
          );
          return settings;
        }
        const [{ total }] = await manager.query(
          `SELECT count(*)::int AS total FROM ${schema}.portal_developers`,
        );
        if (total >= MAX_PORTAL_DEVELOPERS)
          throw new ConflictException(
            'This portal has reached its developer limit. Contact the API provider.',
          );
        await manager.query(
          `INSERT INTO ${schema}.portal_developers (email,name,password_hash,verify_token_hash,verify_expires)
           VALUES ($1,$2,$3,$4,clock_timestamp()+make_interval(hours=>${VERIFY_HOURS}))
           ON CONFLICT DO NOTHING`,
          [email, name, passwordHash, digest(token)],
        );
        return settings;
      });
      if (!outcome) return;
      await this.email
        .sendPortalVerification(
          email,
          this.verifyUrl(tenant, outcome.customDomain, token),
          outcome.title,
        )
        .catch(() =>
          this.logger.warn(
            'Portal verification email failed; the developer can register again to resend it',
          ),
        );
    });
  }

  verifyEmail(
    tenantId: string,
    input: unknown,
  ): Promise<PortalDeveloperSession> {
    const tenant = canonicalTenant(tenantId);
    const token =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).token
        : undefined;
    if (typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token))
      throw new BadRequestException(
        'This verification link is invalid or expired',
      );
    return this.admitted(32, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const settings = await this.portal.readSettings(manager, tenant);
        if (!settings.enabled) throw new NotFoundException('Portal not found');
        const [[row]] = await manager.query(
          `UPDATE ${tenantSchema(tenant)}.portal_developers
           SET status='active',verify_token_hash=NULL,verify_expires=NULL,last_login_at=clock_timestamp()
           WHERE verify_token_hash=$1 AND verify_expires > clock_timestamp() AND status='pending'
           RETURNING id,email,name,session_version`,
          [digest(token)],
        );
        if (!row)
          throw new BadRequestException(
            'This verification link is invalid or expired',
          );
        return this.session(tenant, row);
      }),
    );
  }

  login(tenantId: string, input: unknown): Promise<PortalDeveloperSession> {
    const tenant = canonicalTenant(tenantId);
    const { email, password } = this.credentials(input, false);
    return this.admitted(32, async () => {
      const schema = tenantSchema(tenant);
      const row = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const settings = await this.portal.readSettings(manager, tenant);
        if (!settings.enabled) throw new NotFoundException('Portal not found');
        const [found] = await manager.query(
          `SELECT id,email,name,status,password_hash,session_version,
             (locked_until IS NOT NULL AND locked_until > clock_timestamp()) AS locked
           FROM ${schema}.portal_developers WHERE lower(email)=$1`,
          [email],
        );
        return found;
      });
      const matches = await this.hashed(() =>
        bcrypt.compare(password, row?.password_hash ?? this.timingHash),
      );
      const invalid = new UnauthorizedException(
        'Invalid email or password, or too many recent attempts. Try again later.',
      );
      if (!row) throw invalid;
      if (row.locked || !matches) {
        if (!row.locked)
          await this.db.query(
            `UPDATE ${schema}.portal_developers SET
               failed_logins=CASE WHEN failed_logins+1 >= ${LOCK_ATTEMPTS} THEN 0 ELSE failed_logins+1 END,
               locked_until=CASE WHEN failed_logins+1 >= ${LOCK_ATTEMPTS} THEN clock_timestamp()+make_interval(mins=>${LOCK_MINUTES}) ELSE locked_until END
             WHERE id=$1`,
            [row.id],
          );
        throw invalid;
      }
      if (row.status === 'pending')
        throw new ForbiddenException(
          'Confirm your email before signing in. Register again to resend the link.',
        );
      if (row.status !== 'active')
        throw new ForbiddenException(
          'Portal access for this account is suspended. Contact the API provider.',
        );
      await this.db.query(
        `UPDATE ${schema}.portal_developers SET failed_logins=0,locked_until=NULL,last_login_at=clock_timestamp() WHERE id=$1`,
        [row.id],
      );
      return this.session(tenant, row);
    });
  }

  /** Verifies a developer session against the current account and portal state. */
  authenticate(
    tenantId: string,
    token: string,
  ): Promise<PortalPrincipal & { profile: PortalDeveloperProfile }> {
    const unauthorized = new UnauthorizedException(
      'Your portal session is invalid or expired. Sign in again.',
    );
    let payload: { sub?: unknown; tid?: unknown; ver?: unknown };
    try {
      payload = verify(token, this.secret, {
        algorithms: ['HS256'],
        audience: PORTAL_SESSION_AUDIENCE,
      }) as typeof payload;
    } catch {
      return Promise.reject(unauthorized);
    }
    let tenant: string;
    try {
      tenant = canonicalTenant(tenantId);
    } catch {
      return Promise.reject(unauthorized);
    }
    if (
      typeof payload.sub !== 'string' ||
      !UUID.test(payload.sub) ||
      payload.tid !== tenant ||
      typeof payload.ver !== 'number'
    )
      return Promise.reject(unauthorized);
    const developerId = payload.sub;
    return this.admitted(64, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const [row] = await manager.query(
          `SELECT d.email,d.name FROM ${tenantSchema(tenant)}.portal_developers d
           JOIN public.portal_settings s ON s.tenant_id=$3 AND s.enabled
           WHERE d.id=$1 AND d.status='active' AND d.session_version=$2`,
          [developerId, payload.ver, tenant],
        );
        if (!row) throw unauthorized;
        return {
          developerId,
          tenantId: tenant,
          profile: { id: developerId, email: row.email, name: row.name },
        };
      }),
    );
  }

  private key(row: {
    id: string;
    name: string;
    createdAt: Date;
    revokedAt: Date | null;
  }): PortalKey {
    return {
      id: row.id,
      name: row.name,
      createdAt: new Date(row.createdAt).toISOString(),
      revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
    };
  }

  /** Stored consumer names carry the developer email so operators can recognise them. */
  private static keyLabel(name: string, email: string) {
    return `${name} (portal: ${email})`.slice(0, 128);
  }

  listKeys(principal: PortalPrincipal): Promise<PortalKey[]> {
    return this.admitted(64, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const rows = await manager.query(
          `SELECT ${KEY_COLUMNS} FROM ${tenantSchema(principal.tenantId)}.consumers
           WHERE "portalDeveloperId"=$1 ORDER BY "revokedAt" NULLS FIRST,"createdAt" DESC,id LIMIT 100`,
          [principal.developerId],
        );
        return rows.map((row: Parameters<PortalDevelopersService['key']>[0]) =>
          this.key(row),
        );
      }),
    );
  }

  createKey(
    principal: PortalPrincipal,
    input: unknown,
  ): Promise<CreatedPortalKey> {
    const body =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (
      !body ||
      Object.keys(body).some((key) => key !== 'name') ||
      !name ||
      name.length > 64 ||
      CONTROL.test(name)
    )
      throw new BadRequestException(
        'Name the key with 1 to 64 printable characters',
      );
    const tenant = principal.tenantId;
    const schema = tenantSchema(tenant);
    return this.admitted(16, async () => {
      const result = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const settings = await this.portal.readSettings(manager, tenant);
        const [developer] = await manager.query(
          `SELECT email FROM ${schema}.portal_developers WHERE id=$1 AND status='active' FOR UPDATE`,
          [principal.developerId],
        );
        if (!developer || !settings.enabled)
          throw new UnauthorizedException(
            'Your portal session is invalid or expired. Sign in again.',
          );
        const [{ active }] = await manager.query(
          `SELECT count(*)::int AS active FROM ${schema}.consumers WHERE "portalDeveloperId"=$1 AND "revokedAt" IS NULL`,
          [principal.developerId],
        );
        if (active >= settings.maxKeysPerDeveloper)
          throw new ConflictException(
            `You can hold ${settings.maxKeysPerDeveloper} active keys. Revoke an unused key first.`,
          );
        const apiKey = `gw_${tenant}_${randomBytes(32).toString('hex')}`;
        const [row] = await manager.query(
          `INSERT INTO ${schema}.consumers (name,"keyHash","rateLimitTier",groups,"portalDeveloperId","portalKeyName")
           VALUES ($1,$2,'authenticated',$3,$4,$5) RETURNING ${KEY_COLUMNS}`,
          [
            PortalDevelopersService.keyLabel(name, developer.email),
            digest(apiKey),
            JSON.stringify(settings.defaultGroups),
            principal.developerId,
            name,
          ],
        );
        const payload = await this.push.persistUpdate(tenant, manager);
        return { key: { ...this.key(row), apiKey }, payload };
      });
      // A failed publication is retried from the durable outbox.
      await this.push.publish(result.payload);
      return result.key;
    });
  }

  revokeKey(principal: PortalPrincipal, keyId: string): Promise<PortalKey> {
    if (!UUID.test(keyId)) throw new NotFoundException('Key not found');
    const tenant = principal.tenantId;
    const schema = tenantSchema(tenant);
    return this.admitted(16, async () => {
      const result = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const [[changed]] = await manager.query(
          `UPDATE ${schema}.consumers SET "revokedAt"=clock_timestamp()
           WHERE id=$1 AND "portalDeveloperId"=$2 AND "revokedAt" IS NULL
           RETURNING ${KEY_COLUMNS}`,
          [keyId, principal.developerId],
        );
        if (changed)
          return {
            key: this.key(changed),
            payload: await this.push.persistUpdate(tenant, manager),
          };
        const [existing] = await manager.query(
          `SELECT ${KEY_COLUMNS} FROM ${schema}.consumers
           WHERE id=$1 AND "portalDeveloperId"=$2`,
          [keyId, principal.developerId],
        );
        if (!existing) throw new NotFoundException('Key not found');
        return { key: this.key(existing), payload: undefined };
      });
      if (result.payload) await this.push.publish(result.payload);
      return result.key;
    });
  }

  async usage(
    principal: PortalPrincipal,
    keyId: string,
    period: unknown,
  ): Promise<ConsumerUsageStats> {
    if (!UUID.test(keyId)) throw new NotFoundException('Key not found');
    const [owned] = await this.admitted(64, () =>
      this.db.query(
        `SELECT ${KEY_COLUMNS} FROM ${tenantSchema(principal.tenantId)}.consumers WHERE id=$1 AND "portalDeveloperId"=$2`,
        [keyId, principal.developerId],
      ),
    );
    if (!owned) throw new NotFoundException('Key not found');
    const stats = await this.analytics.get(principal.tenantId, keyId, period);
    // Present the developer's own key name, not the operator-facing label.
    return {
      ...stats,
      consumer: { ...stats.consumer, name: owned.name },
    };
  }

  listDevelopers(tenantId: string): Promise<PortalDeveloper[]> {
    const tenant = canonicalTenant(tenantId);
    return this.admitted(8, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const schema = tenantSchema(tenant);
        const rows = await manager.query(
          `SELECT d.id,d.email,d.name,d.status,d.created_at,d.last_login_at,
             (SELECT count(*)::int FROM ${schema}.consumers c WHERE c."portalDeveloperId"=d.id AND c."revokedAt" IS NULL) AS active_keys
           FROM ${schema}.portal_developers d ORDER BY d.created_at DESC,d.id LIMIT 500`,
        );
        return rows.map(
          (row: {
            id: string;
            email: string;
            name: string;
            status: PortalDeveloper['status'];
            created_at: Date;
            last_login_at: Date | null;
            active_keys: number;
          }) => ({
            id: row.id,
            email: row.email,
            name: row.name,
            status: row.status,
            createdAt: new Date(row.created_at).toISOString(),
            lastLoginAt: row.last_login_at
              ? new Date(row.last_login_at).toISOString()
              : null,
            activeKeys: row.active_keys,
          }),
        );
      }),
    );
  }

  /**
   * Suspension ends sessions and revokes every active key immediately.
   * Reactivation restores sign-in only; developers create new keys.
   */
  setStatus(
    tenantId: string,
    developerId: string,
    input: unknown,
  ): Promise<{ status: 'active' | 'suspended'; revokedKeys: number }> {
    const tenant = canonicalTenant(tenantId);
    if (!UUID.test(developerId))
      throw new NotFoundException('Developer not found');
    const status =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).status
        : undefined;
    if (
      (status !== 'active' && status !== 'suspended') ||
      Object.keys(input as object).length !== 1
    )
      throw new BadRequestException('Set status to active or suspended');
    const schema = tenantSchema(tenant);
    return this.admitted(8, async () => {
      const result = await this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const [[row]] = await manager.query(
          `UPDATE ${schema}.portal_developers SET status=$2::varchar,session_version=session_version+1,
             verify_token_hash=CASE WHEN $2::varchar='active' THEN NULL ELSE verify_token_hash END
           WHERE id=$1 RETURNING id`,
          [developerId, status],
        );
        if (!row) throw new NotFoundException('Developer not found');
        let revoked = 0;
        if (status === 'suspended') {
          const [, count] = await manager.query(
            `UPDATE ${schema}.consumers SET "revokedAt"=clock_timestamp() WHERE "portalDeveloperId"=$1 AND "revokedAt" IS NULL`,
            [developerId],
          );
          revoked = count;
        }
        return {
          response: {
            status: status as 'active' | 'suspended',
            revokedKeys: revoked,
          },
          payload: revoked
            ? await this.push.persistUpdate(tenant, manager)
            : undefined,
        };
      });
      if (result.payload) await this.push.publish(result.payload);
      return result.response;
    });
  }
}
