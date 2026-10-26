import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const fixture = process.argv[2] ?? 'capacity';
assert.ok(
  ['capacity', 'scheduler'].includes(fixture),
  'Use a supported export verification fixture',
);
const prefix = `EXPORT_${fixture.toUpperCase()}_EVIDENCE=`;
const name = `novagate-export-${fixture}-${randomUUID()}`;
const failures = [];
let evidence;
try {
  const image = execFileSync(
    'docker',
    [
      'image',
      'inspect',
      process.env.NOVAGATE_ADMIN_IMAGE ?? 'novagate-admin:verification',
      '--format',
      '{{.Id}}',
    ],
    { encoding: 'utf8', timeout: 10000 },
  ).trim();
  const url = new URL(
    process.env.TEST_DATABASE_URL ??
      'postgres://novagate_test:local-verification-only@127.0.0.1:15432/novagate_test',
  );
  if (['localhost', '127.0.0.1'].includes(url.hostname))
    url.hostname = 'host.docker.internal';
  const output = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--mount',
      `type=bind,src=${resolve('.local-work/export-transport-runtime')},dst=/app/verification,readonly`,
      '-e',
      `EXPORT_${fixture.toUpperCase()}_DATABASE_URL=${url.toString()}`,
      image,
      'node',
      `/app/verification/${fixture}.cjs`,
    ],
    {
      encoding: 'utf8',
      timeout: fixture === 'scheduler' ? 210000 : 150000,
      maxBuffer: 1024 * 1024,
    },
  );
  const line = output.split('\n').find((line) => line.startsWith(prefix));
  if (!line)
    throw new Error('Export fixture did not publish verification evidence');
  evidence = {
    image,
    fixtureSha256: createHash('sha256')
      .update(
        readFileSync(`.local-work/export-transport-runtime/${fixture}.cjs`),
      )
      .digest('hex'),
    ...JSON.parse(line.slice(prefix.length)),
  };
} catch (error) {
  failures.push(error);
} finally {
  const removed = spawnSync('docker', ['rm', '-f', name], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (removed.error) failures.push(removed.error);
  else if (
    removed.status !== 0 &&
    !/No such container/i.test(removed.stderr ?? '')
  )
    failures.push(new Error('Owned export fixture container cleanup failed'));
}
if (failures.length)
  throw new AggregateError(failures, 'Packaged export verification failed');
mkdirSync('.local-work', { recursive: true });
writeFileSync(
  `.local-work/export-${fixture}-evidence.json`,
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
