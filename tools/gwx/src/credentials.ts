import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiUrl, CliError, tenantPattern } from './errors';

export interface Credentials {
  version: 1;
  apiUrl: string;
  tenantId: string;
  token: string;
}
export const credentialsDirectory = () =>
  process.env.GWX_CONFIG_DIR ?? join(homedir(), '.gwx');
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function owned(stat: Awaited<ReturnType<typeof lstat>>) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}
function profile(value: unknown): Credentials {
  const row = value as Credentials;
  if (
    !row ||
    row.version !== 1 ||
    typeof row.apiUrl !== 'string' ||
    typeof row.tenantId !== 'string' ||
    !tenantPattern.test(row.tenantId) ||
    typeof row.token !== 'string' ||
    !/^\S{20,8192}$/.test(row.token)
  )
    throw new CliError('Stored credentials are invalid. Run gwx login again.');
  return {
    version: 1,
    apiUrl: apiUrl(row.apiUrl),
    tenantId: row.tenantId,
    token: row.token,
  };
}
export async function loadCredentials(
  directory: string,
): Promise<Credentials | undefined> {
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || !owned(dir) || dir.mode & 0o077)
      throw new Error();
    const file = await open(
      join(directory, 'credentials'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        !owned(stat) ||
        stat.mode & 0o077 ||
        stat.size > 16384
      )
        throw new Error();
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) throw new Error();
      return profile(
        JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')),
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof CliError) throw error;
    throw new CliError(
      'Credentials must be an owned regular file with mode 600 inside an owned directory with mode 700. Symlinks are refused.',
    );
  }
}
export async function saveCredentials(directory: string, value: Credentials) {
  const validated = profile(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || !owned(dir))
    throw new CliError(
      'Credential directory must be owned by you and cannot be a symlink.',
    );
  await chmod(directory, 0o700);
  const target = join(directory, 'credentials');
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || !owned(existing))
      throw new CliError(
        'Credential file must be owned by you and cannot be a symlink.',
      );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = join(directory, `.credentials-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(validated) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export async function removeCredentials(directory: string) {
  await loadCredentials(directory);
  await unlink(join(directory, 'credentials')).catch((error) => {
    if (!missing(error)) throw error;
  });
}
