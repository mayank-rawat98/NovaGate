import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';

const standalone = resolve('dist/apps/dashboard/.next/standalone');
const server = resolve(standalone, 'apps/dashboard/server.js');
if (!existsSync(server))
  throw new Error('Build dashboard before starting the preview.');
const staticTarget = resolve(standalone, 'dist/apps/dashboard/.next/static');
mkdirSync(staticTarget, { recursive: true });
cpSync(resolve('dist/apps/dashboard/.next/static'), staticTarget, {
  recursive: true,
});
cpSync(
  resolve('apps/dashboard/public'),
  resolve(standalone, 'apps/dashboard/public'),
  { recursive: true },
);
const child = fork(server, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: process.env.DASHBOARD_PREVIEW_PORT ?? '3333',
  },
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 0 : (code ?? 1);
});
