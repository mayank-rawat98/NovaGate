import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  stat,
  symlink,
  rm,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('Built gwx process with real HTTP, files and signals', () => {
  const tenant = randomUUID(),
    token = 'fixture-cli-session-never-print-this-token',
    password = 'fixture-cli-password-never-print';
  const key = `gw_${tenant}_${'a'.repeat(64)}`;
  const revision = `1791999999.${'b'.repeat(64)}`;
  const source = 'version: 1\nservices: []\nroutes: []\nconsumers: []\n';
  let directory: string, credentials: string, api: string;
  let handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ) => void;
  const requests: Array<{
    path: string;
    body: string;
    authorization?: string;
    revision?: string;
    cursor?: string;
  }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url ?? '',
      body,
      authorization: request.headers.authorization,
      revision: request.headers['if-match'] as string | undefined,
      cursor: request.headers['last-event-id'] as string | undefined,
    });
    handler(request, response, body);
  });
  const reply = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  function standard(request: IncomingMessage, response: ServerResponse) {
    if (request.url === '/api/auth/login')
      return reply(response, { tenantId: tenant, token });
    if (request.url?.includes('dryRun=true'))
      return reply(response, {
        dryRun: true,
        revision,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        configVersion: 12,
        unchanged: 0,
        changes: [
          {
            resource: 'consumer',
            action: 'create',
            key: 'cli-client',
            fields: ['name'],
          },
        ],
      });
    if (request.url?.includes('dryRun=false'))
      return reply(response, {
        dryRun: false,
        changed: 1,
        configVersion: 13,
        delivery: 'queued',
        consumerKeys: [{ id: randomUUID(), name: 'cli-client', apiKey: key }],
      });
    if (request.url?.endsWith('/routes'))
      return reply(response, [
        {
          id: randomUUID(),
          method: 'GET',
          pathPattern: '/users',
          serviceId: randomUUID(),
          enabled: true,
          authRequired: true,
          plugins: [{ config: { clientSecret: password } }],
          keyHash: password,
        },
      ]);
    if (request.url?.endsWith('/consumers'))
      return reply(response, {
        id: randomUUID(),
        name: 'ci-bot',
        apiKey: key,
        keyHash: password,
      });
    if (request.url?.endsWith('/alerts'))
      return reply(response, {
        rules: [
          {
            id: randomUUID(),
            name: 'Latency',
            enabled: true,
            metric: 'p95',
            operator: 'gt',
            threshold: 100,
          },
        ],
        channels: [{ credential: password }],
      });
    if (request.url?.endsWith('/export')) {
      response.writeHead(200, { 'Content-Type': 'application/yaml' });
      response.end(source);
      return;
    }
    reply(response, { message: password }, 404);
  }
  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('TCP address required');
    api = `http://127.0.0.1:${address.port}/api`;
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gwx-test-'));
    credentials = join(directory, 'credentials');
    handler = standard;
    requests.length = 0;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });
  function start(args: string[], env: Record<string, string> = {}) {
    const child = spawn(
      process.env.GWX_TEST_NODE_EXECUTABLE ?? process.execPath,
      [resolve(__dirname, '../dist/main.js'), ...args],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          GWX_CONFIG_DIR: credentials,
          GW_API_URL: api,
          GW_TENANT_ID: tenant,
          GW_API_TOKEN: token,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end();
    const done = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) =>
      child.once('close', (code) => resolve({ code, stdout, stderr })),
    );
    const deadline = setTimeout(() => child.kill('SIGKILL'), 4500);
    void done.finally(() => clearTimeout(deadline));
    return { child, done };
  }
  const run = (args: string[], env: Record<string, string> = {}) =>
    start(args, env).done;
  async function document() {
    const path = join(directory, 'gateway.yml');
    await writeFile(path, source);
    return path;
  }
  it('prints help/version without credentials or network and rejects unknown options without echoing values', async () => {
    expect((await run(['--version'])).stdout).toBe('0.0.1\n');
    expect((await run(['--help'])).stdout).toContain('routes apply');
    const invalid = await run(['--password', password]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).not.toContain(password);
    expect(requests).toHaveLength(0);
  });
  it('logs in, privately persists an origin-bound session and logs out without printing credentials', async () => {
    const signed = await run(['login'], {
      GW_API_TOKEN: '',
      GW_EMAIL: 'cli@example.test',
      GW_PASSWORD: password,
    });
    expect(signed.code).toBe(0);
    expect(signed.stdout).not.toContain(token);
    expect(signed.stderr).not.toContain(password);
    expect((await stat(credentials)).mode & 0o777).toBe(0o700);
    expect((await stat(join(credentials, 'credentials'))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      JSON.parse(await readFile(join(credentials, 'credentials'), 'utf8')),
    ).toMatchObject({ tenantId: tenant, apiUrl: api, token });
    requests.length = 0;
    expect((await run(['routes', 'list'], { GW_API_TOKEN: '' })).code).toBe(0);
    expect(requests[0].authorization).toBe(`Bearer ${token}`);
    expect((await run(['logout'])).code).toBe(0);
    await expect(stat(join(credentials, 'credentials'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('keeps the old session on a failed login and does not reflect server error data', async () => {
    await run(['login'], {
      GW_API_TOKEN: '',
      GW_EMAIL: 'cli@example.test',
      GW_PASSWORD: password,
    });
    const saved = await readFile(join(credentials, 'credentials'), 'utf8');
    handler = (_request, response) =>
      reply(response, { message: password }, 401);
    const failed = await run(['login'], {
      GW_EMAIL: 'cli@example.test',
      GW_PASSWORD: password,
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).not.toContain(password);
    expect(await readFile(join(credentials, 'credentials'), 'utf8')).toBe(
      saved,
    );
  });
  it('refuses saved credentials for another API or workspace before sending them', async () => {
    await run(['login'], {
      GW_API_TOKEN: '',
      GW_EMAIL: 'cli@example.test',
      GW_PASSWORD: password,
    });
    requests.length = 0;
    expect(
      (
        await run(
          ['routes', 'list', '--api-url', 'https://other.example.test/api'],
          { GW_API_TOKEN: '' },
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await run(['routes', 'list', '--tenant', randomUUID()], {
          GW_API_TOKEN: '',
        })
      ).code,
    ).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it('uses explicit environment credentials without reading unsafe stored sessions', async () => {
    await mkdir(credentials);
    await writeFile(join(credentials, 'credentials'), password, {
      mode: 0o644,
    });
    expect((await run(['routes', 'list'])).code).toBe(0);
    expect((await run(['routes', 'list'], { GW_API_TOKEN: '' })).code).toBe(1);
  });
  it('refuses credential symlinks and repairs a corrupt owned session through a fresh login', async () => {
    await mkdir(credentials, { mode: 0o700 });
    const target = join(directory, 'external');
    await writeFile(target, password);
    await symlink(target, join(credentials, 'credentials'));
    expect(
      (
        await run(['login'], {
          GW_EMAIL: 'cli@example.test',
          GW_PASSWORD: password,
        })
      ).code,
    ).toBe(1);
    expect(await readFile(target, 'utf8')).toBe(password);
    await rm(join(credentials, 'credentials'));
    await writeFile(join(credentials, 'credentials'), 'invalid', {
      mode: 0o600,
    });
    expect(
      (
        await run(['login'], {
          GW_EMAIL: 'cli@example.test',
          GW_PASSWORD: password,
        })
      ).code,
    ).toBe(0);
  });
  it.each([
    'http://example.test/api',
    'https://user:password@example.test/api',
    'https://example.test/api?token=secret',
    'https://example.test/api#secret',
  ])('refuses unsafe API base %s', async (base) => {
    expect((await run(['routes', 'list', '--api-url', base])).code).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it('projects route/alert metadata without plugin, hash, channel or terminal-control disclosure', async () => {
    const routes = await run(['routes', 'list', '--json']);
    expect(routes.code).toBe(0);
    expect(routes.stdout).not.toContain(password);
    expect(JSON.parse(routes.stdout)[0].path).toBe('/users');
    const alerts = await run(['alerts', 'list', '--json']);
    expect(alerts.code).toBe(0);
    expect(alerts.stdout).not.toContain(password);
    handler = (_req, res) =>
      reply(res, [
        { method: 'GET\u001b[31m', pathPattern: '/x\u202e', enabled: true },
      ]);
    const controlled = await run(['routes', 'list']);
    expect(controlled.stdout).not.toContain('\u001b');
    expect(controlled.stdout).not.toContain('\u202e');
  });
  it('exports exact YAML to a private new file and refuses existing files', async () => {
    const path = join(directory, 'export.yml');
    expect((await run(['routes', 'export', '--output', path])).code).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(source);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await run(['routes', 'export', '--output', path])).code).toBe(2);
    expect(await readFile(path, 'utf8')).toBe(source);
  });
  it('dry-runs the exact source with no writes, revision or consumer keys in the diff', async () => {
    const result = await run([
      'routes',
      'apply',
      await document(),
      '--dry-run',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toBe(source);
    expect(requests[0].path).toContain('dryRun=true');
    expect(result.stdout).not.toContain(key);
    expect(result.stdout).not.toContain(revision);
    expect(JSON.parse(result.stdout).changes).toHaveLength(1);
  });
  it('accepts all 400 preview actions for a complete 200-consumer replacement', async () => {
    const path = await document();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        services: [],
        routes: [],
        consumers: Array.from({ length: 200 }, (_, i) => ({
          name: `new-${i}`,
        })),
      }),
    );
    handler = (_request, response) =>
      reply(response, {
        dryRun: true,
        revision,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        configVersion: 12,
        unchanged: 0,
        changes: [
          ...Array.from({ length: 200 }, (_, i) => ({
            resource: 'consumer',
            action: 'create',
            key: `new-${i}`,
            fields: ['name'],
          })),
          ...Array.from({ length: 200 }, (_, i) => ({
            resource: 'consumer',
            action: 'remove',
            key: `old-${i}`,
            fields: [],
          })),
        ],
      });
    const result = await run(['routes', 'apply', path, '--dry-run', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).changes).toHaveLength(400);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toContain('dryRun=true');
  });
  it('requires acknowledgement in automation before applying a preview', async () => {
    const result = await run(['routes', 'apply', await document()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Interactive input');
    expect(requests).toHaveLength(1);
  });
  it('applies the identical reviewed bytes and If-Match once and prints newly created keys once', async () => {
    const result = await run([
      'routes',
      'apply',
      await document(),
      '--yes',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toBe(requests[1].body);
    expect(requests[1].revision).toBe(`"${revision}"`);
    expect(JSON.parse(result.stdout)).toMatchObject({
      delivery: 'queued',
      changed: 1,
    });
    expect(result.stdout.split(key)).toHaveLength(2);
    await expect(stat(credentials)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not retry a revision conflict or disclose the server body', async () => {
    handler = (req, res) =>
      req.url?.includes('dryRun=false')
        ? reply(res, { message: password }, 409)
        : standard(req, res);
    const result = await run(['routes', 'apply', await document(), '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Review a new preview');
    expect(result.stderr).not.toContain(password);
    expect(requests).toHaveLength(2);
  });
  it('refuses oversized/nonregular/symlink documents before contacting the API', async () => {
    const path = await document();
    await writeFile(path, 'a'.repeat(65537));
    expect((await run(['routes', 'apply', path, '--yes'])).code).toBe(2);
    const link = join(directory, 'link');
    await symlink(path, link);
    expect((await run(['routes', 'apply', link, '--yes'])).code).toBe(2);
    expect((await run(['routes', 'apply', directory, '--yes'])).code).toBe(2);
    expect(requests).toHaveLength(0);
  });
  it('refuses a real FIFO document without waiting for a writer or contacting the API', async () => {
    const path = join(directory, 'document-pipe');
    execFileSync('mkfifo', [path]);
    const result = await run(['routes', 'apply', path, '--yes']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('regular configuration file');
    expect(requests).toHaveLength(0);
  });
  it('refuses a real FIFO credential store without waiting for a writer or contacting the API', async () => {
    await mkdir(credentials, { mode: 0o700 });
    const path = join(credentials, 'credentials');
    execFileSync('mkfifo', [path]);
    await chmod(path, 0o600);
    const result = await run(['routes', 'list'], { GW_API_TOKEN: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('owned regular file');
    expect(requests).toHaveLength(0);
  });
  it('creates a consumer using the real endpoint and returns only its one-time key fields', async () => {
    const result = await run([
      'consumers',
      'create',
      '--name',
      'ci-bot',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(requests[0].body)).toEqual({ name: 'ci-bot' });
    expect(result.stdout).toContain(key);
    expect(result.stdout).not.toContain(password);
  });
  it('creates, lists and revokes scoped automation tokens, printing the secret once', async () => {
    const id = randomUUID();
    const secret = `ngat_${'Q'.repeat(43)}`;
    const summary = {
      id,
      name: 'deploy',
      scopes: ['config:write', 'routes:read'],
      displayPrefix: secret.slice(0, 11),
      createdAt: '2026-10-25T00:00:00.000Z',
      expiresAt: '2027-01-23T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    handler = (request, response) => {
      if (request.method === 'POST')
        return reply(
          response,
          { ...summary, token: secret, tokenHash: password },
          201,
        );
      if (request.method === 'DELETE')
        return reply(response, {
          ...summary,
          revokedAt: '2026-10-25T01:00:00.000Z',
        });
      reply(response, [{ ...summary, tokenHash: password }]);
    };
    const created = await run([
      'tokens',
      'create',
      '--name',
      'deploy',
      '--scope',
      'routes:read',
      '--scope',
      'config:write',
      '--scope',
      'routes:read',
      '--expires-days',
      '90',
      '--json',
    ]);
    expect(created.code).toBe(0);
    expect(requests[0].path).toBe(`/api/tenants/${tenant}/automation-tokens`);
    expect(JSON.parse(requests[0].body)).toEqual({
      name: 'deploy',
      scopes: ['routes:read', 'config:write'],
      expiresInDays: 90,
    });
    expect(created.stdout.split(secret)).toHaveLength(2);
    expect(created.stdout).not.toContain(password);
    expect(created.stderr).toContain('cannot be viewed again');
    const listed = await run(['tokens', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`${id}\tdeploy\t${summary.displayPrefix}`);
    expect(listed.stdout).toContain('\tnever\tactive');
    expect(listed.stdout).not.toContain(secret);
    expect(listed.stdout).not.toContain(password);
    const revoked = await run(['tokens', 'revoke', id]);
    expect(revoked.code).toBe(0);
    expect(requests.at(-1)?.path).toBe(
      `/api/tenants/${tenant}/automation-tokens/${id}`,
    );
    expect(revoked.stdout).toContain('Revoked deploy');
  });
  it.each([
    [['tokens', 'create', '--name', 'x']],
    [['tokens', 'create', '--name', 'x', '--scope', 'routes:admin']],
    [
      [
        'tokens',
        'create',
        '--name',
        'x',
        '--scope',
        'routes:read',
        '--expires-days',
        '400',
      ],
    ],
    [
      [
        'tokens',
        'create',
        '--name',
        'x',
        '--scope',
        'routes:read',
        '--expires-days',
        '1.5',
      ],
    ],
    [['tokens', 'revoke', 'not-a-uuid']],
    [['tokens', 'revoke']],
  ])(
    'refuses invalid token commands %j before contacting the API',
    async (args) => {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(requests).toHaveLength(0);
    },
  );
  it('explains a missing token scope without echoing the server body', async () => {
    handler = (_request, response) =>
      reply(response, { message: password }, 403);
    const result = await run(['routes', 'list'], {
      GW_API_TOKEN: `ngat_${'R'.repeat(43)}`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('lacks the scope for this command');
    expect(result.stderr).not.toContain(password);
  });
  it('rejects redirects without forwarding credentials or echoing response bodies', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: 'https://other.example.test' });
      res.end(password);
    };
    const result = await run(['routes', 'list']);
    expect(result.code).toBe(1);
    expect(requests).toHaveLength(1);
    expect(result.stderr).not.toContain(password);
  });
  it('consumes chunked CRLF SSE, projects private fields away and exits once a real batch arrives', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': heartbeat\r\n\r\nid: v1.fixture\r\nevent: logs\r\nda');
      res.end(
        'ta: ' +
          JSON.stringify([
            {
              id: randomUUID(),
              path: '/tail',
              statusCode: 200,
              apiKey: key,
              keyHash: password,
              receivedAt: password,
            },
          ]) +
          '\r\n\r\n',
      );
    };
    const result = await run(['logs', 'tail', '--once']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).path).toBe('/tail');
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain(key);
  });
  it('reconnects after EOF with its last completed cursor', async () => {
    let connections = 0;
    handler = (_req, res) => {
      connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `id: v1.${connections}\nevent: logs\ndata: ${JSON.stringify([{ id: randomUUID(), path: `/tail-${connections}` }])}\n\n`,
      );
    };
    const work = start(['logs', 'tail']);
    const deadline = Date.now() + 3000;
    while (connections < 2 && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 20));
    work.child.kill('SIGINT');
    const result = await work.done;
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(result.code).toBe(130);
    // The second request resumes the complete first batch rather than a partial chunk.
    expect(requests[0].path).toContain('/logs/stream');
    expect(requests[1].cursor).toBe('v1.1');
  });
  it('cancels an admitted held read on SIGTERM with a bounded exit', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    };
    const work = start(['logs', 'tail']);
    const deadline = Date.now() + 2000;
    while (!requests.length && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 10));
    work.child.kill('SIGTERM');
    expect((await work.done).code).toBe(143);
  });
  it('refuses invalid or oversized stream frames with finite failure', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: logs\ndata: ' + 'a'.repeat(131073) + '\n\n');
    };
    expect((await run(['logs', 'tail', '--once'])).code).toBe(1);
  });
  it('releases the HTTP stream and exits successfully when its output pipe closes', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => {
        response.write(
          'id: v1.pipe\nevent: logs\ndata: [{"path":"/pipe"}]\n\n',
        );
      }, 10);
      response.once('close', () => clearInterval(timer));
    };
    const work = start(['logs', 'tail']);
    work.child.stdout.destroy();
    expect((await work.done).code).toBe(0);
  });
});
