import { CONSUMER_ROLLUP_PAGE_SIZE } from '@api-gateway/shared-types';
import type { EntityManager } from 'typeorm';
import { tenantSchema } from '../tenants/tenant-schema';

/** Canonical receipt lock must be held; redaction merges counts without replay. */
export async function eraseConsumerPathRollups(
  manager: Pick<EntityManager, 'query'>,
  tenantId: string,
  options: {
    attributionHidden: boolean;
    pathHidden?: boolean;
    receiptCutoff?: string;
  },
): Promise<number> {
  if (
    !options.attributionHidden &&
    !options.pathHidden &&
    !options.receiptCutoff
  )
    return 0;
  const schema = tenantSchema(tenantId);
  const [exists] = await manager.query(
    'SELECT to_regclass($1) IS NOT NULL AS ready',
    [`${schema}.consumer_path_rollups`],
  );
  if (!exists?.ready) return 0;
  const [result] = await manager.query(
    `WITH page AS MATERIALIZED (
      SELECT consumer_id,request_minute,receipt_minute,method,path FROM ${schema}.consumer_path_rollups
      WHERE $1::boolean OR ($2::boolean AND path<>'[redacted]') OR last_receipt<$3::timestamptz
      ORDER BY last_receipt,consumer_id,request_minute,receipt_minute,method,path LIMIT $4 FOR UPDATE
    ), erased AS (
      DELETE FROM ${schema}.consumer_path_rollups r USING page p
      WHERE (r.consumer_id,r.request_minute,r.receipt_minute,r.method,r.path)=(p.consumer_id,p.request_minute,p.receipt_minute,p.method,p.path)
      RETURNING r.*
    ), groups AS MATERIALIZED (
      SELECT consumer_id,request_minute,receipt_minute,method,'[redacted]'::text AS path,
        MIN(first_receipt) AS first_receipt,MAX(last_receipt) AS last_receipt,
        SUM(requests)::bigint AS requests,SUM(server_errors)::bigint AS server_errors,SUM(latency_samples)::bigint AS latency_samples
      FROM erased WHERE NOT $1::boolean AND $2::boolean AND ($3::timestamptz IS NULL OR last_receipt>=$3::timestamptz)
      GROUP BY 1,2,3,4
    ), histograms AS (
      SELECT consumer_id,request_minute,receipt_minute,method,i,SUM(histogram[i])::bigint AS count
      FROM erased CROSS JOIN LATERAL generate_subscripts(histogram,1) i
      WHERE NOT $1::boolean AND $2::boolean AND ($3::timestamptz IS NULL OR last_receipt>=$3::timestamptz)
      GROUP BY 1,2,3,4,5
    ), bins AS (
      SELECT consumer_id,request_minute,receipt_minute,method,array_agg(count ORDER BY i) AS histogram FROM histograms GROUP BY 1,2,3,4
    ), new_keys AS MATERIALIZED (
      SELECT g.* FROM groups g WHERE NOT EXISTS (
        SELECT 1 FROM ${schema}.consumer_path_rollups r
        WHERE (r.consumer_id,r.request_minute,r.receipt_minute,r.method,r.path)=(g.consumer_id,g.request_minute,g.receipt_minute,g.method,g.path)
        AND NOT EXISTS(SELECT 1 FROM page p WHERE (p.consumer_id,p.request_minute,p.receipt_minute,p.method,p.path)=(r.consumer_id,r.request_minute,r.receipt_minute,r.method,r.path))
      )
    ), stored AS (
      INSERT INTO ${schema}.consumer_path_rollups AS r SELECT g.*,b.histogram FROM groups g JOIN bins b USING(consumer_id,request_minute,receipt_minute,method)
      ON CONFLICT(consumer_id,request_minute,receipt_minute,method,path) DO UPDATE SET
        first_receipt=LEAST(r.first_receipt,EXCLUDED.first_receipt),last_receipt=GREATEST(r.last_receipt,EXCLUDED.last_receipt),
        requests=r.requests+EXCLUDED.requests,server_errors=r.server_errors+EXCLUDED.server_errors,
        latency_samples=r.latency_samples+EXCLUDED.latency_samples,
        histogram=ARRAY(SELECT r.histogram[i]+EXCLUDED.histogram[i] FROM generate_subscripts(r.histogram,1) i ORDER BY i)
      RETURNING 1
    ), updated AS (
      UPDATE ${schema}.consumer_path_rollup_state SET cells=cells-(SELECT COUNT(*) FROM erased)+(SELECT COUNT(*) FROM new_keys)
      WHERE singleton RETURNING (SELECT COUNT(*)::integer FROM erased) AS changed
    ) SELECT changed FROM updated`,
    [
      options.attributionHidden,
      options.pathHidden ?? false,
      options.receiptCutoff ?? null,
      CONSUMER_ROLLUP_PAGE_SIZE,
    ],
  );
  return result?.changed ?? 0;
}
