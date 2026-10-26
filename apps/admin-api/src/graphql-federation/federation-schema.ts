import { tenantSchema } from '../tenants/tenant-schema';

/** Federated GraphQL graphs per workspace (issue #127); soft-deleted. The
 * subgraph list keeps each uploaded SDL; the supergraph is composed on save. */
export function federationSchemaSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  return `
CREATE TABLE IF NOT EXISTS ${schema}.federated_graphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(48) NOT NULL CHECK (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  subgraphs JSONB NOT NULL,
  "supergraphSdl" TEXT NOT NULL,
  "publicSdl" TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS federated_graphs_active_name
  ON ${schema}.federated_graphs (name) WHERE "deletedAt" IS NULL;
`;
}
