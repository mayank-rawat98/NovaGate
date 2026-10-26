import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ANOMALY_LIMITS,
  MAX_ANOMALY_CHANNELS,
  describeAnomaly,
  type Anomaly,
  type AnomalySettings,
} from '@api-gateway/shared-types';
import { AlertRulesService } from '../alerts/alert-rules.service';

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const SETTINGS_FIELDS = [
  'enabled',
  'zThreshold',
  'minRequests',
  'channelIds',
  'expectedRevision',
];

interface StoredAnomaly {
  id: string;
  method: string;
  path: string;
  metric: Anomaly['metric'];
  direction: Anomaly['direction'];
  baseline_mean: number;
  baseline_stddev: number;
  baseline_windows: number;
  current: number;
  z_score: number;
  requests: string;
  state: Anomaly['state'];
  started_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
}

/** Workspace anomaly settings and feed; detection runs in AnomalyDetectorService. */
@Injectable()
export class AnomaliesService {
  constructor(private readonly alerts: AlertRulesService) {}

  list(tenantId: string, state: unknown): Promise<Anomaly[]> {
    if (state !== undefined && state !== 'active' && state !== 'all')
      throw new BadRequestException('state must be active or all');
    return this.alerts.withTenantTransaction(
      tenantId,
      async (manager, schema) => {
        const rows = await manager.query<StoredAnomaly[]>(
          `SELECT * FROM ${schema}.anomalies ${state === 'active' ? `WHERE state = 'active'` : ''}
          ORDER BY (state = 'active') DESC, started_at DESC, id DESC LIMIT 100`,
        );
        return rows.map((row) => {
          const anomaly = {
            id: row.id,
            method: row.method,
            path: row.path,
            metric: row.metric,
            direction: row.direction,
            baseline: {
              mean: row.baseline_mean,
              stddev: row.baseline_stddev,
              windows: row.baseline_windows,
            },
            current: row.current,
            zScore: row.z_score,
            requests: Number(row.requests),
            state: row.state,
            startedAt: new Date(row.started_at).toISOString(),
            lastSeenAt: new Date(row.last_seen_at).toISOString(),
            resolvedAt: row.resolved_at
              ? new Date(row.resolved_at).toISOString()
              : null,
          };
          return { ...anomaly, summary: describeAnomaly(anomaly) };
        });
      },
    );
  }

  settings(tenantId: string): Promise<AnomalySettings> {
    return this.alerts.withTenantTransaction(tenantId, (manager, schema) =>
      this.read(manager, schema),
    );
  }

  save(tenantId: string, input: unknown): Promise<AnomalySettings> {
    const body = input as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== SETTINGS_FIELDS.length ||
      !SETTINGS_FIELDS.every((field) => Object.hasOwn(body, field))
    )
      throw new BadRequestException(`Provide ${SETTINGS_FIELDS.join(', ')}.`);
    const [zMin, zMax] = ANOMALY_LIMITS.zThreshold;
    const [rMin, rMax] = ANOMALY_LIMITS.minRequests;
    const { enabled, zThreshold, minRequests, channelIds, expectedRevision } =
      body;
    if (typeof enabled !== 'boolean')
      throw new BadRequestException('enabled must be a boolean');
    if (
      typeof zThreshold !== 'number' ||
      !Number.isFinite(zThreshold) ||
      zThreshold < zMin ||
      zThreshold > zMax ||
      Math.round(zThreshold * 10) !== zThreshold * 10
    )
      throw new BadRequestException(
        `Sensitivity must be a z-score from ${zMin} to ${zMax} in steps of 0.1`,
      );
    if (
      !Number.isSafeInteger(minRequests) ||
      (minRequests as number) < rMin ||
      (minRequests as number) > rMax
    )
      throw new BadRequestException(
        `Minimum requests must be an integer from ${rMin} to ${rMax}`,
      );
    if (
      !Array.isArray(channelIds) ||
      channelIds.length > MAX_ANOMALY_CHANNELS ||
      !channelIds.every((id) => typeof id === 'string' && UUID.test(id))
    )
      throw new BadRequestException(
        `Choose at most ${MAX_ANOMALY_CHANNELS} alert channels`,
      );
    const channels = [...new Set(channelIds.map((id) => id.toLowerCase()))];
    if (channels.length !== channelIds.length)
      throw new BadRequestException('Channels must be unique');
    if (!Number.isSafeInteger(expectedRevision))
      throw new BadRequestException('A current settings revision is required');
    return this.alerts.withTenantTransaction(
      tenantId,
      async (manager, schema) => {
        const [row] = await manager.query<Array<{ revision: number }>>(
          `SELECT revision FROM ${schema}.anomaly_settings FOR UPDATE`,
        );
        if (!row) throw new NotFoundException('Workspace not found');
        if (row.revision !== expectedRevision)
          throw new ConflictException(
            'Anomaly settings changed. Reload them before saving.',
          );
        if (channels.length) {
          const found = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM ${schema}.alert_channels WHERE id = ANY($1::uuid[])`,
            [channels],
          );
          if (found.length !== channels.length)
            throw new BadRequestException(
              'Choose alert channels from this workspace.',
            );
        }
        await manager.query(
          `UPDATE ${schema}.anomaly_settings SET enabled = $1, z_threshold = $2, min_requests = $3,
          revision = revision + 1, "updatedAt" = NOW()`,
          [enabled, zThreshold, minRequests],
        );
        await manager.query(`DELETE FROM ${schema}.anomaly_channels`);
        if (channels.length)
          await manager.query(
            `INSERT INTO ${schema}.anomaly_channels ("channelId") SELECT unnest($1::uuid[])`,
            [channels],
          );
        return this.read(manager, schema);
      },
    );
  }

  private async read(
    manager: EntityManager,
    schema: string,
  ): Promise<AnomalySettings> {
    const [row] = await manager.query(
      `SELECT enabled, z_threshold AS "zThreshold", min_requests AS "minRequests", revision,
        ARRAY(SELECT "channelId"::text FROM ${schema}.anomaly_channels ORDER BY "channelId") AS "channelIds"
        FROM ${schema}.anomaly_settings`,
    );
    if (!row) throw new NotFoundException('Workspace not found');
    return row;
  }
}
