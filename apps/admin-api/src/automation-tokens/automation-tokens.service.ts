import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  AUTOMATION_TOKEN_NAME_MAX,
  AUTOMATION_TOKEN_PREFIX,
  DEFAULT_AUTOMATION_TOKEN_DAYS,
  MAX_ACTIVE_AUTOMATION_TOKENS,
  MAX_AUTOMATION_TOKEN_DAYS,
  isAutomationTokenScope,
  type AutomationTokenScope,
  type AutomationTokenSummary,
  type CreatedAutomationToken,
} from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';

const TOKEN_PATTERN = new RegExp(
  `^${AUTOMATION_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`,
);
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const SUMMARY_COLUMNS = `id,name,scopes,display_prefix,created_at,expires_at,last_used_at,revoked_at`;
/** Bounds the last-used write to one per token per minute. */
const LAST_USED_RESOLUTION = `interval '60 seconds'`;

export interface AutomationPrincipal {
  tokenId: string;
  tenantId: string;
  scopes: string[];
  expiresAt: number;
}

/** Streams opened by a token close within this bound so revocation applies. */
export const AUTOMATION_STREAM_RECHECK_MS = 60_000;

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  display_prefix: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export function hashAutomationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function looksLikeAutomationToken(token: string): boolean {
  return token.startsWith(AUTOMATION_TOKEN_PREFIX);
}

@Injectable()
export class AutomationTokensService implements OnModuleDestroy {
  private stopping = false;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly db: DataSource) {}

  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled([...this.operations]);
  }

  /** Authentication lookups get a larger budget than management writes. */
  private async admitted<T>(limit: number, fn: () => Promise<T>): Promise<T> {
    if (this.stopping || this.operations.size >= limit)
      throw new ServiceUnavailableException(
        'Token verification is busy. Try again shortly.',
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

  private summary(row: TokenRow): AutomationTokenSummary {
    return {
      id: row.id,
      name: row.name,
      scopes: row.scopes as AutomationTokenScope[],
      displayPrefix: row.display_prefix,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      lastUsedAt: row.last_used_at
        ? new Date(row.last_used_at).toISOString()
        : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    };
  }

  private tenant(tenantId: string): string {
    // Canonical lowercase UUID; tenantSchema rejects malformed identifiers.
    return tenantSchema(tenantId).slice(7).replace(/_/g, '-');
  }

  list(tenantId: string): Promise<AutomationTokenSummary[]> {
    const id = this.tenant(tenantId);
    return this.admitted(8, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const rows: TokenRow[] = await manager.query(
          `SELECT ${SUMMARY_COLUMNS} FROM public.automation_tokens WHERE tenant_id=$1
           ORDER BY created_at DESC, id DESC LIMIT 200`,
          [id],
        );
        return rows.map((row) => this.summary(row));
      }),
    );
  }

  create(tenantId: string, input: unknown): Promise<CreatedAutomationToken> {
    const id = this.tenant(tenantId);
    const { name, scopes, days } = this.validate(input);
    return this.admitted(8, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        // Serialize the active-token limit per workspace.
        const [owner] = await manager.query(
          `SELECT id FROM public.tenants WHERE id=$1 FOR NO KEY UPDATE`,
          [id],
        );
        if (!owner) throw new NotFoundException('Workspace not found');
        const [{ active }] = await manager.query(
          `SELECT count(*)::int AS active FROM public.automation_tokens
           WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
          [id],
        );
        if (active >= MAX_ACTIVE_AUTOMATION_TOKENS)
          throw new ConflictException(
            `A workspace can have at most ${MAX_ACTIVE_AUTOMATION_TOKENS} active tokens. Revoke an unused token first.`,
          );
        const token = `${AUTOMATION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
        const [row]: TokenRow[] = await manager.query(
          `INSERT INTO public.automation_tokens (tenant_id,name,scopes,token_hash,display_prefix,expires_at)
           VALUES ($1,$2,$3,$4,$5,clock_timestamp() + make_interval(days => $6))
           RETURNING ${SUMMARY_COLUMNS}`,
          [
            id,
            name,
            scopes,
            hashAutomationToken(token),
            token.slice(0, AUTOMATION_TOKEN_PREFIX.length + 6),
            days,
          ],
        );
        return { ...this.summary(row), token };
      }),
    );
  }

  /** Idempotent: revoking an already revoked token returns its first revocation. */
  revoke(tenantId: string, tokenId: string): Promise<AutomationTokenSummary> {
    const id = this.tenant(tenantId);
    if (!UUID.test(tokenId)) throw new NotFoundException('Token not found');
    return this.admitted(8, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        // TypeORM returns [rows, affectedCount] for UPDATE ... RETURNING.
        const [[row]]: [TokenRow[], number] = await manager.query(
          `UPDATE public.automation_tokens SET revoked_at=COALESCE(revoked_at,clock_timestamp())
           WHERE tenant_id=$1 AND id=$2 RETURNING ${SUMMARY_COLUMNS}`,
          [id, tokenId],
        );
        if (!row) throw new NotFoundException('Token not found');
        return this.summary(row);
      }),
    );
  }

  /**
   * Resolves an active token. Returns undefined for unknown, malformed,
   * revoked or expired tokens so callers present one indistinguishable error.
   */
  authenticate(token: string): Promise<AutomationPrincipal | undefined> {
    if (!TOKEN_PATTERN.test(token)) return Promise.resolve(undefined);
    const digest = hashAutomationToken(token);
    return this.admitted(64, () =>
      this.db.transaction(async (manager) => {
        await this.bounded(manager);
        const [row] = await manager.query(
          `SELECT id,tenant_id,scopes,expires_at,
             (last_used_at IS NULL OR last_used_at < clock_timestamp() - ${LAST_USED_RESOLUTION}) AS stale
           FROM public.automation_tokens
           WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
          [digest],
        );
        if (!row) return undefined;
        if (row.stale)
          await manager.query(
            `UPDATE public.automation_tokens SET last_used_at=clock_timestamp()
             WHERE id=$1 AND revoked_at IS NULL`,
            [row.id],
          );
        return {
          tokenId: row.id,
          tenantId: row.tenant_id,
          scopes: row.scopes,
          expiresAt: new Date(row.expires_at).getTime(),
        };
      }),
    );
  }

  private validate(input: unknown): {
    name: string;
    scopes: AutomationTokenScope[];
    days: number;
  } {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Token details are required');
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some(
        (key) => !['name', 'scopes', 'expiresInDays'].includes(key),
      )
    )
      throw new BadRequestException(
        'Only name, scopes and expiresInDays are accepted',
      );
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (
      !name ||
      name.length > AUTOMATION_TOKEN_NAME_MAX ||
      // Reject control characters so names stay safe in terminals and logs.
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f]/.test(name)
    )
      throw new BadRequestException(
        `Name the token with 1 to ${AUTOMATION_TOKEN_NAME_MAX} printable characters`,
      );
    const scopes = body.scopes;
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      !scopes.every(isAutomationTokenScope) ||
      new Set(scopes).size !== scopes.length
    )
      throw new BadRequestException('Choose one or more distinct valid scopes');
    const days = body.expiresInDays ?? DEFAULT_AUTOMATION_TOKEN_DAYS;
    if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_AUTOMATION_TOKEN_DAYS
    )
      throw new BadRequestException(
        `Tokens expire after 1 to ${MAX_AUTOMATION_TOKEN_DAYS} whole days`,
      );
    return { name, scopes: [...scopes].sort(), days };
  }
}
