import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { DataSource } from 'typeorm';
import type { Response } from 'express';
import { redactRequestLog } from '@api-gateway/shared-types';
import { platformJwtSecret } from '../auth/platform-jwt-secret';
import { tenantSchema } from '../tenants/tenant-schema';
import { RETENTION_CUTOFF_SQL } from '../log-retention/log-retention.policy';

interface Cursor {
  tenant: string;
  receipt: string;
  id: string;
  expires: number;
}
interface Client {
  tenant: string;
  response: Response;
  cursor?: Cursor;
  deadline: number;
  polling: boolean;
  closed: boolean;
  gap: boolean;
  timer?: ReturnType<typeof setInterval>;
  expiry?: ReturnType<typeof setTimeout>;
  drain?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  close: () => void;
}
const fields = [
  'id',
  'method',
  'path',
  'statusCode',
  'responseTimeMs',
  'requestId',
  'timestamp',
  'consumerId',
  'clientIp',
  'userAgent',
  'downstreamService',
  'downstreamLatencyMs',
  'traceId',
  'spanId',
  'errorCode',
];
const projection = fields.map((field) => `'${field}',l."${field}"`).join(',');
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const receipt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Receipt-fenced keyset reads; encrypted resume tokens keep private receipt fields private. */
@Injectable()
export class LogStreamService implements OnModuleDestroy {
  private readonly key = createHash('sha256')
    .update('novagate-log-stream-cursor-v1\0')
    .update(platformJwtSecret())
    .digest();
  private readonly clients = new Set<Client>();
  private readonly operations = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(private readonly db: DataSource) {}
  async onModuleDestroy() {
    this.stopping = true;
    const clients = [...this.clients];
    for (const client of clients) client.close();
    await Promise.allSettled([
      ...this.operations,
      ...clients.map((client) => client.done),
    ]);
  }
  private encode(value: Cursor): string {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
  }
  private decode(token: string, tenant: string): Cursor {
    try {
      if (!/^v1\.[A-Za-z\d_-]{1,1000}$/.test(token)) throw new Error();
      const bytes = Buffer.from(token.slice(3), 'base64url');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      const parsed = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString('utf8'),
      ) as Cursor;
      if (
        parsed.tenant !== tenant ||
        !receipt.test(parsed.receipt) ||
        !uuid.test(parsed.id) ||
        !Number.isSafeInteger(parsed.expires) ||
        parsed.expires <= Date.now()
      )
        throw new Error();
      return parsed;
    } catch {
      throw new BadRequestException(
        'Log cursor is invalid or expired. Start a new tail without a saved cursor.',
      );
    }
  }
  private headers(client: Client) {
    if (client.response.headersSent) return;
    client.response.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8',
    );
    client.response.setHeader('Cache-Control', 'no-store');
    client.response.setHeader('X-Accel-Buffering', 'no');
    client.response.flushHeaders();
  }
  private write(client: Client, frame: string) {
    if (
      client.closed ||
      client.response.destroyed ||
      client.response.writableEnded ||
      Date.now() >= client.deadline
    ) {
      client.close();
      return;
    }
    if (
      Buffer.byteLength(frame) > 131072 ||
      client.response.writableLength + Buffer.byteLength(frame) > 262144
    ) {
      // A finite protocol error prevents a resume loop at the same oversized batch.
      const error = 'event: error\ndata: {"reason":"output_limit"}\n\n';
      if (client.response.writableLength + Buffer.byteLength(error) <= 262144) {
        this.headers(client);
        try {
          client.response.write(error);
        } catch {
          /* The client already disconnected. */
        }
      }
      client.close();
      return;
    }
    this.headers(client);
    try {
      if (!client.response.write(frame)) client.close();
    } catch {
      client.close();
    }
  }
  private read(client: Client): Promise<void> {
    client.polling = true;
    const operation = this.db.transaction(async (manager) => {
      await manager.query(
        "SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'",
      );
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`log-receipt:${client.tenant}`],
      );
      const [profile] = await manager.query(
        `SELECT "logPrivacy",to_char(${RETENTION_CUTOFF_SQL} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now FROM public.tenants WHERE id=$1`,
        [client.tenant],
      );
      if (!profile) throw new NotFoundException('Workspace not found');
      const schema = tenantSchema(client.tenant);
      const previous = client.cursor;
      const records: Array<{
        record: Record<string, unknown> | null;
        streamReceipt: string;
        id: string;
      }> = await manager.query(
        `WITH selected AS MATERIALIZED (SELECT l.id,l."receivedAt",jsonb_build_object(${projection}) AS doc FROM ${schema}.request_logs l WHERE l."receivedAt">=$1::timestamptz ${previous ? 'AND (l."receivedAt",l.id)>($2::timestamptz,$3::uuid)' : ''} ORDER BY l."receivedAt" ${previous ? 'ASC' : 'DESC'},l.id ${previous ? 'ASC' : 'DESC'} LIMIT 50)
        SELECT id,to_char("receivedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "streamReceipt",CASE WHEN octet_length(doc::text)>131072 THEN NULL ELSE doc END AS record FROM selected ORDER BY "receivedAt" ${previous ? 'ASC' : 'DESC'},id ${previous ? 'ASC' : 'DESC'}`,
        previous
          ? [profile.cutoff, previous.receipt, previous.id]
          : [profile.cutoff],
      );
      if (!previous) records.reverse();
      if (records.some((row) => row.record === null)) {
        this.write(client, 'event: error\ndata: {"reason":"output_limit"}\n\n');
        client.close();
        return;
      }
      if (previous && previous.receipt < profile.cutoff && !client.gap) {
        client.gap = true;
        this.write(
          client,
          'event: gap\ndata: {"reason":"receipt_retention"}\n\n',
        );
      }
      const last = records.at(-1);
      const next: Cursor = last
        ? {
            tenant: client.tenant,
            receipt: last.streamReceipt,
            id: last.id,
            expires: Date.now() + 86400000,
          }
        : (previous ?? {
            tenant: client.tenant,
            receipt: profile.now,
            id: '00000000-0000-0000-0000-000000000000',
            expires: Date.now() + 86400000,
          });
      const logs = records.map((row) =>
        redactRequestLog(row.record ?? {}, profile.logPrivacy),
      );
      // Synchronous bounded publication while holding the receipt fence also fences policy saves.
      if (logs.length || !previous)
        this.write(
          client,
          `id: ${this.encode(next)}\nevent: logs\ndata: ${JSON.stringify(logs)}\n\n`,
        );
      else this.write(client, ': heartbeat\n\n');
      if (!client.closed) client.cursor = next;
    });
    this.operations.add(operation);
    return operation.finally(() => {
      this.operations.delete(operation);
      client.polling = false;
    });
  }
  async open(
    tenant: string,
    response: Response,
    sessionExpiresAt?: number,
    lastEventId?: string,
  ) {
    tenant = tenantSchema(tenant).slice(7).replaceAll('_', '-');
    response.setHeader('Cache-Control', 'no-store');
    const cursor =
      lastEventId === undefined ? undefined : this.decode(lastEventId, tenant);
    const deadline = Math.min(
      Date.now() + 300000,
      sessionExpiresAt ?? Infinity,
    );
    if (
      this.stopping ||
      deadline <= Date.now() ||
      this.clients.size >= 16 ||
      [...this.clients].filter((client) => client.tenant === tenant).length >=
        2 ||
      this.operations.size >= 4
    )
      throw new ServiceUnavailableException(
        'Log stream capacity is unavailable. Retry shortly.',
      );
    let responseClosed!: () => void;
    const done = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const client: Client = {
      tenant,
      response,
      cursor,
      deadline,
      polling: false,
      closed: false,
      gap: false,
      done,
      close: () => undefined,
    };
    const finish = () => {
      client.closed = true;
      clearInterval(client.timer);
      clearTimeout(client.expiry);
      clearTimeout(client.drain);
      this.clients.delete(client);
      response.off('close', finish);
      responseClosed();
    };
    const release = (end: boolean) => {
      if (client.closed) return;
      client.closed = true;
      clearInterval(client.timer);
      clearTimeout(client.expiry);
      if (!end || response.destroyed || response.writableFinished) {
        finish();
        return;
      }
      // Hold admission and shutdown ownership until the actual response closes.
      // A stalled reader cannot prolong graceful completion indefinitely.
      client.drain = setTimeout(() => response.destroy(), 1000);
      client.drain.unref();
      try {
        if (!response.writableEnded) response.end();
      } catch {
        response.destroy();
      }
    };
    client.close = () => release(true);
    this.clients.add(client);
    response.on('close', finish);
    client.expiry = setTimeout(
      client.close,
      Math.max(1, deadline - Date.now()),
    );
    client.expiry.unref();
    try {
      await this.read(client);
    } catch (error) {
      if (response.headersSent) {
        this.write(client, 'event: error\ndata: {"reason":"read_failed"}\n\n');
        client.close();
        return;
      }
      release(false);
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        'Log stream could not read retained records. Retry shortly.',
      );
    }
    if (client.closed) return;
    client.timer = setInterval(() => {
      if (client.polling || client.closed || this.stopping) return;
      if (this.operations.size >= 4) {
        this.write(client, ': heartbeat\n\n');
        return;
      }
      void this.read(client).catch(() => {
        this.write(client, 'event: error\ndata: {"reason":"read_failed"}\n\n');
        client.close();
      });
    }, 2000);
    client.timer.unref();
  }
}
