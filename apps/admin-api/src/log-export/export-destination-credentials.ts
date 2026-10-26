import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { LogExportDestinationType } from '@api-gateway/shared-types';
import { tenantSchema } from '../tenants/tenant-schema';

export const MAX_EXPORT_DESTINATION_CREDENTIAL_BYTES = 4096;
export interface EncryptedExportDestinationCredentials {
  version: 1;
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}
function decode(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || value.length > 8192) throw new Error();
  const buffer = Buffer.from(value, 'base64');
  if (
    buffer.toString('base64') !== value ||
    (bytes !== undefined && buffer.length !== bytes)
  )
    throw new Error();
  return buffer;
}

/** Dedicated key ring: retain old keys for reads and choose one explicit write key. */
export class ExportDestinationCredentialCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKey: string;
  get enabled(): boolean {
    return this.keys.size > 0;
  }
  destroy() {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }
  constructor(env: Record<string, unknown>) {
    const raw = env.LOG_EXPORT_DESTINATION_KEYS;
    const active = env.LOG_EXPORT_DESTINATION_ACTIVE_KEY;
    this.activeKey = typeof active === 'string' ? active : '';
    if (
      (raw === undefined || raw === '') &&
      (active === undefined || active === '')
    )
      return;
    try {
      if (
        typeof raw !== 'string' ||
        !raw.length ||
        raw.length > 4096 ||
        typeof active !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,32}$/.test(active)
      )
        throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error();
      const entries = Object.entries(parsed);
      if (!entries.length || entries.length > 4) throw new Error();
      for (const [id, key] of entries) {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error();
        this.keys.set(id, decode(key, 32));
      }
      if (!this.keys.has(active)) throw new Error();
    } catch {
      throw new Error(
        'Invalid log export destination encryption configuration.',
      );
    }
  }
  private aad(
    tenantId: string,
    destinationId: string,
    type: LogExportDestinationType,
    keyId: string,
  ): Buffer {
    const schema = tenantSchema(tenantId);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(destinationId))
      throw new Error();
    return Buffer.from(
      JSON.stringify([
        'novagate-log-export-destination',
        1,
        schema,
        destinationId.toLowerCase(),
        type,
        keyId,
      ]),
    );
  }
  encrypt(
    tenantId: string,
    destinationId: string,
    type: LogExportDestinationType,
    credentials: unknown,
  ): EncryptedExportDestinationCredentials {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'Export destination configuration is not enabled.',
      );
    const plaintext = Buffer.from(JSON.stringify(credentials));
    if (plaintext.length > MAX_EXPORT_DESTINATION_CREDENTIAL_BYTES)
      throw new ServiceUnavailableException(
        'Export destination credentials exceed the storage limit.',
      );
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.keys.get(this.activeKey) as Buffer,
      nonce,
    );
    cipher.setAAD(this.aad(tenantId, destinationId, type, this.activeKey));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      version: 1,
      keyId: this.activeKey,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  decrypt(
    tenantId: string,
    destinationId: string,
    type: LogExportDestinationType,
    input: unknown,
  ): unknown {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error();
      const value = input as Record<string, unknown>;
      const fields = ['version', 'keyId', 'nonce', 'tag', 'ciphertext'];
      if (
        Object.keys(value).length !== fields.length ||
        Object.keys(value).some((key) => !fields.includes(key)) ||
        value.version !== 1 ||
        typeof value.keyId !== 'string'
      )
        throw new Error();
      const key = this.keys.get(value.keyId);
      if (!key) throw new Error();
      const ciphertext = decode(value.ciphertext);
      if (
        !ciphertext.length ||
        ciphertext.length > MAX_EXPORT_DESTINATION_CREDENTIAL_BYTES
      )
        throw new Error();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        decode(value.nonce, 12),
      );
      decipher.setAAD(this.aad(tenantId, destinationId, type, value.keyId));
      decipher.setAuthTag(decode(value.tag, 16));
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new ServiceUnavailableException(
        'Export destination credentials are unavailable.',
      );
    }
  }
}
