'use client';
import { useEffect, useId, useRef, useState } from 'react';
import useSWR from 'swr';
import { X } from 'lucide-react';
import {
  LOG_REDACTED_FIELDS,
  type LogRedactedField,
  type LogPrivacyPolicy,
  type LogExportCadence,
  type LogExportDestination,
  type LogExportDeliveryState,
  type LogExportDeliveryHistory,
} from '@api-gateway/shared-types';
import {
  getLogExportDelivery,
  getLogExportDeliveryHistory,
  saveLogExportDelivery,
  removeLogExportDelivery,
} from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';
import { DataLoadNotice } from './data-load-notice';

const control =
  'mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-600';
const button =
  'rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 disabled:opacity-60';
const fields: Record<LogRedactedField, string> = {
  path: 'Request paths',
  downstreamService: 'Service names',
  requestId: 'Request IDs',
  consumerId: 'Consumer IDs',
  traceId: 'Trace IDs',
  spanId: 'Span IDs',
};
const outcomes = {
  queued: 'Queued',
  processing: 'Sending',
  delivered: 'Acknowledged',
  failed: 'Failed',
  expired: 'Expired',
};
const errors: Record<string, string> = {
  queue_full: 'Waiting for queue space.',
  history_busy: 'Waiting for history cleanup.',
  filter_unavailable: 'A filter uses metadata omitted by your workspace.',
  credentials_unavailable: 'Restore or replace the saved credentials.',
  policy_changed: 'Cancelled after a privacy or retention change.',
  destination_changed: 'Cancelled after a destination change.',
  schedule_removed: 'Cancelled when automatic delivery was removed.',
  retention_expired: 'The source records expired.',
  attempts_exhausted: 'The retry limit was reached.',
  http_client_error: 'The provider rejected the request.',
  http_retryable: 'The provider temporarily rejected the request.',
  timeout: 'The provider did not respond in time.',
  cancelled: 'Delivery was interrupted; eligible batches retry.',
};
const errorMessage = (value: unknown) =>
  value instanceof Error
    ? value.message
    : 'Delivery settings could not be saved. Try again.';

