import { once } from 'node:events';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  AUTOMATION_TOKEN_PREFIX,
  DECLARATIVE_CONFIG_MAX_BYTES,
  DECLARATIVE_CONFIG_MAX_ENTRIES,
  MAX_AUTOMATION_TOKEN_DAYS,
  isAutomationTokenScope,
  type ConfigPreview,
  type ConfigApplyResult,
} from '@api-gateway/shared-types';
import { apiUrl, CliError, safeText, tenantPattern } from './errors';
import { Client } from './http';
import {
  credentialsDirectory,
  loadCredentials,
  saveCredentials,
  removeCredentials,
} from './credentials';

const help = `gwx — NovaGate CLI (Node 24+)

gwx login [--email ADDRESS] [--api-url https://HOST/api]
gwx logout
gwx routes list [--json]
gwx routes export [--output FILE]
gwx routes apply [gateway.yml] [--dry-run] [--yes] [--json]
gwx consumers create --name NAME [--json]
gwx alerts list [--json]
gwx logs tail [--once]
gwx tokens list [--json]
gwx tokens create --name NAME --scope SCOPE [--scope SCOPE] [--expires-days N] [--json]
gwx tokens revoke TOKEN_ID [--json]

Global: --api-url URL, --tenant UUID, --help, --version
Automation: GW_API_URL, GW_TENANT_ID, GW_API_TOKEN (a scoped ngat_ token).
Token commands need a signed-in session; tokens cannot manage tokens.
Login: GW_EMAIL, GW_PASSWORD, or interactive hidden password entry.
Saved sessions: ~/.gwx/credentials (mode 600). GWX_CONFIG_DIR overrides its directory.
Apply reviews a complete document; missing entries are removed/revoked.
--yes acknowledges the displayed preview in automation. Writes are never retried.
New consumer keys print once. A timeout may occur after a server commit.
`;
const controller = new AbortController();
let interrupted = 0;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)
  process.once(signal, () => {
    interrupted = code;
    controller.abort(new CliError('Interrupted.', code));
  });
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    interrupted = 0;
    controller.abort(new CliError('Output closed.', 0));
  }
});
async function out(source: string) {
  if (controller.signal.aborted) throw controller.signal.reason;
  if (!process.stdout.write(source))
    await once(process.stdout, 'drain', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
}
async function ask(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY)
    throw new CliError(
      'Interactive input requires a terminal. Use the documented environment variables or --yes.',
      2,
    );
  const output = hidden
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : process.stderr;
  const readline = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  let answered = false;
  readline.once('SIGINT', () => {
    interrupted = 130;
    controller.abort(new CliError('Interrupted.', 130));
  });
  readline.once('close', () => {
    if (!answered && !controller.signal.aborted)
      controller.abort(new CliError('Input closed before confirmation.', 2));
  });
  // Install raw input before exposing the prompt; an immediate reply must not echo.
  if (hidden) process.stderr.write(prompt);
  try {
    const answer = await readline.question(hidden ? '' : prompt, {
      signal: controller.signal,
    });
    answered = true;
    return answer;
  } finally {
    readline.close();
    if (hidden) process.stderr.write('\n');
  }
}
async function documentFile(path: string) {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > DECLARATIVE_CONFIG_MAX_BYTES)
      throw new Error();
    const buffer = Buffer.alloc(DECLARATIVE_CONFIG_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (!length || length > DECLARATIVE_CONFIG_MAX_BYTES) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, length),
    );
  } catch {
    throw new CliError(
      'Read a non-empty UTF-8 regular configuration file of at most 64 KiB. Symlinks are refused.',
      2,
    );
  } finally {
    await file?.close();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CliError('API returned an invalid response.');
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new CliError('API returned an invalid list.');
  return value.map(object);
}
function preview(value: unknown): ConfigPreview {
  const result = object(value);
  if (
    result.dryRun !== true ||
    typeof result.revision !== 'string' ||
    !/^\d{10}\.[a-f\d]{64}$/.test(result.revision) ||
    typeof result.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    !Number.isSafeInteger(result.configVersion) ||
    !Number.isSafeInteger(result.unchanged)
  )
    throw new CliError('API returned an invalid preview.');
  const changes = rows(result.changes).map((row) => {
    if (
      !['create', 'update', 'remove'].includes(String(row.action)) ||
      !['service', 'route', 'consumer'].includes(String(row.resource)) ||
      typeof row.key !== 'string' ||
      !Array.isArray(row.fields) ||
      row.fields.some((field) => typeof field !== 'string')
    )
      throw new CliError('API returned an invalid preview.');
    return {
      action: row.action,
      resource: row.resource,
      key: safeText(row.key),
      fields: row.fields.map(safeText),
    };
  });
  if (changes.length > 2 * DECLARATIVE_CONFIG_MAX_ENTRIES)
    throw new CliError('API returned an invalid preview.');
  return { ...result, changes, warnings: [] } as unknown as ConfigPreview;
}
async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'api-url': { type: 'string' },
        tenant: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
        email: { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean' },
        name: { type: 'string' },
        output: { type: 'string' },
        once: { type: 'boolean' },
        scope: { type: 'string', multiple: true },
        'expires-days': { type: 'string' },
      },
    });
  } catch {
    throw new CliError('Unknown or invalid option. Run gwx --help.', 2);
  }
  const flags = parsed.values,
    args = parsed.positionals;
  if (flags.version) {
    await out('0.0.1\n');
    return;
  }
  if (flags.help || !args.length) {
    await out(help);
    return;
  }
  const command = args
    .slice(0, args[0] === 'login' || args[0] === 'logout' ? 1 : 2)
    .join(' ');
  const extra: Record<string, string[]> = {
    login: ['email'],
    logout: [],
    'routes list': [],
    'routes export': ['output'],
    'routes apply': ['dry-run', 'yes'],
    'consumers create': ['name'],
    'alerts list': [],
    'logs tail': ['once'],
    'tokens list': [],
    'tokens create': ['name', 'scope', 'expires-days'],
    'tokens revoke': [],
  };
  if (
    !Object.hasOwn(extra, command) ||
    args.length >
      (command === 'routes apply' || command === 'tokens revoke'
        ? 3
        : command.includes(' ')
          ? 2
          : 1) ||
    Object.keys(flags).some(
      (flag) =>
        ![
          'api-url',
          'tenant',
          'json',
          'help',
          'version',
          ...extra[command],
        ].includes(flag),
    )
  )
    throw new CliError(
      'Unknown command or option for this command. Run gwx --help.',
      2,
    );
  const directory = credentialsDirectory();
  if (command === 'logout') {
    await removeCredentials(directory);
    await out('Stored credentials removed.\n');
    return;
  }
  const saved =
    command === 'login' || process.env.GW_API_TOKEN
      ? undefined
      : await loadCredentials(directory);
  const base = apiUrl(
    flags['api-url'] ??
      process.env.GW_API_URL ??
      saved?.apiUrl ??
      'http://127.0.0.1:3001/api',
  );
  if (command === 'login') {
    const email = flags.email ?? process.env.GW_EMAIL ?? (await ask('Email: '));
    const password = process.env.GW_PASSWORD ?? (await ask('Password: ', true));
    if (
      !email.trim() ||
      email.length > 320 ||
      !password ||
      password.length > 4096
    )
      throw new CliError(
        'Email and password are required and must fit their documented limits.',
        2,
      );
    const response = object(
      await new Client(base, '', undefined, controller.signal).json(
        '/auth/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        },
      ),
    );
    if (
      typeof response.token !== 'string' ||
      typeof response.tenantId !== 'string' ||
      !tenantPattern.test(response.tenantId)
    )
      throw new CliError('API returned an invalid session.');
    await saveCredentials(directory, {
      version: 1,
      apiUrl: base,
      tenantId: response.tenantId,
      token: response.token,
    });
    await out(`Signed in to workspace ${safeText(response.tenantId)}.\n`);
    return;
  }
  const environmentToken = process.env.GW_API_TOKEN || undefined;
  if (!environmentToken && saved && base !== saved.apiUrl)
    throw new CliError(
      'Saved credentials belong to another API URL. Log in to this API or provide GW_API_TOKEN explicitly.',
      2,
    );
  const tenant = flags.tenant ?? process.env.GW_TENANT_ID ?? saved?.tenantId;
  const token = environmentToken ?? saved?.token;
  if (
    !tenant ||
    !tenantPattern.test(tenant) ||
    !token ||
    !/^\S{20,8192}$/.test(token)
  )
    throw new CliError(
      'Run gwx login, or provide GW_API_TOKEN and GW_TENANT_ID.',
      2,
    );
  if (!environmentToken && saved && tenant !== saved.tenantId)
    throw new CliError(
      'Saved credentials belong to another workspace. Log in or provide an explicit environment token.',
      2,
    );
  const client = new Client(base, tenant, token, controller.signal);
  if (command === 'routes list') {
    const list = rows(await client.json(client.path('/routes'))).map((row) => ({
      id: safeText(row.id),
      method: safeText(row.method),
      path: safeText(row.pathPattern),
      serviceId: safeText(row.serviceId),
      enabled: row.enabled === true,
      authRequired: row.authRequired === true,
    }));
    await out(
      flags.json
        ? JSON.stringify(list, null, 2) + '\n'
        : [
            'METHOD\tPATH\tSERVICE\tENABLED\tAUTH',
            ...list.map(
              (row) =>
                `${row.method}\t${row.path}\t${row.serviceId}\t${row.enabled}\t${row.authRequired}`,
            ),
          ].join('\n') + '\n',
    );
  } else if (command === 'routes export') {
    const source = await client.text(
      client.path('/export'),
      {},
      DECLARATIVE_CONFIG_MAX_BYTES,
    );
    if (flags.output) {
      try {
        await writeFile(flags.output, source, { flag: 'wx', mode: 0o600 });
      } catch {
        throw new CliError(
          'Export output must be a new writable file. Existing files and symlinks are refused.',
          2,
        );
      }
      await out('Configuration exported.\n');
    } else await out(source);
  } else if (command === 'routes apply') {
    const source = await documentFile(args[2] ?? 'gateway.yml');
    const reviewed = preview(
      await client.json(client.path('/import?dryRun=true'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/yaml' },
        body: source,
      }),
    );
    const diff = {
      dryRun: true,
      changes: reviewed.changes,
      unchanged: reviewed.unchanged,
      configVersion: reviewed.configVersion,
      expiresAt: reviewed.expiresAt,
    };
    const summary = [
      'ACTION\tENTRY\tFIELDS',
      ...reviewed.changes.map(
        (row) =>
          `${row.action}\t${row.resource}: ${row.key}\t${row.fields.join(', ')}`,
      ),
    ].join('\n');
    if (flags['dry-run']) {
      await out(
        flags.json ? JSON.stringify(diff, null, 2) + '\n' : summary + '\n',
      );
      return;
    }
    process.stderr.write(
      summary +
        '\nComplete replacement: missing services/routes are removed; missing consumers are revoked.\n',
    );
    if (
      !flags.yes &&
      !/^(y|yes)$/i.test(
        (await ask('Apply these reviewed changes? [y/N] ')).trim(),
      )
    ) {
      await out('Cancelled. No changes submitted.\n');
      return;
    }
    const result = object(
      await client.json(client.path('/import?dryRun=false'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/yaml',
          'If-Match': `"${reviewed.revision}"`,
        },
        body: source,
      }),
    ) as unknown as ConfigApplyResult;
    if (
      !Number.isSafeInteger(result.changed) ||
      !Number.isSafeInteger(result.configVersion) ||
      !['queued', 'unchanged'].includes(result.delivery)
    )
      throw new CliError(
        'API returned an invalid apply result. Check current configuration before retrying.',
      );
    const keys = rows(result.consumerKeys).map((row) =>
      consumerKey(row, tenant),
    );
    if (keys.length)
      process.stderr.write(
        'Save new consumer keys now; they cannot be viewed again.\n',
      );
    await out(
      flags.json
        ? JSON.stringify(
            {
              dryRun: false,
              changed: result.changed,
              configVersion: result.configVersion,
              delivery: result.delivery,
              consumerKeys: keys,
            },
            null,
            2,
          ) + '\n'
        : `${result.changed} changes saved. Gateway delivery: ${result.delivery}.\n` +
            keys.map((row) => `${row.name}\t${row.apiKey}\n`).join(''),
    );
  } else if (command === 'consumers create') {
    if (
      !flags.name ||
      flags.name.trim() !== flags.name ||
      flags.name.length > 128 ||
      safeText(flags.name) !== flags.name
    )
      throw new CliError(
        'Provide --name with a non-empty name of at most 128 characters.',
        2,
      );
    const row = consumerKey(
      object(
        await client.json(client.path('/consumers'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: flags.name }),
        }),
      ),
      tenant,
    );
    process.stderr.write(
      'Save this consumer key now; it cannot be viewed again.\n',
    );
    await out(
      flags.json
        ? JSON.stringify(row, null, 2) + '\n'
        : `${row.name}\t${row.id}\n${row.apiKey}\n`,
    );
  } else if (command === 'alerts list') {
    const response = object(await client.json(client.path('/alerts')));
    const list = rows(response.rules).map((row) => ({
      id: safeText(row.id),
      name: safeText(row.name),
      enabled: row.enabled === true,
      metric: safeText(row.metric),
      operator: safeText(row.operator),
      threshold: typeof row.threshold === 'number' ? row.threshold : null,
    }));
    await out(
      flags.json
        ? JSON.stringify(list, null, 2) + '\n'
        : [
            'NAME\tMETRIC\tOPERATOR\tTHRESHOLD\tENABLED',
            ...list.map(
              (row) =>
                `${row.name}\t${row.metric}\t${row.operator}\t${row.threshold}\t${row.enabled}`,
            ),
          ].join('\n') + '\n',
    );
  } else if (command === 'tokens list') {
    const list = rows(await client.json(client.path('/automation-tokens'))).map(
      automationToken,
    );
    await out(
      flags.json
        ? JSON.stringify(list, null, 2) + '\n'
        : [
            'ID\tNAME\tPREFIX\tSCOPES\tEXPIRES\tLAST USED\tSTATUS',
            ...list.map(
              (row) =>
                `${row.id}\t${row.name}\t${row.displayPrefix}\t${row.scopes.join(',')}\t${row.expiresAt}\t${row.lastUsedAt ?? 'never'}\t${row.revokedAt ? 'revoked' : Date.parse(row.expiresAt) <= Date.now() ? 'expired' : 'active'}`,
            ),
          ].join('\n') + '\n',
    );
  } else if (command === 'tokens create') {
    const scopes = flags.scope ?? [];
    if (
      !flags.name ||
      flags.name.trim() !== flags.name ||
      flags.name.length > 64 ||
      safeText(flags.name) !== flags.name
    )
      throw new CliError(
        'Provide --name with a non-empty name of at most 64 characters.',
        2,
      );
    if (!scopes.length || !scopes.every(isAutomationTokenScope))
      throw new CliError(
        'Provide one or more valid --scope values, such as routes:read or config:write.',
        2,
      );
    const days =
      flags['expires-days'] === undefined
        ? undefined
        : Number(flags['expires-days']);
    if (
      days !== undefined &&
      (!/^\d{1,3}$/.test(flags['expires-days'] ?? '') ||
        days < 1 ||
        days > MAX_AUTOMATION_TOKEN_DAYS)
    )
      throw new CliError(
        `--expires-days must be a whole number from 1 to ${MAX_AUTOMATION_TOKEN_DAYS}.`,
        2,
      );
    const created = object(
      await client.json(client.path('/automation-tokens'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: flags.name,
          scopes: [...new Set(scopes)],
          ...(days === undefined ? {} : { expiresInDays: days }),
        }),
      }),
    );
    const row = automationToken(created);
    if (
      typeof created.token !== 'string' ||
      !new RegExp(`^${AUTOMATION_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`).test(
        created.token,
      )
    )
      throw new CliError(
        'API returned an invalid token. List tokens and revoke any you do not recognise.',
      );
    process.stderr.write(
      'Save this token now; it cannot be viewed again. Use it as GW_API_TOKEN.\n',
    );
    await out(
      flags.json
        ? JSON.stringify({ ...row, token: created.token }, null, 2) + '\n'
        : `${row.name}\t${row.id}\t${row.scopes.join(',')}\texpires ${row.expiresAt}\n${created.token}\n`,
    );
  } else if (command === 'tokens revoke') {
    const id = args[2];
    if (!id || !tenantPattern.test(id))
      throw new CliError('Provide the token ID shown by gwx tokens list.', 2);
    const row = automationToken(
      object(
        await client.json(client.path(`/automation-tokens/${id}`), {
          method: 'DELETE',
        }),
      ),
    );
    await out(
      flags.json
        ? JSON.stringify(row, null, 2) + '\n'
        : `Revoked ${row.name} (${row.id}) at ${row.revokedAt}.\n`,
    );
  } else if (command === 'logs tail') {
    const allowed = [
      'id',
      'method',
      'path',
      'statusCode',
      'responseTimeMs',
      'requestId',
      'timestamp',
      'consumerId',
      'clientIp',
      'userAgent',
      'downstreamService',
      'downstreamLatencyMs',
      'traceId',
      'spanId',
      'errorCode',
    ];
    await client.stream(async (row) => {
      const safe = Object.fromEntries(
        allowed
          .filter((key) => Object.hasOwn(row, key))
          .map((key) => [
            key,
            typeof row[key] === 'string'
              ? safeText(row[key])
              : typeof row[key] === 'number' && Number.isFinite(row[key])
                ? row[key]
                : null,
          ]),
      );
      await out(JSON.stringify(safe) + '\n');
    }, flags.once === true);
  }
}
function automationToken(row: Record<string, unknown>) {
  const timestamp = (value: unknown) =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (
    typeof row.id !== 'string' ||
    !tenantPattern.test(row.id) ||
    typeof row.name !== 'string' ||
    typeof row.displayPrefix !== 'string' ||
    !Array.isArray(row.scopes) ||
    !row.scopes.every(isAutomationTokenScope) ||
    !timestamp(row.createdAt) ||
    !timestamp(row.expiresAt) ||
    (row.lastUsedAt !== null && !timestamp(row.lastUsedAt)) ||
    (row.revokedAt !== null && !timestamp(row.revokedAt))
  )
    throw new CliError('API returned an invalid token record.');
  return {
    id: row.id,
    name: safeText(row.name),
    displayPrefix: safeText(row.displayPrefix),
    scopes: row.scopes as string[],
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string,
    lastUsedAt: row.lastUsedAt as string | null,
    revokedAt: row.revokedAt as string | null,
  };
}
function consumerKey(row: Record<string, unknown>, tenant: string) {
  if (
    typeof row.id !== 'string' ||
    !tenantPattern.test(row.id) ||
    typeof row.name !== 'string' ||
    typeof row.apiKey !== 'string' ||
    !row.apiKey.startsWith(`gw_${tenant}_`) ||
    !/^[a-f\d]{32,64}$/.test(row.apiKey.slice(`gw_${tenant}_`.length))
  )
    throw new CliError(
      'API returned an invalid consumer key. Check current configuration before retrying.',
    );
  return { id: row.id, name: safeText(row.name), apiKey: row.apiKey };
}
void main().catch((error) => {
  const failure =
    error instanceof CliError
      ? error
      : controller.signal.aborted &&
          controller.signal.reason instanceof CliError
        ? controller.signal.reason
        : undefined;
  const code = failure?.exitCode ?? (interrupted || 1);
  if (code !== 0)
    process.stderr.write(
      `${failure?.message ?? 'Command failed. Check the connection and local file permissions; submitted writes may already have committed.'}\n`,
    );
  process.exitCode = code;
});
