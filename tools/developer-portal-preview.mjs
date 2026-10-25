import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';

/** Prepares and starts the standalone production portal build. */
export function preparePortalStandalone() {
  const standalone = resolve('dist/apps/developer-portal/.next/standalone');
  const server = resolve(standalone, 'apps/developer-portal/server.js');
  if (!existsSync(server))
    throw new Error('Build developer-portal before starting the preview.');
  const staticTarget = resolve(
    standalone,
    'dist/apps/developer-portal/.next/static',
  );
  mkdirSync(staticTarget, { recursive: true });
  cpSync(resolve('dist/apps/developer-portal/.next/static'), staticTarget, {
    recursive: true,
  });
  cpSync(
    resolve('apps/developer-portal/public'),
    resolve(standalone, 'apps/developer-portal/public'),
    { recursive: true },
  );
  return server;
}

export function startPortal(env = {}, stdio = 'inherit') {
  return fork(preparePortalStandalone(), [], {
    stdio,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: process.env.PORTAL_PREVIEW_PORT ?? '3334',
      ...env,
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const child = startPortal();
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 0 : (code ?? 1);
  });
}