export function ExportDeliveryDialog({
  tenantId,
  row,
  onClose,
  onSaved,
}: {
  tenantId: string;
  row: LogExportDestination;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const stateRead = useRef<AbortController | null>(null),
    historyRead = useRef<AbortController | null>(null);
  const [openedState, setOpenedState] = useState<LogExportDeliveryState | null>(
    null,
  );
  const [openedError, setOpenedError] = useState<unknown>(null);
  useEffect(
    () => () => {
      stateRead.current?.abort();
      historyRead.current?.abort();
    },
    [],
  );
  function signal(ref: typeof stateRead) {
    ref.current?.abort();
    const controller = new AbortController();
    ref.current = controller;
    return AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  }
  const state = useSWR(
    ['export-delivery', tenantId, row.id],
    async () => {
      const ownedSignal = signal(stateRead);
      const ownedController = stateRead.current;
      try {
        const current = await getLogExportDelivery(
          tenantId,
          row.id,
          ownedSignal,
        );
        if (!ownedSignal.aborted) {
          setOpenedState(current);
          setOpenedError(null);
        }
        return current;
      } catch (error) {
        if (ownedController && !ownedController.signal.aborted)
          setOpenedError(error);
        throw error;
      }
    },
    { refreshInterval: 30000, revalidateOnMount: true, dedupingInterval: 0 },
  );
  const history = useSWR(
    ['export-delivery-history', tenantId, row.id],
    () => getLogExportDeliveryHistory(tenantId, row.id, signal(historyRead)),
    { refreshInterval: 30000 },
  );
  // Mount editable controls only from this dialog's completed read, never a
  // cached revision. Later reads update metadata without resetting selections.
  return (
    <WorkspaceDialog
      label={`Delivery and history for ${row.name}`}
      onClose={onClose}
    >
      <div className="flex h-full w-full max-w-[600px] flex-col bg-[#fffdf8] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-6 py-5">
          <h2 className="text-lg font-semibold text-slate-900">
            Delivery and history · {row.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close delivery settings"
            className={button}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto space-y-6 px-6 py-5">
          {!!openedError && (
            <DataLoadNotice
              label="Delivery settings"
              onRetry={() => state.mutate()}
            />
          )}
          {!openedState && !openedError && (
            <p role="status" className="text-sm text-slate-600">
              Loading delivery settings…
            </p>
          )}
          {openedState && (
            <DeliveryEditor
              tenantId={tenantId}
              row={row}
              initial={openedState}
              readFailed={!!openedError}
              reload={() => state.mutate()}
              onSaved={onSaved}
            />
          )}
          <section
            aria-label="External delivery history"
            className="space-y-3 border-t border-slate-200 pt-5"
          >
            <h3 className="font-semibold text-slate-900">Delivery history</h3>
            {history.error && (
              <DataLoadNotice
                label="Delivery history"
                onRetry={() => history.mutate()}
              />
            )}
            {!history.data && !history.error && (
              <p role="status" className="text-sm text-slate-600">
                Loading delivery history…
              </p>
            )}
            {history.data && <DeliveryHistory data={history.data} />}
          </section>
        </div>
      </div>
    </WorkspaceDialog>
  );
}

function DeliveryEditor({
  tenantId,
  row,
  initial,
  readFailed,
  reload,
  onSaved,
}: {
  tenantId: string;
  row: LogExportDestination;
  initial: LogExportDeliveryState;
  readFailed: boolean;
  reload: () => Promise<LogExportDeliveryState | undefined>;
  onSaved: (message: string) => void;
}) {
  const id = useId();
  const [base, setBase] = useState(initial),
    [enabled, setEnabled] = useState(initial.schedule?.enabled ?? false),
    [cadence, setCadence] = useState<LogExportCadence>(
      initial.schedule?.cadence ?? 'near_real_time',
    );
  const [status, setStatus] = useState(
      initial.schedule?.filter.minStatusCode?.toString() ?? '',
    ),
    [prefix, setPrefix] = useState(initial.schedule?.filter.pathPrefix ?? ''),
    [consumer, setConsumer] = useState(
      initial.schedule?.filter.consumerId ?? '',
    );
  const [privacy, setPrivacy] = useState<LogPrivacyPolicy>(
    initial.schedule?.payloadPrivacy ?? { clientIp: 'omit', userAgent: 'omit' },
  );
  const [busy, setBusy] = useState(false),
    [reloading, setReloading] = useState(false),
    [removing, setRemoving] = useState(false),
    [failure, setFailure] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function refresh() {
    if (pending.current || reloading) return;
    setReloading(true);
    setFailure('');
    try {
      const current = await reload();
      if (current) {
        setBase(current);
        setNotice('Latest revisions loaded. Your selections are kept.');
      }
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setReloading(false);
    }
  }
  async function submit(event: React.FormEvent, remove = false) {
    event.preventDefault();
    if (pending.current || reloading) return;
    if (enabled && !initial.available && !remove) {
      setFailure(
        'Restore access to the saved credentials before enabling delivery.',
      );
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure('');
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    try {
      if (remove) {
        if (!base.schedule) return;
        await removeLogExportDelivery(
          tenantId,
          row.id,
          {
            expectedRevision: base.schedule.revision,
            expectedDestinationRevision: base.destinationRevision,
          },
          signal,
        );
      } else
        await saveLogExportDelivery(
          tenantId,
          row.id,
          {
            enabled,
            cadence,
            filter: {
              ...(status !== '' ? { minStatusCode: Number(status) } : {}),
              ...(prefix ? { pathPrefix: prefix } : {}),
              ...(consumer ? { consumerId: consumer.trim() } : {}),
            },
            payloadPrivacy: privacy,
            expectedRevision: base.schedule?.revision ?? null,
            expectedDestinationRevision: base.destinationRevision,
          },
          signal,
        );
      if (!controller.signal.aborted)
        onSaved(
          remove
            ? 'Automatic delivery removed. Waiting batches were cancelled; history is retained.'
            : enabled
              ? 'Automatic delivery enabled. Future receipts and retained backlog will be processed.'
              : 'Automatic delivery paused. Already queued batches can finish.',
        );
    } catch (error) {
      if (!controller.signal.aborted) setFailure(errorMessage(error));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const hidden = initial.tenantPrivacy.redactedFields ?? [];
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-950">
        <p>
          {base.schedule
            ? `Incoming logs are ${base.schedule.enabled ? 'enabled for automatic delivery' : 'paused'}.`
            : 'No automatic delivery is configured. Your first window starts when you save; earlier logs are not backfilled.'}
        </p>
        <p className="mt-2">
          Windows use the time NovaGate receives each log and wait{' '}
          {initial.limits.settlementSeconds} seconds after closing.
          Acknowledgement confirms an accepted request; provider indexing and
          receiver deduplication are separate.
        </p>
      </div>
      {!initial.available && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Saved credentials are unavailable. Restore or replace them before
          enabling delivery. Pause and removal remain available.
        </p>
      )}
      <label className="flex items-center gap-3 text-sm font-medium text-slate-900">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || (!initial.available && !enabled)}
          onChange={(event) => setEnabled(event.target.checked)}
          className="h-4 w-4"
        />
        Enable automatic delivery
      </label>
      <div>
        <label
          htmlFor={`${id}-cadence`}
          className="block text-sm font-medium text-slate-800"
        >
          Delivery cadence
        </label>
        <select
          id={`${id}-cadence`}
          value={cadence}
          disabled={busy}
          className={control}
          onChange={(event) =>
            setCadence(event.target.value as LogExportCadence)
          }
        >
          <option value="near_real_time">Every minute · near real time</option>
          <option value="hourly">Hourly · UTC boundaries</option>
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label
          htmlFor={`${id}-status`}
          className="text-sm font-medium text-slate-800"
        >
          Minimum status code
          <input
            id={`${id}-status`}
            type="number"
            min={100}
            max={599}
            value={status}
            disabled={busy}
            placeholder="All statuses"
            className={control}
            onChange={(event) => setStatus(event.target.value)}
          />
        </label>
        <label
          htmlFor={`${id}-consumer`}
          className="text-sm font-medium text-slate-800"
        >
          Consumer ID (optional)
          <input
            id={`${id}-consumer`}
            value={consumer}
            maxLength={36}
            disabled={busy}
            className={control}
            onChange={(event) => setConsumer(event.target.value)}
          />
        </label>
      </div>
      <label
        htmlFor={`${id}-prefix`}
        className="block text-sm font-medium text-slate-800"
      >
        Literal path prefix (optional)
        <input
          id={`${id}-prefix`}
          value={prefix}
          maxLength={512}
          disabled={busy}
          placeholder="/api/"
          className={control}
          onChange={(event) => setPrefix(event.target.value)}
        />
      </label>
      {(hidden.includes('path') || hidden.includes('consumerId')) && (
        <p className="text-sm text-amber-900">
          Your workspace omits{' '}
          {hidden
            .filter((field) => field === 'path' || field === 'consumerId')
            .map((field) => fields[field])
            .join(' and ')}
          . Clear filters using those fields before enabling delivery.
        </p>
      )}
      <fieldset
        disabled={busy}
        className="space-y-3 rounded-xl border border-slate-200 p-4"
      >
        <legend className="px-1 text-sm font-semibold text-slate-900">
          Payload privacy
        </legend>
        <p className="text-sm text-slate-600">
          Workspace omissions always apply. This destination can omit more
          fields. Changing this policy cancels queued batches containing the
          previous projection.
        </p>
        {(['clientIp', 'userAgent'] as const).map((field) => (
          <div key={field}>
            <label
              htmlFor={`${id}-${field}`}
              className="block text-sm font-medium text-slate-800"
            >
              {field === 'clientIp' ? 'Client IP addresses' : 'User agents'}
            </label>
            <select
              id={`${id}-${field}`}
              value={privacy[field]}
              className={control}
              onChange={(event) =>
                setPrivacy({ ...privacy, [field]: event.target.value })
              }
            >
              <option value="omit">Omit</option>
              <option value="retain">Retain when the workspace retains</option>
            </select>
          </div>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          {LOG_REDACTED_FIELDS.map((field) => (
            <label
              key={field}
              className="flex items-center gap-2 text-sm text-slate-800"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={privacy.redactedFields?.includes(field) ?? false}
                onChange={(event) =>
                  setPrivacy({
                    ...privacy,
                    redactedFields: event.target.checked
                      ? [...(privacy.redactedFields ?? []), field]
                      : (privacy.redactedFields ?? []).filter(
                          (current) => current !== field,
                        ),
                  })
                }
              />
              Omit {fields[field].toLowerCase()}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-slate-600">
        {initial.pendingBatches} pending batches · {initial.processingBatches}{' '}
        sending · limit {initial.limits.pendingBatches}. Receipts are retained
        for {initial.retentionDays} days. Pending payloads expire within{' '}
        {initial.limits.payloadLifetimeHours} hours or sooner when their source
        expires; delivery allows up to {initial.limits.maxAttempts} attempts.
      </p>
      {initial.schedule && (
        <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            Admitted records:{' '}
            {initial.schedule.admittedRecords.toLocaleString()} · filtered:{' '}
            {initial.schedule.filteredRecords.toLocaleString()} · invalid:{' '}
            {initial.schedule.invalidRecords.toLocaleString()}
          </p>
          <p className="mt-1">
            Receipt cursor: {new Date(initial.schedule.cursor).toLocaleString()}
          </p>
          {initial.schedule.retentionSkippedSeconds > 0 && (
            <p className="mt-1 text-amber-900">
              Retention removed{' '}
              {initial.schedule.retentionSkippedSeconds.toLocaleString()}{' '}
              seconds of unprocessed receipt coverage. The number of lost
              records is unknown.
            </p>
          )}
          {initial.schedule.error && (
            <p className="mt-1 text-amber-900">
              {errors[initial.schedule.error] ??
                'Delivery needs attention; eligible work will retry.'}
            </p>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-indigo-800">
          {notice}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-red-800">
          {failure}
        </p>
      )}
      {removing && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Remove automatic delivery and cancel its waiting batches? History
          stays available. Recreating starts a new receipt window. Previously
          delivered external copies cannot be recalled.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={
            busy || reloading || readFailed || (enabled && !initial.available)
          }
          className="rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save delivery settings'}
        </button>
        <button
          type="button"
          disabled={busy || reloading}
          onClick={() => void refresh()}
          className={button}
        >
          {reloading ? 'Reloading…' : 'Reload delivery revisions'}
        </button>
        {base.schedule &&
          (removing ? (
            <>
              <button
                type="button"
                disabled={busy || reloading || readFailed}
                onClick={(event) => void submit(event, true)}
                className={button}
              >
                Confirm remove automatic delivery
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRemoving(false)}
                className={button}
              >
                Keep automatic delivery
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || reloading}
              onClick={() => setRemoving(true)}
              className={button}
            >
              Remove automatic delivery
            </button>
          ))}
      </div>
    </form>
  );
}

function DeliveryHistory({ data }: { data: LogExportDeliveryHistory }) {
  const coverage = data.coverage;
  return (
    <>
      <p className="text-sm text-slate-600">
        Showing up to {coverage.readLimit} recent batches. Scheduled history
        retains up to {coverage.scheduledTerminalLimit.toLocaleString()}{' '}
        completed batches per workspace and no longer than{' '}
        {coverage.retentionHours / 24} days. It may roll off sooner.
      </p>
      <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
        <p>
          Removed scheduled outcomes across this workspace:{' '}
          {coverage.prunedScheduledBatches.delivered} acknowledged ·{' '}
          {coverage.prunedScheduledBatches.failed} failed ·{' '}
          {coverage.prunedScheduledBatches.expired} expired.
        </p>
        <p className="mt-1">
          Removed record occurrences:{' '}
          {coverage.prunedScheduledRecords.delivered} acknowledged ·{' '}
          {coverage.prunedScheduledRecords.failed} failed ·{' '}
          {coverage.prunedScheduledRecords.expired} expired. Records exported to
          different destinations count separately.
        </p>
      </div>
      {data.deliveries.length === 0 ? (
        <p className="text-sm text-slate-600">No delivery batches yet.</p>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label="Recent delivery batches"
          className="overflow-x-auto rounded-xl border border-slate-200"
        >
          <table className="w-full text-left text-sm text-slate-700">
            <thead className="bg-slate-50">
              <tr>
                {['Created', 'Outcome', 'Records', 'Attempts'].map((label) => (
                  <th key={label} className="px-3 py-2 font-medium" scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((row) => (
                <tr key={row.id} className="border-t border-slate-200">
                  <td className="px-3 py-3">
                    <time dateTime={row.createdAt}>
                      {new Date(row.createdAt).toLocaleString()}
                    </time>
                    <p className="mt-1 text-xs text-slate-600">
                      {row.source === 'scheduled'
                        ? 'Automatic'
                        : 'Selected records'}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    {outcomes[row.status]}
                    {row.error && (
                      <p className="mt-1 text-xs text-slate-600">
                        {errors[row.error] ?? 'Delivery could not complete.'}
                      </p>
                    )}
                    {row.status === 'queued' && (
                      <p className="mt-1 text-xs text-slate-600">
                        Next eligible attempt:{' '}
                        {new Date(row.nextAttemptAt).toLocaleString()}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3">{row.recordCount}</td>
                  <td className="px-3 py-3">{row.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
