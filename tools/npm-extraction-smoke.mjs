import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const tools = fileURLToPath(new URL('.', import.meta.url));
const mode = process.argv[2];
const baseImage = 'node:26.11.1-alpine';

if (mode === '--inside' || mode === '--docker-failure') {
  const require = createRequire(import.meta.url);
  const tar = require('/usr/local/lib/node_modules/npm/node_modules/tar');
  const cwd = mkdtempSync(join(tmpdir(), 'novagate-npm-extraction-'));
  const source = 'exports.NodeNextRequest = class NodeNextRequest {};\n';
  const target = join(cwd, 'node_modules/novagate-extraction-fixture/index.js');
  const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--offline'];
  const fault = `--require=${join(tools, 'npm-extraction-fault.cjs')}`;
  const wrapper = join(tools, 'npm-verified.mjs');
  function run(guarded, command, options = {}) {
    const result = spawnSync(
      guarded ? process.execPath : 'npm',
      guarded
        ? [wrapper, command, ...flags, ...(options.args ?? [])]
        : [command, ...flags, ...(options.args ?? [])],
      {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          ...(options.fault ? { NODE_OPTIONS: fault } : {}),
          ...(options.env ?? {}),
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  }
  function observe(result) {
    const exports = require(target);
    delete require.cache[require.resolve(target)];
    return {
      exitCode: result.status,
      bytes: statSync(target).size,
      constructor: typeof exports.NodeNextRequest,
      output: result.stdout + result.stderr,
    };
  }
  try {
    mkdirSync(join(cwd, 'source/package'), { recursive: true });
    writeFileSync(join(cwd, 'source/package/index.js'), source);
    writeFileSync(
      join(cwd, 'source/package/package.json'),
      JSON.stringify({
        name: 'novagate-extraction-fixture',
        version: '1.0.0',
        main: 'index.js',
      }),
    );
    await tar.c(
      { gzip: true, file: join(cwd, 'fixture.tgz'), cwd: join(cwd, 'source') },
      ['package'],
    );
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'extraction-regression',
        version: '1.0.0',
        dependencies: { 'novagate-extraction-fixture': 'file:fixture.tgz' },
      }),
    );
    const lock = run(false, 'install', { args: ['--package-lock-only'] });
    // Generate a real npm lock using only the local fixture tarball.
    assert.equal(lock.status, 0, lock.stderr);

    if (mode === '--docker-failure') {
      const rejected = run(true, 'ci', { fault: true });
      process.stdout.write(rejected.stdout);
      process.stderr.write(rejected.stderr);
      process.exitCode = rejected.status;
    } else {
      const baseline = observe(run(false, 'ci', { fault: true }));
      assert.equal(baseline.exitCode, 0, baseline.output);
      assert.match(baseline.output, /TAR_ENTRY_ERROR EFAULT/);
      assert.equal(baseline.bytes, 0);
      assert.equal(baseline.constructor, 'undefined');

      const rejected = observe(run(true, 'ci', { fault: true }));
      assert.equal(rejected.exitCode, 1, rejected.output);
      assert.match(
        rejected.output,
        /Verified npm rejected an extraction diagnostic/,
      );
      assert.equal(rejected.bytes, 0);
      assert.equal(rejected.constructor, 'undefined');

      const quiet = observe(
        run(true, 'ci', {
          fault: true,
          args: ['--loglevel=silent', '--color=always'],
          env: { npm_config_loglevel: 'silent', npm_config_color: 'always' },
        }),
      );
      assert.equal(quiet.exitCode, 1, quiet.output);
      assert.match(quiet.output, /TAR_ENTRY_ERROR EFAULT/);

      const healthy = observe(run(true, 'ci'));
      assert.equal(healthy.exitCode, 0, healthy.output);
      assert.equal(healthy.bytes, Buffer.byteLength(source));
      assert.equal(healthy.constructor, 'function');
      assert.equal(readFileSync(target, 'utf8'), source);
      const healthyPrune = run(true, 'prune', { args: ['--omit=dev'] });
      assert.equal(healthyPrune.status, 0, healthyPrune.stderr);
      assert.equal(readFileSync(target, 'utf8'), source);

      // prune also reifies missing production packages; protect its extraction.
      rmSync(join(cwd, 'node_modules/novagate-extraction-fixture'), {
        recursive: true,
      });
      const prune = observe(
        run(true, 'prune', { fault: true, args: ['--omit=dev'] }),
      );
      assert.equal(prune.exitCode, 1, prune.output);
      assert.match(prune.output, /TAR_ENTRY_ERROR EFAULT/);
      assert.equal(prune.bytes, 0);

      // CI keeps prepare scripts enabled. Verify that a normal lifecycle runs.
      const manifest = JSON.parse(
        readFileSync(join(cwd, 'package.json'), 'utf8'),
      );
      manifest.scripts = { prepare: 'node prepare.cjs' };
      writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
      writeFileSync(
        join(cwd, 'prepare.cjs'),
        "require('node:fs').writeFileSync('prepare-completed', 'done');\n",
      );
      const lifecycle = run(true, 'ci', { args: ['--ignore-scripts=false'] });
      assert.equal(lifecycle.status, 0, lifecycle.stderr);
      assert.equal(
        readFileSync(join(cwd, 'prepare-completed'), 'utf8'),
        'done',
      );

      // Cancellation must drain npm and its real prepare child as one owned group.
      writeFileSync(
        join(cwd, 'prepare.cjs'),
        [
          "const fs = require('node:fs');",
          'const timer = setInterval(() => {}, 1000);',
          "process.on('SIGTERM', () => { fs.writeFileSync('prepare-stopped', 'done'); clearInterval(timer); });",
          "fs.writeFileSync('prepare-ready', String(process.pid));",
        ].join('\n'),
      );
      const waiting = spawn(
        process.execPath,
        [wrapper, 'ci', ...flags, '--ignore-scripts=false'],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let signalOutput = '';
      waiting.stdout.on('data', (chunk) => {
        signalOutput += chunk;
      });
      waiting.stderr.on('data', (chunk) => {
        signalOutput += chunk;
      });
      const completion = new Promise((resolve, reject) => {
        waiting.once('error', reject);
        waiting.once('close', (code, signal) => resolve({ code, signal }));
      });
      const readinessDeadline = Date.now() + 10_000;
      while (
        !existsSync(join(cwd, 'prepare-ready')) &&
        Date.now() < readinessDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(existsSync(join(cwd, 'prepare-ready')), signalOutput);
      const started = Date.now();
      waiting.kill('SIGTERM');
      const watchdog = setTimeout(() => waiting.kill('SIGKILL'), 10_000);
      const cancelled = await completion.finally(() => clearTimeout(watchdog));
      assert.equal(cancelled.code, 143, signalOutput);
      assert.equal(cancelled.signal, null);
      assert.equal(readFileSync(join(cwd, 'prepare-stopped'), 'utf8'), 'done');
      const shutdownMs = Date.now() - started;
      assert.ok(shutdownMs < 5000, `Lifecycle shutdown took ${shutdownMs}ms`);

      rmSync(join(cwd, 'package-lock.json'));
      const ordinaryFailure = run(true, 'ci');
      assert.notEqual(ordinaryFailure.status, 0);
      assert.match(ordinaryFailure.stderr, /npm error/);
      assert.doesNotMatch(ordinaryFailure.stderr, /Verified npm rejected/);

      const missingNpm = run(true, 'ci', { env: { PATH: '/nonexistent' } });
      assert.equal(missingNpm.status, 127, missingNpm.stderr);
      assert.match(missingNpm.stderr, /ENOENT/);

      console.log(
        JSON.stringify(
          {
            controlledWriteFault: true,
            node: process.version,
            npm: require('/usr/local/lib/node_modules/npm/package.json')
              .version,
            libuv: process.versions.uv,
            baseline,
            rejected,
            quiet,
            healthy,
            healthyPruneExit: healthyPrune.status,
            rejectedPrune: prune,
            ordinaryFailureExit: ordinaryFailure.status,
            missingNpmExit: missingNpm.status,
            lifecycleExit: lifecycle.status,
            cancelledExit: cancelled.code,
            shutdownMs,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
} else {
  assert.equal(
    mode,
    undefined,
    'No arguments are required for the host smoke target',
  );
  const identity = randomUUID();
  const container = `novagate-npm-extraction-${identity}`;
  const tag = `novagate-npm-extraction-rejected:${identity}`;
  const context = mkdtempSync(join(tmpdir(), 'novagate-npm-build-'));
  function docker(args, options = {}) {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  }
  try {
    console.log(
      docker([
        'run',
        '--rm',
        '--name',
        container,
        '--mount',
        `type=bind,src=${resolve(tools)},dst=/verification,readonly`,
        '--entrypoint',
        'node',
        baseImage,
        '/verification/npm-extraction-smoke.mjs',
        '--inside',
      ]),
    );
    for (const name of [
      'npm-verified.mjs',
      'npm-extraction-fault.cjs',
      'npm-extraction-smoke.mjs',
    ]) {
      copyFileSync(join(tools, name), join(context, name));
    }
    writeFileSync(
      join(context, 'Dockerfile'),
      [
        `FROM ${baseImage}`,
        'COPY *.mjs *.cjs /verification/',
        'RUN node /verification/npm-extraction-smoke.mjs --docker-failure',
        'RUN touch /incorrectly-accepted-install',
      ].join('\n') + '\n',
    );
    const build = spawnSync(
      'docker',
      ['build', '--progress=plain', '-t', tag, context],
      {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.ifError(build.error);
    assert.notEqual(build.status, 0);
    assert.match(build.stdout + build.stderr, /TAR_ENTRY_ERROR EFAULT/);
    assert.match(
      build.stdout + build.stderr,
      /Verified npm rejected an extraction diagnostic/,
    );
    const inspect = spawnSync('docker', ['image', 'inspect', tag], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(
      inspect.status,
      1,
      'Rejected Docker build must not produce its image tag',
    );
    console.log(
      JSON.stringify({
        rejectedBuildExit: build.status,
        publishedImage: false,
      }),
    );
  } finally {
    // Names belong exclusively to this invocation, including after a timeout.
    spawnSync('docker', ['rm', '--force', container], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    spawnSync('docker', ['image', 'rm', tag], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (existsSync(context)) rmSync(context, { recursive: true, force: true });
  }
}
