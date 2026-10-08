import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import {
  DATADOG_LOG_SITES,
  type LogExportDestinationCredentials,
} from '@api-gateway/shared-types';
import { isPublicAlertAddress } from '../alerts/alert-egress-policy';

function invalid(
  message = 'Provide supported destination credentials without extra fields.',
): never {
  throw new BadRequestException(message);
}
export function destinationRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) invalid();
  return record;
}
function text(value: unknown, min: number, max: number): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < min ||
    Buffer.byteLength(value, 'utf8') > max ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid();
  return value;
}
export function destinationName(value: unknown): string {
  const name = text(value, 1, 80).trim();
  if (!name) invalid('Use a destination name of 1–80 bytes.');
  return name;
}
export function destinationUuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
  )
    invalid('Use a valid destination identifier and its latest revision.');
  return value.toLowerCase();
}
function url(value: unknown): URL {
  try {
    const raw = text(value, 1, 2048);
    // URL parsing normalizes whitespace and alternate IP spellings. Check both.
    if (/[\s\\]/.test(raw) || raw !== raw.trim()) throw new Error();
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (
      parsed.protocol !== 'https:' ||
      (parsed.port && parsed.port !== '443') ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (isIP(host)
        ? !isPublicAlertAddress(host)
        : !host.includes('.') ||
          host === 'metadata.google.internal' ||
          host.endsWith('.localhost') ||
          host.endsWith('.local') ||
          host.endsWith('.internal') ||
          host.endsWith('.home.arpa'))
    )
      throw new Error();
    return parsed;
  } catch {
    invalid(
      'Use a public HTTPS destination on port 443 without URL credentials or a fragment.',
    );
  }
}
/** Syntactic validation only; delivery must additionally pin validated DNS at connect. */
export function destinationCredentials(input: unknown): {
  credentials: LogExportDestinationCredentials;
  destination: string;
} {
  const value = destinationRecord(input, [
    'type',
    'endpoint',
    'region',
    'bucket',
    'accessKeyId',
    'secretAccessKey',
    'sessionToken',
    'forcePathStyle',
    'url',
    'signingSecret',
    'site',
    'apiKey',
  ]);
  if (value.type === 'webhook') {
    destinationRecord(value, ['type', 'url', 'signingSecret']);
    const target = url(value.url);
    return {
      destination: target.origin,
      credentials: {
        type: 'webhook',
        url: target.href,
        signingSecret: text(value.signingSecret, 32, 256),
      },
    };
  }
  if (value.type === 's3') {
    destinationRecord(value, [
      'type',
      'endpoint',
      'region',
      'bucket',
      'accessKeyId',
      'secretAccessKey',
      'sessionToken',
      'forcePathStyle',
    ]);
    const endpoint = url(value.endpoint);
    if (endpoint.pathname !== '/' || endpoint.search)
      invalid('Use an S3 HTTPS origin without a path or query.');
    const bucket = text(value.bucket, 3, 63);
    // Ordinary S3 buckets only, excluding reserved directory/access-point aliases.
    if (
      !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
      bucket.includes('..') ||
      isIP(bucket) ||
      /^(xn--|sthree-|amzn-s3-demo-)/.test(bucket) ||
      /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(bucket)
    )
      invalid('Use a supported S3 bucket name.');
    const region = text(value.region, 1, 64);
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(region) ||
      typeof value.forcePathStyle !== 'boolean'
    )
      invalid();
    const credentials: LogExportDestinationCredentials = {
      type: 's3',
      endpoint: endpoint.origin,
      bucket,
      region,
      accessKeyId: text(value.accessKeyId, 1, 256),
      secretAccessKey: text(value.secretAccessKey, 1, 1024),
      forcePathStyle: value.forcePathStyle,
    };
    if (Object.hasOwn(value, 'sessionToken'))
      credentials.sessionToken = text(value.sessionToken, 1, 1024);
    return { destination: endpoint.origin, credentials };
  }
  if (value.type === 'datadog') {
    destinationRecord(value, ['type', 'site', 'apiKey']);
    const site = DATADOG_LOG_SITES.find((site) => site === value.site);
    if (!site) invalid('Select a supported Datadog site.');
    const apiKey = text(value.apiKey, 32, 32);
    if (!/^[a-f\d]{32}$/i.test(apiKey))
      invalid('Provide a valid Datadog API key.');
    return {
      destination: site,
      credentials: { type: 'datadog', site, apiKey },
    };
  }
  return invalid();
}
