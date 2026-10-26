'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Upload, X } from 'lucide-react';
import {
  DECLARATIVE_CONFIG_MAX_BYTES,
  type ConfigPreview,
  type ConfigApplyResult,
} from '@api-gateway/shared-types';
import {
  exportConfiguration,
  previewConfiguration,
  applyConfiguration,
} from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';

const button =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50';
const primary =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';

export function ConfigImportPanel({ tenantId }: { tenantId: string }) {
  return <WorkspaceConfigPanel key={tenantId} tenantId={tenantId} />;
}
function WorkspaceConfigPanel({ tenantId }: { tenantId: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function download() {
    if (exporting || !tenantId) return;
    controller.current?.abort();
    const admitted = new AbortController();
    controller.current = admitted;
    setExporting(true);
    setError(undefined);
    try {
      const source = await exportConfiguration(
        tenantId,
        AbortSignal.any([admitted.signal, AbortSignal.timeout(15000)]),
      );
      if (admitted.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([source], { type: 'application/yaml' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'novagate-config.yaml';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!admitted.signal.aborted)
        setError(
          error instanceof Error ? error.message : 'Export failed. Try again.',
        );
    } finally {
      if (!admitted.signal.aborted) setExporting(false);
    }
  }
  return (
    <section
      aria-label="Configuration import and export"
      className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-gray-900">
        Configuration import & export
      </h2>
      <p className="mt-2 text-sm text-gray-600">
        Manage services, routes and consumers in one YAML or JSON document.
        Review changes before applying them.
      </p>
      <p className="mt-2 text-xs text-gray-500">
        Exports omit consumer keys and saved authentication credentials. Import
        supports up to 200 entries and 64 KiB.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className={button}
          disabled={!tenantId || exporting}
          onClick={download}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {exporting ? 'Exporting…' : 'Export configuration'}
        </button>
        <button
          type="button"
          className={button}
          disabled={!tenantId}
          ref={opener}
          onClick={() => setOpen(true)}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          Import configuration
        </button>
      </div>
      {open && (
        <ImportDialog
          tenantId={tenantId}
          onClose={() => {
            setOpen(false);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        />
      )}
    </section>
  );
}
function ImportDialog({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<ConfigPreview>();
  const [result, setResult] = useState<ConfigApplyResult>();
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function edit(value: string) {
    setSource(value);
    setPreview(undefined);
    setAcknowledged(false);
    setError(undefined);
  }
  async function check() {
    if (busy || !source.trim()) return;
    if (
      new TextEncoder().encode(source).byteLength > DECLARATIVE_CONFIG_MAX_BYTES
    ) {
      setError('Configuration exceeds 64 KiB. Reduce it before importing.');
      return;
    }
    controller.current?.abort();
    const admitted = new AbortController();
    controller.current = admitted;
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    setAcknowledged(false);
    try {
      const response = await previewConfiguration(
        tenantId,
        source,
        AbortSignal.any([admitted.signal, AbortSignal.timeout(15000)]),
      );
      if (!admitted.signal.aborted) setPreview(response);
    } catch (error) {
      if (!admitted.signal.aborted)
        setError(
          error instanceof Error ? error.message : 'Preview failed. Try again.',
        );
    } finally {
      if (!admitted.signal.aborted) setBusy(false);
    }
  }
  async function apply() {
    if (busy || !preview || !acknowledged) return;
    controller.current?.abort();
    const admitted = new AbortController();
    controller.current = admitted;
    setBusy(true);
    setError(undefined);
    try {
      const response = await applyConfiguration(
        tenantId,
        source,
        preview.revision,
        AbortSignal.any([admitted.signal, AbortSignal.timeout(15000)]),
      );
      if (!admitted.signal.aborted) setResult(response);
    } catch (error) {
      if (!admitted.signal.aborted) {
        setError(
          error instanceof Error
            ? error.message
            : 'Import could not be confirmed. Check the current configuration and preview again.',
        );
        setPreview(undefined);
        setAcknowledged(false);
      }
    } finally {
      if (!admitted.signal.aborted) setBusy(false);
    }
  }
  async function file(file: File | undefined) {
    if (!file) return;
    if (file.size > DECLARATIVE_CONFIG_MAX_BYTES) {
      setError('Configuration exceeds 64 KiB. Choose a smaller file.');
      return;
    }
    controller.current?.abort();
    const admitted = new AbortController();
    controller.current = admitted;
    setBusy(true);
    setError(undefined);
    try {
      const value = await file.text();
      if (!admitted.signal.aborted) edit(value);
    } catch {
      if (!admitted.signal.aborted)
        setError('File could not be read. Paste its contents instead.');
    } finally {
      if (!admitted.signal.aborted) setBusy(false);
    }
  }
  return (
    <WorkspaceDialog label="Import configuration" onClose={onClose}>
      <div className="flex h-full w-full min-w-0 max-w-3xl flex-col bg-[#fffdf8] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Import configuration
          </h2>
          <button
            type="button"
            aria-label="Close configuration import"
            className="rounded p-2 text-gray-500 hover:bg-gray-100"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto space-y-4 p-6">
          {result ? (
            <>
              <p role="status" className="text-sm text-gray-700">
                {result.changed === 0
                  ? 'Configuration already matches this document.'
                  : `${result.changed} changes saved. Gateway update queued.`}
              </p>
              {result.consumerKeys.length > 0 && (
                <>
                  <p className="text-sm font-medium text-amber-800">
                    Save these new consumer keys now. They cannot be viewed
                    again.
                  </p>
                  {result.consumerKeys.map((key) => (
                    <div
                      key={key.id}
                      className="rounded-lg border border-gray-200 p-3"
                    >
                      <label
                        htmlFor={`import-key-${key.id}`}
                        className="text-sm font-medium text-gray-900"
                      >
                        {key.name} API key
                      </label>
                      <input
                        id={`import-key-${key.id}`}
                        readOnly
                        value={key.apiKey}
                        className="mt-2 w-full rounded border border-gray-300 p-2 font-mono text-xs"
                      />
                    </div>
                  ))}
                </>
              )}
              <button type="button" className={primary} onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                This document replaces active services, routes and consumers.
                Missing entries will be deleted or revoked. Existing matching
                keys and omitted plugin credentials are preserved.
              </p>
              <div>
                <label
                  htmlFor="configuration-file"
                  className="block text-sm font-medium text-gray-900"
                >
                  Configuration file
                </label>
                <input
                  id="configuration-file"
                  type="file"
                  accept=".yaml,.yml,.json"
                  value=""
                  disabled={busy}
                  onChange={(event) => file(event.target.files?.[0])}
                  className="mt-2 block w-full text-sm text-gray-600"
                />
              </div>
              <div>
                <label
                  htmlFor="configuration-source"
                  className="block text-sm font-medium text-gray-900"
                >
                  YAML or JSON configuration
                </label>
                <textarea
                  id="configuration-source"
                  rows={12}
                  maxLength={DECLARATIVE_CONFIG_MAX_BYTES}
                  disabled={busy}
                  value={source}
                  onChange={(event) => edit(event.target.value)}
                  spellCheck={false}
                  className="mt-2 w-full rounded-lg border border-gray-300 p-3 font-mono text-xs text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              <button
                type="button"
                className={button}
                onClick={check}
                disabled={busy || !source.trim()}
              >
                {busy ? 'Working…' : 'Preview changes'}
              </button>
              {preview && (
                <section
                  aria-label="Configuration preview"
                  className="space-y-3"
                >
                  <h3 className="text-sm font-semibold text-gray-900">
                    {preview.changes.length} changes · {preview.unchanged}{' '}
                    unchanged
                  </h3>
                  <p className="text-xs text-gray-500">
                    Preview expires at{' '}
                    {new Date(preview.expiresAt).toLocaleTimeString()}. Changes
                    to the document or workspace require a new preview.
                  </p>
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label="Configuration changes"
                    className="overflow-x-auto rounded-lg border border-gray-200"
                  >
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-gray-50 text-gray-600">
                        <tr>
                          <th className="p-3">Action</th>
                          <th className="p-3">Entry</th>
                          <th className="p-3">Fields</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.changes.map((change, index) => (
                          <tr key={index} className="border-t border-gray-100">
                            <td className="p-3 font-medium text-gray-900">
                              {change.action === 'remove'
                                ? change.resource === 'consumer'
                                  ? 'Revoke'
                                  : 'Delete'
                                : change.action === 'create'
                                  ? 'Create'
                                  : 'Update'}
                            </td>
                            <td className="break-all p-3 text-gray-700">
                              {change.resource}: {change.key}
                            </td>
                            <td className="p-3 text-gray-600">
                              {change.fields.join(', ') || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={busy}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                      className="mt-1 rounded border-gray-300"
                    />
                    I reviewed these changes, including deletions and revoked
                    keys.
                  </label>
                  <button
                    type="button"
                    className={primary}
                    disabled={busy || !acknowledged}
                    onClick={apply}
                  >
                    Apply reviewed configuration
                  </button>
                </section>
              )}
              <p className="text-xs text-gray-500">
                Closing this window does not undo a submitted import. If a
                response is interrupted, check the current configuration before
                retrying. Documents and new keys stay in this window only.
              </p>
            </>
          )}
        </div>
      </div>
    </WorkspaceDialog>
  );
}
