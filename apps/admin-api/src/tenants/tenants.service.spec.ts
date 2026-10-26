import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { TenantsService } from './tenants.service';

describe('tenant certificate upload boundary', () => {
  let directory: string;
  let ca: string;
  let leaf: string;
  beforeAll(() => {
    const artifacts = resolve(__dirname, '../../../../.local-work');
    mkdirSync(artifacts, { recursive: true });
    directory = mkdtempSync(resolve(artifacts, 'tenant-ca-'));
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, {
        cwd: directory,
        stdio: 'ignore',
        timeout: 15000,
      });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=Upload CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    );
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=Leaf',
    );
    writeFileSync(
      resolve(directory, 'leaf.ext'),
      'basicConstraints=critical,CA:FALSE\n',
    );
    openssl(
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'leaf.pem',
      '-days',
      '1',
      '-extfile',
      'leaf.ext',
    );
    ca = readFileSync(resolve(directory, 'ca.pem'), 'utf8');
    leaf = readFileSync(resolve(directory, 'leaf.pem'), 'utf8');
  }, 30000);
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  function build() {
    const repo = { update: jest.fn().mockResolvedValue({}) };
    const push = { triggerUpdate: jest.fn().mockResolvedValue(undefined) };
    return {
      repo,
      push,
      service: new TenantsService(
        repo as never,
        {} as never,
        {} as never,
        push as never,
      ),
    };
  }
  it('persists a real CA and broadcasts it only after successful validation', async () => {
    const { service, repo, push } = build();
    expect(await service.setCaCert('tenant', ca)).toEqual({ success: true });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'tenant' },
      { caCertPem: ca.trim() },
    );
    expect(push.triggerUpdate).toHaveBeenCalledWith('tenant');
  });
  it('supports CA overlap for rotation and explicit removal', async () => {
    const { service, repo } = build();
    await service.setCaCert('tenant', `${ca}\n${ca}`);
    await service.setCaCert('tenant', null);
    expect(repo.update).toHaveBeenLastCalledWith(
      { id: 'tenant' },
      { caCertPem: null },
    );
  });
  it('rejects malformed, private-key, leaf, over-count and oversized input before persistence', async () => {
    for (const invalid of [
      '',
      'invalid',
      leaf,
      ca + '\nPRIVATE KEY',
      ca.repeat(9),
      'a'.repeat(65537),
      undefined,
    ]) {
      const { service, repo, push } = build();
      await expect(
        service.setCaCert('tenant', invalid as string),
      ).rejects.toThrow('CA certificate');
      expect(repo.update).not.toHaveBeenCalled();
      expect(push.triggerUpdate).not.toHaveBeenCalled();
    }
  });
});
