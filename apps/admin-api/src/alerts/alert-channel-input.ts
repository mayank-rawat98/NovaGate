import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import {
  MAX_ALERT_NAME_LENGTH,
  type AlertChannelType,
} from '@api-gateway/shared-types';
import { isPublicAlertAddress } from './alert-egress-policy';

function hasControl(value: string, includeSpace = false): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < (includeSpace ? 33 : 32) ||
      character.charCodeAt(0) === 127,
  );
}
export type AlertChannelCredentials =
  | { type: 'webhook'; url: string; secret: string }
  | { type: 'slack'; webhookUrl: string }
  | { type: 'email'; address: string };
export interface NormalizedAlertChannel {
  name: string;
  type: AlertChannelType;
  enabled: boolean;
  destination: string;
  credentials: AlertChannelCredentials;
}
export function alertChannelName(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.trim().length > MAX_ALERT_NAME_LENGTH ||
    hasControl(input)
  )
    throw new BadRequestException(
      `Use a channel name of 1–${MAX_ALERT_NAME_LENGTH} characters without control characters.`,
    );
  return input.trim();
}
export function alertChannelEnabled(input: unknown, fallback = true): boolean {
  if (input === undefined) return fallback;
  if (typeof input !== 'boolean')
    throw new BadRequestException(
      'Channel enabled state must be true or false.',
    );
  return input;
}
function destinationUrl(input: unknown, trusted: ReadonlySet<string>): URL {
  try {
    if (
      typeof input !== 'string' ||
      input.length > 2048 ||
      !input ||
      input !== input.trim() ||
      hasControl(input, true)
    )
      throw new Error();
    const url = new URL(input);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new Error();
    if (!trusted.has(url.origin)) {
      if (url.protocol !== 'https:' || (url.port && url.port !== '443'))
        throw new Error();
      const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (
        (isIP(host) && !isPublicAlertAddress(host)) ||
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === 'metadata.google.internal' ||
        (!isIP(host) && !host.includes('.'))
      )
        throw new Error();
    }
    return url;
  } catch {
    throw new BadRequestException(
      'Use a public HTTPS destination without credentials or a fragment.',
    );
  }
}
export function normalizeAlertCredentials(
  input: unknown,
  trusted: ReadonlySet<string> = new Set(),
): {
  type: AlertChannelType;
  destination: string;
  credentials: AlertChannelCredentials;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Provide channel credentials.');
  const value = input as Record<string, unknown>;
  const fields =
    value.type === 'webhook'
      ? ['type', 'url', 'secret']
      : value.type === 'slack'
        ? ['type', 'webhookUrl']
        : value.type === 'email'
          ? ['type', 'address']
          : [];
  if (!fields.length || Object.keys(value).some((key) => !fields.includes(key)))
    throw new BadRequestException(
      'Provide a supported channel without extra credential fields.',
    );
  if (value.type === 'email') {
    if (
      typeof value.address !== 'string' ||
      value.address.length > 254 ||
      !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(
        value.address,
      ) ||
      value.address.split('@')[0].length > 64 ||
      value.address.includes('..') ||
      value.address.startsWith('.') ||
      value.address.split('@')[0].endsWith('.') ||
      value.address
        .split('@')[1]
        .split('.')
        .some(
          (label) =>
            !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
        )
    )
      throw new BadRequestException('Provide one valid email recipient.');
    return {
      type: 'email',
      destination: value.address,
      credentials: { type: 'email', address: value.address },
    };
  }
  const url = destinationUrl(
    value.type === 'webhook' ? value.url : value.webhookUrl,
    trusted,
  );
  if (value.type === 'slack') {
    if (
      !trusted.has(url.origin) &&
      (!['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) ||
        url.search ||
        !/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(
          url.pathname,
        ))
    )
      throw new BadRequestException(
        'Provide a valid Slack incoming webhook URL.',
      );
    return {
      type: 'slack',
      destination: url.origin,
      credentials: { type: 'slack', webhookUrl: url.href },
    };
  }
  if (
    typeof value.secret !== 'string' ||
    Buffer.byteLength(value.secret, 'utf8') < 32 ||
    Buffer.byteLength(value.secret, 'utf8') > 256 ||
    hasControl(value.secret)
  )
    throw new BadRequestException(
      'Use a webhook signing secret of 32–256 bytes without control characters.',
    );
  return {
    type: 'webhook',
    destination: url.origin,
    credentials: { type: 'webhook', url: url.href, secret: value.secret },
  };
}
export function normalizeAlertChannel(
  input: unknown,
  trusted: ReadonlySet<string> = new Set(),
): NormalizedAlertChannel {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Provide a channel configuration.');
  const { name, enabled, ...credentials } = input as Record<string, unknown>;
  return {
    name: alertChannelName(name),
    enabled: alertChannelEnabled(enabled),
    ...normalizeAlertCredentials(credentials, trusted),
  };
}
