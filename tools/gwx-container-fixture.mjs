import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  stat,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { parse, stringify } from 'yaml';

/** Install the bundled tarball outside the checkout, then use actual container APIs. */
export async function verifyGwxRuntime({
  adminUrl,
  tenant,
  db,
  gatewayUrl,
  until,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'novagate-gwx-runtime-'));
  const install = join(directory, 'install'),
    credentials = join(directory, 'credentials');
  const schema = `tenant_${tenant.replaceAll('-', '_')}`;
  const password = 'gwx-container-disposable-password-only';
  const env = {
    PATH: process.env.PATH,
    GWX_CONFIG_DIR: credentials,
    GW_API_URL: adminUrl,
  };
  function run(args, extra = {}) {
    return new Promise((accept, reject) => {
      const child = spawn(join(install, 'node_modules/.bin/gwx'), args, {
        cwd: directory,
        env: { ...env, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '',
        size = 0;
      const capture = (target) => (chunk) => {
        size += chunk.length;
        if (size > 1048576) {
          child.kill('SIGTERM');
          return;
        }
        if (target === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on('data', capture('stdout'));
      child.stderr.on('data', capture('stderr'));
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        // Do not reflect secret-bearing child output in a failing assertion.
        if (code !== 0 || size > 1048576)
          reject(
            new Error(
              `Packaged gwx ${args.slice(0, 2).join(' ')} failed with exit ${code}`,
            ),
          );
        else accept({ stdout, stderr });
      });
    });
  }
  try {
    const packed = JSON.parse(
      execFileSync(
        'npm',
        [
          'pack',
          './tools/gwx',
          '--pack-destination',
          directory,
          '--json',
          '--ignore-scripts',
        ],
        {
          cwd: resolve('.'),
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    )[0];
    assert.deepEqual(packed.files.map((file) => file.path).sort(), [
      'README.md',
      'dist/main.js',
      'package.json',
    ]);
    await mkdir(install);
    await writeFile(
      join(install, 'package.json'),
      JSON.stringify({
        name: 'gwx-disposable-runtime',
        version: '0.0.0',
        private: true,
      }),
    );
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        install,
        join(directory, packed.filename),
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const bundleSha256 = createHash('sha256')
      .update(
        await readFile(
          join(install, 'node_modules/@api-gateway/gwx/dist/main.js'),
        ),
      )
      .digest('hex');
    assert.equal(
      bundleSha256,
      createHash('sha256')
        .update(await readFile('tools/gwx/dist/main.js'))
        .digest('hex'),
    );
    assert.equal((await run(['--version'])).stdout, '0.0.1\n');
    await db.query(
      'UPDATE public.tenants SET "passwordHash"=$2,"emailVerified"=true WHERE id=$1',
      [tenant, await bcrypt.hash(password, 10)],
    );
    const login = await run(['login'], {
      GW_EMAIL: `${tenant}@example.test`,
      GW_PASSWORD: password,
    });
    assert(!login.stdout.includes(password));
    assert.equal((await stat(credentials)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(credentials, 'credentials'))).mode & 0o777,
      0o600,
    );
    const saved = await readFile(join(credentials, 'credentials'), 'utf8');
    const session = JSON.parse(saved);
    assert.equal(session.tenantId, tenant);
    assert.equal(session.apiUrl, adminUrl);
    assert(!login.stdout.includes(session.token));
    assert(!login.stderr.includes(session.token));
    const routes = JSON.parse((await run(['routes', 'list', '--json'])).stdout);
    assert(routes.some((row) => row.path === '/declarative'));
    assert(routes.every((row) => !Object.hasOwn(row, 'plugins')));
    assert(
      Array.isArray(
        JSON.parse((await run(['alerts', 'list', '--json'])).stdout),
      ),
    );
    const created = JSON.parse(
      (
        await run([
          'consumers',
          'create',
          '--name',
          'Packaged CLI client',
          '--json',
        ])
      ).stdout,
    );
    assert.equal(
      await readFile(join(credentials, 'credentials'), 'utf8'),
      saved,
    );
    assert(!Object.hasOwn(created, 'keyHash'));
    assert(created.apiKey.startsWith(`gw_${tenant}_`));
    await until(
      async () =>
        (
          await db.query(
            'SELECT 1 FROM public.pending_config_updates WHERE "tenantId"=$1',
            [tenant],
          )
        ).rowCount === 0,
      'CLI consumer gateway ACK',
    );
    assert.equal(
      (
        await fetch(`${gatewayUrl}/declarative`, {
          headers: { Authorization: `Bearer ${created.apiKey}` },
        })
      ).status,
      200,
    );
    const exportPath = join(directory, 'gateway.yml');
    await run(['routes', 'export', '--output', exportPath]);
    const exported = await readFile(exportPath, 'utf8');
    assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
    assert(!exported.includes(created.apiKey));
    assert(!exported.includes(session.token));
    assert(!exported.includes('keyHash'));
    const document = parse(exported);
    document.routes.push({
      method: 'GET',
      pathPattern: '/cli-live',
      serviceId: document.services[0].name,
      enabled: true,
      authRequired: true,
      plugins: [],
    });
    document.consumers.push({ name: 'Packaged import client', groups: [] });
    await writeFile(exportPath, stringify(document), { mode: 0o600 });
    const before = (
      await db.query(
        'SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1',
        [tenant],
      )
    ).rows[0].gatewayConfigVersion;
    const preview = JSON.parse(
      (await run(['routes', 'apply', exportPath, '--dry-run', '--json']))
        .stdout,
    );
    assert.equal(preview.changes.length, 2);
    assert(!Object.hasOwn(preview, 'revision'));
    assert.equal(
      (
        await db.query(
          'SELECT "gatewayConfigVersion" FROM public.tenants WHERE id=$1',
          [tenant],
        )
      ).rows[0].gatewayConfigVersion,
      before,
    );
    const applied = JSON.parse(
      (await run(['routes', 'apply', exportPath, '--yes', '--json'])).stdout,
    );
    assert.equal(applied.changed, 2);
    assert.equal(applied.delivery, 'queued');
    assert.equal(applied.consumerKeys.length, 1);
    const key = applied.consumerKeys[0].apiKey;
    const row = (
      await db.query(`SELECT "keyHash" FROM ${schema}.consumers WHERE id=$1`, [
        applied.consumerKeys[0].id,
      ])
    ).rows[0];
    assert.equal(row.keyHash, createHash('sha256').update(key).digest('hex'));
    await until(
      async () =>
        (
          await db.query(
            'SELECT 1 FROM public.pending_config_updates WHERE "tenantId"=$1',
            [tenant],
          )
        ).rowCount === 0,
      'CLI import gateway ACK',
    );
    assert.equal((await fetch(`${gatewayUrl}/cli-live`)).status, 401);
    assert.equal(
      (
        await fetch(`${gatewayUrl}/cli-live`, {
          headers: { Authorization: `Bearer ${key}` },
        })
      ).status,
      200,
    );
    const dryAgain = JSON.parse(
      (await run(['routes', 'apply', exportPath, '--dry-run', '--json']))
        .stdout,
    );
    assert.equal(dryAgain.changes.length, 0);
    const tail = await run(['logs', 'tail', '--once']);
    const logs = tail.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert(logs.length > 0 && logs.length <= 50);
    assert(
      logs.every(
        (log) =>
          log.clientIp === '[redacted]' &&
          !Object.hasOwn(log, 'userAgent') &&
          !Object.hasOwn(log, 'receivedAt') &&
          !Object.hasOwn(log, 'consumerUsageStored'),
      ),
    );
    assert(!tail.stdout.includes(key));
    assert(!tail.stdout.includes(created.apiKey));
    assert(!tail.stdout.includes(session.token));
    assert.equal(
      await readFile(join(credentials, 'credentials'), 'utf8'),
      saved,
    );
    await run(['logout']);
    await assert.rejects(stat(join(credentials, 'credentials')), {
      code: 'ENOENT',
    });
    return {
      installedOutsideCheckout: true,
      executableBin: true,
      credentialModes: true,
      actualLoginAndSavedSession: true,
      metadataLists: true,
      secretFreePrivateExport: true,
      dryRunWithoutMutation: true,
      reviewedApplyWithGatewayAck: true,
      oneTimeKeysThroughGateway: true,
      anonymousRouteRejected: true,
      idempotentApplyPreview: true,
      retainedPrivateLogTail: true,
      logoutRemovesLocalSession: true,
      packageFiles: packed.files.map((file) => file.path),
      packageIntegrity: packed.integrity,
      bundleSha256,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
