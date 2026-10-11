import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'novagate-export-runtime-'));
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'key.pem',
      '-out',
      'cert.pem',
      '-days',
      '1',
      '-subj',
      '/CN=fixture.novagate.test',
      '-addext',
      'subjectAltName=DNS:http-intake.logs.datadoghq.eu,DNS:fixture-logs.storage.novagate.test',
    ],
    { cwd: directory, stdio: 'ignore', timeout: 15000 },
  );
  chmodSync(directory, 0o755);
  chmodSync(join(directory, 'key.pem'), 0o644); // Disposable fixture key, readable by image's node user.
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=bind,src=${resolve('.local-work/export-transport-runtime')},dst=/app/verification,readonly`,
      '--mount',
      `type=bind,src=${directory},dst=/app/fixture-tls,readonly`,
      process.env.NOVAGATE_ADMIN_IMAGE ?? 'novagate-admin:verification',
      'node',
      '/app/verification/fixture.cjs',
    ],
    { stdio: 'inherit', timeout: 60000 },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
