import { NotFoundException } from '@nestjs/common';
import type { LogRetentionCoverage } from '@api-gateway/shared-types';
import type { EntityManager } from 'typeorm';

// Keep receipt cutoffs in PostgreSQL precision; JS Date would lose boundary rows.
export const RETENTION_CUTOFF_SQL = `GREATEST("logRetentionFloor",clock_timestamp()-make_interval(secs=>"logRetentionDays"::integer*86400))`;
export const RETENTION_PROFILE_SQL = `SELECT "logRetentionDays","logRetentionRevision","logRetentionPending","logRetentionError",
  to_char("logRetentionCheckedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS checked,
  to_char(${RETENTION_CUTOFF_SQL} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff
  FROM public.tenants WHERE id=$1`;
export interface RetentionProfile {
  logRetentionDays: number;
  logRetentionRevision: string;
  logRetentionPending: boolean;
  logRetentionError: boolean;
  checked: string | null;
  cutoff: string;
}
export async function retentionProfile(
  manager: Pick<EntityManager, 'query'>,
  id: string,
): Promise<RetentionProfile> {
  const [row] = await manager.query(RETENTION_PROFILE_SQL, [id]);
  if (!row) throw new NotFoundException('Workspace not found');
  return row;
}
export function retentionCoverage(row: RetentionProfile): LogRetentionCoverage {
  return {
    days: row.logRetentionDays,
    revision: row.logRetentionRevision,
    receivedFrom: row.cutoff,
    timeBasis: 'receipt',
  };
}
