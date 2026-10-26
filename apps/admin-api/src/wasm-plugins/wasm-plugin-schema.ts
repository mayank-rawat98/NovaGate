import { tenantSchema } from '../tenants/tenant-schema';

/** Installed WebAssembly plugins per workspace (issue #123); soft-deleted. */
export function wasmPluginSchemaSql(tenantId: string): string {
  const schema = tenantSchema(tenantId);
  return `
CREATE TABLE IF NOT EXISTS ${schema}.wasm_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(64) NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version VARCHAR(80) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  sha256 CHAR(64) NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 1048576),
  module BYTEA NOT NULL,
  hooks JSONB NOT NULL,
  "allowedHosts" JSONB NOT NULL DEFAULT '[]'::jsonb,
  source VARCHAR(16) NOT NULL CHECK (source IN ('catalog', 'upload')),
  "catalogId" VARCHAR(64),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS wasm_plugins_active_name
  ON ${schema}.wasm_plugins (name) WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS wasm_plugins_digest ON ${schema}.wasm_plugins (sha256);
`;
}
