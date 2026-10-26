'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type {
  AlertChannel,
  AlertChannelType,
  AlertConfiguration,
  CreateAlertChannelDto,
  UpdateAlertChannelDto,
} from '@api-gateway/shared-types';
import { createAlertChannel, updateAlertChannel } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
const inputClass =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900';
export function AlertChannelForm({
  tenantId,
  channel,
  configuration,
  onSaved,
  onClose,
}: {
  tenantId: string;
  channel?: AlertChannel;
  configuration: AlertConfiguration;
  onSaved: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const pending = useRef<AbortController | null>(null);
  const [name, setName] = useState(channel?.name ?? '');
  const [type, setType] = useState<AlertChannelType>(
    channel?.type ?? 'webhook',
  );
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [replace, setReplace] = useState(false);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [address, setAddress] = useState(
    channel?.type === 'email' ? channel.destination : '',
  );
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const writingCredentials = !channel || replace;
  useEffect(() => () => pending.current?.abort(), []);
  function clearSecrets() {
    setUrl('');
    setSecret('');
    setShow(false);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure('');
    let credentials:
      | NonNullable<UpdateAlertChannelDto['credentials']>
      | undefined;
    if (writingCredentials) {
      if (type === 'email') credentials = { type, address: address.trim() };
      else {
        try {
          const destination = new URL(url);
          if (
            !['http:', 'https:'].includes(destination.protocol) ||
            destination.username ||
            destination.password ||
            destination.hash
          )
            throw new Error();
        } catch {
          setFailure(
            'Enter a complete notification URL without credentials or a fragment.',
          );
          return;
        }
        if (
          type === 'webhook' &&
          (new TextEncoder().encode(secret).length < 32 ||
            new TextEncoder().encode(secret).length > 256)
        ) {
          setFailure('Use a signing secret between 32 and 256 bytes.');
          return;
        }
        credentials =
          type === 'webhook'
            ? { type, url, secret }
            : { type, webhookUrl: url };
      }
    }
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    try {
      if (channel)
        await updateAlertChannel(
          tenantId,
          channel.id,
          {
            name: name.trim(),
            enabled,
            revision: channel.revision,
            ...(credentials ? { credentials } : {}),
          },
          controller.signal,
        );
      else
        await createAlertChannel(
          tenantId,
          {
            name: name.trim(),
            enabled,
            ...credentials,
          } as CreateAlertChannelDto,
          controller.signal,
        );
      if (!controller.signal.aborted) {
        clearSecrets();
        onSaved();
        onClose();
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Channel could not be saved. Refresh before trying again.',
        );
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  return (
    <WorkspaceDialog
      label={
        channel ? 'Edit notification channel' : 'Create notification channel'
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {channel
                ? 'Edit notification channel'
                : 'Create notification channel'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              A destination for firing and resolved notifications.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close channel form"
            className="rounded-lg p-2 text-slate-600"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {failure && (
            <p
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
            >
              {failure}
            </p>
          )}
          <div>
            <label
              htmlFor={`${id}-name`}
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Channel name
            </label>
            <input
              id={`${id}-name`}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. On-call team"
              className={inputClass}
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-type`}
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Channel type
            </label>
            <select
              id={`${id}-type`}
              value={type}
              disabled={!!channel}
              onChange={(e) => {
                setType(e.target.value as AlertChannelType);
                clearSecrets();
                setAddress('');
              }}
              className={inputClass}
            >
              <option value="webhook">Signed webhook</option>
              <option value="slack">Slack</option>
              <option
                value="email"
                disabled={!configuration.deliveryAvailability.email && !channel}
              >
                Email
                {!configuration.deliveryAvailability.email
                  ? ' · Unavailable'
                  : ''}
              </option>
            </select>
            {channel && (
              <p className="mt-1 text-xs text-slate-600">
                Create a new channel to use a different type.
              </p>
            )}
          </div>
          {channel && (
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="break-all text-sm text-slate-700">
                Saved destination: {channel.destination}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Secret URLs and signing secrets are never displayed. Metadata
                edits preserve saved credentials.
              </p>
              <label className="mt-3 flex items-center gap-3 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={replace}
                  disabled={!configuration.deliveryEnabled}
                  onChange={(e) => {
                    setReplace(e.target.checked);
                    clearSecrets();
                  }}
                  className="accent-indigo-600"
                />
                Replace saved credentials
              </label>
            </div>
          )}
          {writingCredentials && type === 'email' && (
            <div>
              <label
                htmlFor={`${id}-address`}
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Recipient email
              </label>
              <input
                id={`${id}-address`}
                type="email"
                required
                maxLength={254}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                autoComplete="off"
                className={inputClass}
              />
            </div>
          )}
          {writingCredentials && type !== 'email' && (
            <>
              <div>
                <label
                  htmlFor={`${id}-url`}
                  className="mb-1 block text-sm font-medium text-slate-700"
                >
                  {type === 'webhook' ? 'Webhook URL' : 'Slack webhook URL'}
                </label>
                <input
                  id={`${id}-url`}
                  type={show ? 'text' : 'password'}
                  required
                  maxLength={2048}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-slate-600">
                  {type === 'webhook'
                    ? 'Use a public HTTPS receiver. Private destinations need administrator approval.'
                    : 'Use a Slack incoming webhook URL. It is a secret; do not share it.'}
                </p>
              </div>
              {type === 'webhook' && (
                <div>
                  <label
                    htmlFor={`${id}-secret`}
                    className="mb-1 block text-sm font-medium text-slate-700"
                  >
                    Signing secret
                  </label>
                  <input
                    id={`${id}-secret`}
                    type={show ? 'text' : 'password'}
                    required
                    maxLength={256}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-slate-600">
                    Use 32–256 bytes. Your receiver verifies NovaGate’s
                    signature with this secret.
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => setShow(!show)}
                aria-pressed={show}
                className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
              >
                {show ? (
                  <EyeOff size={16} aria-hidden="true" />
                ) : (
                  <Eye size={16} aria-hidden="true" />
                )}
                {show ? 'Hide credentials' : 'Show credentials'}
              </button>
            </>
          )}
          <label className="flex items-center gap-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-600"
            />
            Channel enabled
          </label>
          {!configuration.deliveryAvailability[type] && (
            <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              {type === 'email'
                ? 'Email delivery is unavailable. Ask your administrator to configure email sending.'
                : 'Notification delivery is unavailable. Ask your administrator to enable it.'}
            </p>
          )}
          <p className="text-xs leading-relaxed text-slate-600">
            Saving an edit cancels this channel’s pending deliveries. Requests
            already accepted by a receiver cannot be recalled. Delivery retries
            can produce duplicates; webhook receivers should deduplicate the
            delivery ID.
          </p>
        </div>
        <footer className="flex justify-end gap-3 border-t border-slate-200 p-6">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              saving || (!channel && !configuration.deliveryAvailability[type])
            }
            className="rounded-xl bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? 'Saving…' : channel ? 'Save channel' : 'Create channel'}
          </button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
