import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { verifyConsumerRollupReader } from './consumer-rollup-container-fixture.mjs';
import { verifyConsumerRollupReplicas } from './consumer-rollup-replicas-fixture.mjs';

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
assert.equal(docker('context', 'show'), 'orbstack');
const mode = process.argv[2] ?? 'reader';
assert(
  ['reader', 'replicas'].includes(mode),
  'Choose reader or replicas workload',
);
const network = `novagate-rollup-${randomUUID().slice(0, 8)}`;
const names = [];
const cleanupFailures = [];
const image = process.env.NOVAGATE_ADMIN_IMAGE ?? 'novagate-admin:verification';
let created = false,
  db,
  primaryFailure;
const run = (role, image, environment, ports = []) => {
  const name = `${network}-${role}`;
  names.push(name);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    ...environment.flatMap((value) => ['-e', value]),
    ...ports.flatMap((value) => ['-p', `127.0.0.1::${value}`]),
    image,
  );
  return name;
};
const port = (name, value) =>
  Number(docker('port', name, `${value}/tcp`).split(':').at(-1));
const until = async (work, label) => {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    try {
      if (await work()) return;
    } catch {
      /* Wait for disposable startup. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  docker('network', 'create', network);
  created = true;
  const postgres = run(
    'postgres',
    'postgres:16-alpine',
    [
      'POSTGRES_USER=metric_fixture',
      'POSTGRES_PASSWORD=metric-fixture-only',
      'POSTGRES_DB=metric_fixture',
    ],
    [5432],
  );
  const redis = run('redis', 'redis:7-alpine', []);
  await until(
    () =>
      docker(
        'exec',
        postgres,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'metric_fixture',
      ).includes('accepting connections'),
    'PostgreSQL startup',
  );
  const databaseUrl = `postgres://metric_fixture:metric-fixture-only@127.0.0.1:${port(postgres, 5432)}/metric_fixture`;
  db = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=15000 -c lock_timeout=3000',
  });
  db.on('error', (error) => {
    primaryFailure ??= error;
  });
  await db.connect();
  await db.query(readFileSync(resolve('docker/postgres-init.sql'), 'utf8'));
  const environment = [
    `DATABASE_URL=postgres://metric_fixture:metric-fixture-only@${postgres}:5432/metric_fixture`,
    `REDIS_URL=redis://${redis}:6379`,
    'PLATFORM_JWT_SECRET=rollup-runtime-only-session-secret-longer-than-32-characters',
    'OBJECT_STORAGE_ENABLED=false',
  ];
  const admins = [],
    adminUrls = [];
  const healthy = (adminUrl) =>
    until(
      async () =>
        (
          await fetch(`${adminUrl}/health`, {
            signal: AbortSignal.timeout(3000),
          })
        ).ok,
      'Production admin startup',
    );
  for (let index = 0; index < (mode === 'replicas' ? 2 : 1); index++) {
    const admin = run(`admin-${index}`, image, environment, [3001]);
    const adminUrl = `http://127.0.0.1:${port(admin, 3001)}/api`;
    admins.push(admin);
    adminUrls.push(adminUrl);
    await healthy(adminUrl);
  }
  const restartReplica = async (index) => {
    const admin = admins[index];
    docker('stop', '--time', '10', admin);
    const stopped = JSON.parse(
      docker('inspect', admin, '--format', '{{json .State}}'),
    );
    assert.equal(stopped.ExitCode, 0);
    docker('start', admin);
    adminUrls[index] = `http://127.0.0.1:${port(admin, 3001)}/api`;
    await healthy(adminUrls[index]);
    return {
      replica: index,
      shutdownExitCode: stopped.ExitCode,
      healthyAfterRestart: true,
    };
  };
  const result =
    mode === 'replicas'
      ? await verifyConsumerRollupReplicas({
          adminUrls,
          db,
          databaseUrl,
          restartReplica,
        })
      : await verifyConsumerRollupReader({ adminUrl: adminUrls[0], db });
  if (primaryFailure) throw primaryFailure;
  const shutdown = [];
  for (const admin of admins) {
    docker('stop', '--time', '10', admin);
    const state = JSON.parse(
      docker('inspect', admin, '--format', '{{json .State}}'),
    );
    assert.equal(state.ExitCode, 0);
    assert.equal(
      docker('inspect', admin, '--format', '{{.Config.User}}'),
      'node',
    );
    assert.equal(
      docker('inspect', admin, '--format', '{{.Image}}'),
      docker('inspect', admins[0], '--format', '{{.Image}}'),
    );
    shutdown.push({ replica: shutdown.length, exitCode: state.ExitCode });
  }
  mkdirSync(resolve('.local-work/issue99'), { recursive: true });
  writeFileSync(
    resolve(
      '.local-work/issue99',
      mode === 'replicas'
        ? 'consumer-rollup-replicas-evidence.json'
        : 'consumer-rollup-runtime-evidence.json',
    ),
    JSON.stringify(
      {
        image: docker('inspect', admins[0], '--format', '{{.Image}}'),
        nonRoot: true,
        shutdownExitCode: shutdown[0].exitCode,
        ...(mode === 'replicas' ? { shutdown } : {}),
        ...result,
      },
      null,
      2,
    ),
  );
} catch (error) {
  primaryFailure ??= error;
  mkdirSync(resolve('.local-work/issue99'), { recursive: true });
  try {
    const tenants = (
      await db.query(`SELECT id,"consumerRollupPending","consumerRollupError","consumerRollupCheckedAt",
        "logPrivacyScrubDone","logPrivacyScrubError","logPrivacyScrubCheckedAt"
      FROM public.tenants ORDER BY id`)
    ).rows;
    const states = [];
    for (const tenant of tenants) {
      assert.match(tenant.id, /^[a-f\d-]{36}$/);
      const schema = `tenant_${tenant.id.replaceAll('-', '_')}`;
      const state = (
        await db.query(`SELECT to_jsonb(c) AS counts,to_jsonb(p) AS paths,
        (SELECT COUNT(*)::integer FROM ${schema}.request_logs WHERE path<>'[redacted]') AS private_records,
        (SELECT COUNT(*)::integer FROM ${schema}.request_logs WHERE "usageRollupVersion" IS NULL OR "pathRollupVersion" IS NULL) AS pending
        FROM ${schema}.consumer_usage_rollup_state c CROSS JOIN ${schema}.consumer_path_rollup_state p`)
      ).rows;
      states.push({ tenant, state });
    }
    writeFileSync(
      resolve('.local-work/issue99', `${network}-state.json`),
      JSON.stringify(states, null, 2),
    );
  } catch {
    // Startup may have failed before database/schema creation.
  }
  for (const name of names) {
    try {
      const logs = spawnSync('docker', ['logs', name], {
        encoding: 'utf8',
        timeout: 60000,
      });
      if (logs.error) throw logs.error;
      assert.equal(logs.status, 0);
      writeFileSync(
        resolve('.local-work/issue99', `${name}.log`),
        `${logs.stdout}${logs.stderr}`,
      );
    } catch {
      /* Preserve the original failure if startup failed. */
    }
  }
} finally {
  try {
    await db?.end();
  } catch (error) {
    cleanupFailures.push(error);
  }
  for (const name of names.reverse()) {
    try {
      docker('rm', '-f', name);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (created) {
    try {
      docker('network', 'rm', network);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
}
if (cleanupFailures.length)
  throw new AggregateError(
    [...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
    'Consumer rollup fixture or resource cleanup failed.',
  );
if (primaryFailure) throw primaryFailure;
console.log('Production consumer rollup timer/REST/privacy checks passed.');
