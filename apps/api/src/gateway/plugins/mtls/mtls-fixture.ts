import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { resolve } from 'node:path';

/** Real private test keys stay in NovaGate and are removed after each suite. */
export function mtlsFixture() {
  const artifacts = resolve(__dirname, '../../../../../../.local-work');
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(resolve(artifacts, 'mtls-fixture-'));
  const file = (name: string) => resolve(directory, name);
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, {
      cwd: directory,
      stdio: 'ignore',
      timeout: 15000,
    });
  const ca = (name: string) =>
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.pem`,
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    );
  const cert = (
    name: string,
    issuer: string,
    purpose: 'clientAuth' | 'serverAuth',
    intermediate = false,
  ) => {
    openssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${name}`,
    );
    writeFileSync(
      file(`${name}.ext`),
      `basicConstraints=critical,CA:${intermediate ? 'TRUE,pathlen:0' : 'FALSE'}\nkeyUsage=critical,${intermediate ? 'keyCertSign,cRLSign' : 'digitalSignature,keyEncipherment'}\n${intermediate ? '' : `extendedKeyUsage=${purpose}\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`}`,
    );
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${issuer}.pem`,
      '-CAkey',
      `${issuer}.key`,
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '1',
      '-extfile',
      `${name}.ext`,
    );
  };
  try {
    ca('ca');
    ca('other-ca');
    cert('server', 'ca', 'serverAuth');
    cert('client', 'ca', 'clientAuth');
    cert('wrong-client', 'other-ca', 'clientAuth');
    cert('wrong-purpose', 'ca', 'serverAuth');
    cert('intermediate', 'ca', 'clientAuth', true);
    cert('intermediate-client', 'intermediate', 'clientAuth');
    writeFileSync(file('index.txt'), '');
    writeFileSync(file('serial'), '1000\n');
    writeFileSync(file('crlnumber'), '1000\n');
    writeFileSync(
      file('ca.cnf'),
      '[ca]\ndefault_ca=default\n[default]\ndatabase=index.txt\ncertificate=ca.pem\nprivate_key=ca.key\nserial=serial\ncrlnumber=crlnumber\ndefault_md=sha256\ndefault_crl_days=1\npolicy=policy\n[policy]\ncommonName=supplied\n',
    );
    openssl('ca', '-config', 'ca.cnf', '-revoke', 'client.pem', '-batch');
    openssl('ca', '-config', 'ca.cnf', '-gencrl', '-out', 'ca.crl', '-batch');

    return {
      directory,
      file,
      read: (name: string) => readFileSync(file(name)),
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
