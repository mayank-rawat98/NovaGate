import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';

/**
 * Terraform acceptance on real infrastructure: the built admin API on a
 * disposable PostgreSQL database, scoped automation tokens, the real
 * Terraform CLI, and SQL verification that destroy soft-deletes routes and
 * services and revokes consumers. Requires Go, Terraform, PostgreSQL
 * (E2E_DATABASE_URL), Redis (E2E_REDIS_URL) and a built admin-api.
 */
const databaseRoot =
  process.env.E2E_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/8';
const artifacts = resolve('.local-work/terraform-acceptance');
mkdirSync(artifacts, { recursive: true });
const tenant = randomUUID();
const schema = `tenant_${tenant.replaceAll('-', '_')}`;
const secret = 'terraform-acceptance-platform-secret-32-characters';
const database = `novagate_tf_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const session = `Bearer ${jwt.sign({ sub: tenant }, secret, { expiresIn: '30m' })}`;
const destroyed = resolve(artifacts, 'destroyed.json');
const evidence = { startedAt: new Date().toISOString() };
let root;
let db;
let admin;

async function until(check, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await check()) return;
    } catch {
      /* not ready */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function mint(scopes) {
  const response = await fetch(
    `http://127.0.0.1:3001/api/tenants/${tenant}/automation-tokens`,
    {
      method: 'POST',
      headers: { authorization: session, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `terraform ${scopes[0]}`,
        scopes,
        expiresInDays: 1,
      }),
    },
  );
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).token;
}

try {
  assert.ok(existsSync('apps/admin-api/dist/main.js'), 'Build admin-api first');
  rmSync(destroyed, { force: true });
  root = new pg.Client({ connectionString: databaseRoot });
  await root.connect();
  await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(databaseRoot);
  url.pathname = `/${database}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(readFileSync('docker/postgres-init.sql', 'utf8'));
  await db.query(
    `INSERT INTO public.tenants (id,name,email,"planId","gatewayConfigVersion","emailVerified") VALUES ($1,'Terraform','tf@example.test','free',1,true)`,
    [tenant],
  );
  await db.query(`CREATE SCHEMA ${schema}`);
  const provisioning = readFileSync(
    'apps/admin-api/src/tenants/tenant-provisioning.service.ts',
    'utf8',
  );
  for (const match of provisioning.matchAll(
    /await manager\.query\(`([\s\S]*?)`\)/g,
  ))
    await db.query(match[1].replaceAll('${schemaName}', schema));

  const log = createWriteStream(resolve(artifacts, 'admin-api.log'));
  admin = spawn(process.execPath, ['apps/admin-api/dist/main.js'], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      DATABASE_URL: url.toString(),
      REDIS_URL: redisUrl,
      PLATFORM_JWT_SECRET: secret,
      OBJECT_STORAGE_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  admin.stdout.pipe(log);
  admin.stderr.pipe(log);
  await until(
    async () => (await fetch('http://127.0.0.1:3001/api/health')).ok,
    'admin-api startup',
  );
  const token = await mint([
    'workspace:read',
    'services:write',
    'routes:write',
    'consumers:write',
    'alerts:write',
  ]);
  const readOnly = await mint(['services:read']);

  const go = spawnSync(
    'go',
    ['test', './...', '-count=1', '-v', '-run', 'TestAcc|Test'],
    {
      cwd: 'integrations/terraform-provider',
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      env: {
        ...process.env,
        TF_ACC: '1',
        NOVAGATE_API_URL: 'http://127.0.0.1:3001/api',
        NOVAGATE_TENANT_ID: tenant,
        NOVAGATE_API_TOKEN: token,
        NOVAGATE_READ_ONLY_TOKEN: readOnly,
        NOVAGATE_ACC_DESTROYED_FILE: destroyed,
      },
    },
  );
  writeFileSync(
    resolve(artifacts, 'go-test.log'),
    `${go.stdout}\n${go.stderr}`,
  );
  process.stdout.write(
    go.stdout
      .split('\n')
      .filter((line) => /^(---|ok|FAIL|PASS)/.test(line))
      .join('\n') + '\n',
  );
  assert.equal(
    go.status,
    0,
    'Terraform acceptance tests failed; see go-test.log',
  );

  // Destroy must soft-delete routes/services and revoke consumers, not erase them.
  const ids = JSON.parse(readFileSync(destroyed, 'utf8'));
  const [route] = (
    await db.query(`SELECT "deletedAt" FROM ${schema}.routes WHERE id=$1`, [
      ids.route,
    ])
  ).rows;
  const [service] = (
    await db.query(`SELECT "deletedAt" FROM ${schema}.services WHERE id=$1`, [
      ids.service,
    ])
  ).rows;
  const [consumer] = (
    await db.query(`SELECT "revokedAt" FROM ${schema}.consumers WHERE id=$1`, [
      ids.consumer,
    ])
  ).rows;
  assert.ok(route?.deletedAt, 'route row remains with deletedAt');
  assert.ok(service?.deletedAt, 'service row remains with deletedAt');
  assert.ok(consumer?.revokedAt, 'consumer row remains with revokedAt');
  // Tokens are recorded as used, and the write token never escaped into logs.
  const used = (
    await db.query(
      `SELECT count(*)::int AS n FROM public.automation_tokens WHERE tenant_id=$1 AND last_used_at IS NOT NULL`,
      [tenant],
    )
  ).rows[0].n;
  assert.equal(used, 2);
  assert.ok(
    !readFileSync(resolve(artifacts, 'go-test.log'), 'utf8').includes(token),
  );
  evidence.passed = true;
  evidence.softDeleted = ids;
  console.log(
    'Terraform acceptance passed: create, update, clear, import and destroy with soft-delete verified in PostgreSQL.',
  );
} finally {
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(
    resolve(artifacts, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
  if (admin) {
    admin.kill('SIGTERM');
    await Promise.race([
      once(admin, 'exit'),
      new Promise((d) => setTimeout(d, 10000)),
    ]);
  }
  await db?.end().catch(() => undefined);
  if (root) {
    await root
      .query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      .catch(() => undefined);
    await root.end();
  }
}
