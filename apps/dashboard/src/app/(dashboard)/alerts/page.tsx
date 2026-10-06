'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  Bell,
  Check,
  Activity,
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  X,
  ShieldCheck,
} from 'lucide-react';
import type {
  AlertRule,
  AlertChannel,
  AlertDeliveryState,
} from '@api-gateway/shared-types';
import {
  getAlertConfiguration,
  getAlertHistory,
  deleteAlertRule,
  deleteAlertChannel,
} from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import { WorkspaceDialog } from '../../../components/workspace-dialog';
import { DataLoadNotice } from '../../../components/data-load-notice';
import {
  AlertRuleForm,
  ALERT_METRIC_LABELS,
  alertValue,
} from '../../../components/alert-rule-form';
import { AlertChannelForm } from '../../../components/alert-channel-form';

type Dialog =
  | { kind: 'rule'; rule?: AlertRule }
  | { kind: 'channel'; channel?: AlertChannel }
  | { kind: 'delete-rule'; entry: AlertRule }
  | { kind: 'delete-channel'; entry: AlertChannel };
const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60';
function timestamp(value: string) {
  return new Date(value).toLocaleString();
}
function Badge({
  children,
  tone = 'slate',
}: {
  children: React.ReactNode;
  tone?: 'slate' | 'rose' | 'green' | 'amber';
}) {
  const colors = {
    slate: 'bg-slate-100 text-slate-700',
    rose: 'bg-rose-50 text-rose-800',
    green: 'bg-emerald-50 text-emerald-800',
    amber: 'bg-amber-50 text-amber-900',
  };
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${colors[tone]}`}
    >
      {children}
    </span>
  );
}
const DELIVERY_LABELS: Record<AlertDeliveryState, string> = {
  queued: 'Queued',
  processing: 'Sending',
  delivered: 'Accepted by destination',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export default function AlertsPage() {
  const tenantId = useTenantId();
  return tenantId ? (
    <AlertsWorkspace key={tenantId} tenantId={tenantId} />
  ) : (
    <p className="p-6 text-sm text-slate-600">Loading workspace…</p>
  );
}
function AlertsWorkspace({ tenantId }: { tenantId: string }) {
  const configuration = useSWR(
    ['alerts', tenantId],
    () => getAlertConfiguration(tenantId),
    { refreshInterval: 30000 },
  );
  const history = useSWR(
    ['alert-history', tenantId],
    () => getAlertHistory(tenantId),
    { refreshInterval: 30000 },
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [deleting, setDeleting] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const data = configuration.data;
  function refresh() {
    void Promise.allSettled([configuration.mutate(), history.mutate()]);
  }
  function saved(message: string) {
    setNotice(message);
    setFailure('');
    refresh();
  }
  function closeDeletion() {
    pending.current?.abort();
    pending.current = null;
    setDeleting(false);
    setDialog(null);
    refresh();
  }
  async function remove() {
    if (!dialog || !('entry' in dialog)) return;
    const controller = new AbortController();
    pending.current = controller;
    setDeleting(true);
    setFailure('');
    try {
      if (dialog.kind === 'delete-rule')
        await deleteAlertRule(
          tenantId,
          dialog.entry.id,
          dialog.entry.revision,
          controller.signal,
        );
      else
        await deleteAlertChannel(
          tenantId,
          dialog.entry.id,
          dialog.entry.revision,
          controller.signal,
        );
      if (!controller.signal.aborted) {
        setDialog(null);
        saved('Deleted. Previous event history is preserved.');
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Delete failed. Refresh and try again.',
        );
    } finally {
      if (!controller.signal.aborted) setDeleting(false);
    }
  }
  const rules =
    data?.rules.filter((rule) =>
      rule.name.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  const firing =
    data?.rules.filter(
      (rule) => rule.enabled && rule.evaluation?.state === 'firing',
    ).length ?? 0;
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <header className="nova-overview-hero">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-indigo-800">
            Observability
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
            Alerts
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-700">
            Know when traffic needs your attention. Set a clear condition,
            choose your team’s channels, and follow every delivery.
          </p>
          <p className="mt-3 text-xs text-slate-600">
            Evaluated every 15 seconds when reports are available. This page
            refreshes every 30 seconds.
          </p>
        </div>
        <div className="nova-hero-art hidden sm:block" aria-hidden="true">
          <div className="nova-clay-orb">
            <Bell size={32} />
          </div>
          <div className="nova-clay-orb">
            <Check size={24} />
          </div>
          <div className="nova-clay-orb" />
        </div>
      </header>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          {data
            ? `${data.rules.length} rules · ${data.channels.length} channels · ${firing} last evaluated as firing`
            : 'Loading your alert configuration…'}
        </p>
        <button type="button" onClick={refresh} className={buttonClass}>
          <RefreshCw size={16} aria-hidden="true" />
          Refresh alerts
        </button>
      </div>
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}
      {failure && !dialog && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {failure}
        </p>
      )}
      {configuration.error && (
        <DataLoadNotice
          label="Alert configuration"
          onRetry={() => configuration.mutate()}
        />
      )}
      {data && configuration.error && (
        <p className="mb-4 text-xs text-amber-900">
          Showing the last loaded configuration. Refresh before editing if
          another teammate changed it.
        </p>
      )}
      {data && !data.deliveryEnabled && (
        <p className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Notification delivery is unavailable for this installation. Your
          administrator can enable it. Rules can still record events in this
          dashboard.
        </p>
      )}
      {data?.deliveryEnabled && !data.deliveryAvailability.email && (
        <p className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Email delivery is unavailable. Webhook and Slack channels are ready to
          configure.
        </p>
      )}
      {data && (
        <>
          <section
            aria-labelledby="alert-rules-title"
            className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2
                  id="alert-rules-title"
                  className="text-lg font-semibold text-slate-900"
                >
                  Alert rules
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Healthy recovery and missing data stay distinct.
                </p>
              </div>
              <button
                type="button"
                disabled={data.rules.length >= 100}
                onClick={() => {
                  setFailure('');
                  setDialog({ kind: 'rule' });
                }}
                className={buttonClass}
              >
                <Plus size={16} aria-hidden="true" />
                Add rule
              </button>
            </div>
            {data.rules.length >= 100 && (
              <p className="mb-3 text-xs text-slate-600">
                Rule limit reached (100). Edit or remove a rule to add another.
              </p>
            )}
            {data.rules.length > 0 && (
              <div className="mb-4">
                <label
                  htmlFor="alert-rule-search"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Find a rule
                </label>
                <input
                  id="alert-rule-search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  type="search"
                  maxLength={100}
                  placeholder="Search by name"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm sm:max-w-sm"
                />
              </div>
            )}
            {!rules.length && (
              <div className="rounded-xl bg-slate-50 p-6 text-sm text-slate-600">
                {data.rules.length
                  ? 'No rules match your search.'
                  : 'Start with a rule such as error rate above 5% over one minute. Add a channel whenever your team is ready.'}
              </div>
            )}
            <div className="space-y-3">
              {rules.map((rule) => {
                const stale =
                  rule.evaluation &&
                  Date.now() - Date.parse(rule.evaluation.evaluatedAt) > 45000;
                const state = !rule.enabled
                  ? 'Paused'
                  : stale
                    ? 'Evaluation stale'
                    : !rule.evaluation
                      ? 'Waiting for data'
                      : rule.evaluation.state === 'no_data'
                        ? 'No data'
                        : rule.evaluation.state === 'firing'
                          ? 'Firing'
                          : 'Healthy';
                const cooldown =
                  rule.cooldownUntil &&
                  Date.parse(rule.cooldownUntil) > Date.now();
                return (
                  <article
                    key={rule.id}
                    className="rounded-xl border border-slate-200 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words font-semibold text-slate-900">
                          {rule.name}
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          {ALERT_METRIC_LABELS[rule.metric]} {rule.operator}{' '}
                          {alertValue(rule.metric, rule.threshold)} ·{' '}
                          {rule.windowMinutes} min · minimum {rule.minRequests}{' '}
                          requests
                        </p>
                      </div>
                      <Badge
                        tone={
                          state === 'Firing'
                            ? 'rose'
                            : state === 'Healthy'
                              ? 'green'
                              : state === 'No data' || stale
                                ? 'amber'
                                : 'slate'
                        }
                      >
                        {state}
                      </Badge>
                    </div>
                    {rule.evaluation && (
                      <p className="mt-3 text-xs text-slate-600">
                        Observed:{' '}
                        {rule.evaluation.value === null
                          ? 'Unavailable'
                          : alertValue(rule.metric, rule.evaluation.value)}{' '}
                        · {rule.evaluation.requestCount} requests ·{' '}
                        {Math.round(rule.evaluation.coverage * 100)}% report
                        coverage · Evaluated{' '}
                        {timestamp(rule.evaluation.evaluatedAt)}
                      </p>
                    )}
                    {rule.evaluation?.state === 'no_data' && (
                      <p className="mt-2 text-xs text-amber-900">
                        Needs recent reports covering at least 80% of the window
                        and the request minimum.
                        {rule.notifiedState === 'firing'
                          ? ' The last notified state is firing; recovery has not been verified.'
                          : ''}
                      </p>
                    )}
                    {cooldown && (
                      <p className="mt-2 text-xs text-indigo-800">
                        Firing cooldown ends{' '}
                        {timestamp(rule.cooldownUntil as string)}. Verified
                        recovery can notify sooner.
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <p className="min-w-0 break-words text-xs text-slate-600">
                        {rule.channelIds.length
                          ? `Channels: ${rule.channelIds.map((channelId) => data.channels.find((channel) => channel.id === channelId)?.name ?? 'Removed channel').join(', ')}`
                          : 'Dashboard history only'}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          aria-label={`Edit rule ${rule.name}`}
                          onClick={() => {
                            setFailure('');
                            setDialog({ kind: 'rule', rule });
                          }}
                          className={buttonClass}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete rule ${rule.name}`}
                          onClick={() => {
                            setFailure('');
                            setDialog({ kind: 'delete-rule', entry: rule });
                          }}
                          className={buttonClass}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
          <section
            aria-labelledby="alert-channels-title"
            className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2
                  id="alert-channels-title"
                  className="text-lg font-semibold text-slate-900"
                >
                  Notification channels
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Secret credentials stay private after saving.
                </p>
              </div>
              <button
                type="button"
                disabled={!data.deliveryEnabled || data.channels.length >= 16}
                onClick={() => {
                  setFailure('');
                  setDialog({ kind: 'channel' });
                }}
                className={buttonClass}
              >
                <Plus size={16} aria-hidden="true" />
                Add channel
              </button>
            </div>
            {data.channels.length >= 16 && (
              <p className="mb-3 text-xs text-slate-600">
                Channel limit reached (16). Edit or remove a channel to add
                another.
              </p>
            )}
            {!data.channels.length && (
              <p className="rounded-xl bg-slate-50 p-6 text-sm text-slate-600">
                No channels yet. Add a signed webhook, Slack destination or
                email recipient.
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {data.channels.map((channel) => (
                <article
                  key={channel.id}
                  className="min-w-0 rounded-xl border border-slate-200 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="break-words font-semibold text-slate-900">
                      {channel.name}
                    </h3>
                    <Badge
                      tone={
                        channel.enabled &&
                        data.deliveryAvailability[channel.type]
                          ? 'green'
                          : 'slate'
                      }
                    >
                      {!channel.enabled
                        ? 'Paused'
                        : data.deliveryAvailability[channel.type]
                          ? 'Enabled'
                          : 'Unavailable'}
                    </Badge>
                  </div>
                  <p className="mt-2 break-all text-sm text-slate-600">
                    {channel.type} · {channel.destination}
                  </p>
                  <p className="mt-2 flex items-center gap-1 text-xs text-slate-600">
                    <ShieldCheck size={14} aria-hidden="true" />
                    {channel.hasSecret
                      ? 'Saved credentials are hidden'
                      : 'Email recipient'}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      aria-label={`Edit channel ${channel.name}`}
                      onClick={() => {
                        setFailure('');
                        setDialog({ kind: 'channel', channel });
                      }}
                      className={buttonClass}
                    >
                      <Pencil size={14} aria-hidden="true" />
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete channel ${channel.name}`}
                      onClick={() => {
                        setFailure('');
                        setDialog({ kind: 'delete-channel', entry: channel });
                      }}
                      className={buttonClass}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
      <section
        aria-labelledby="alert-history-title"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
      >
        <h2
          id="alert-history-title"
          className="flex items-center gap-2 text-lg font-semibold text-slate-900"
        >
          <Activity size={18} aria-hidden="true" />
          Recent activity
        </h2>
        <p className="mb-4 mt-1 text-sm text-slate-600">
          Latest 100 events from the last 30 days. “Accepted” means the
          destination accepted the request; email inbox receipt is separate.
        </p>
        {history.error && (
          <DataLoadNotice
            label="Alert history"
            onRetry={() => history.mutate()}
          />
        )}
        {!history.data && !history.error && (
          <p className="text-sm text-slate-600">Loading recent activity…</p>
        )}
        {history.data?.length === 0 && (
          <p className="rounded-xl bg-slate-50 p-6 text-sm text-slate-600">
            No alert events yet. Events appear after a rule fires or verifies
            recovery.
          </p>
        )}
        <div className="space-y-3">
          {history.data?.map((event) => (
            <article
              key={event.id}
              className="rounded-xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="break-words font-semibold text-slate-900">
                  {event.ruleName}
                </h3>
                <Badge tone={event.state === 'firing' ? 'rose' : 'green'}>
                  {event.state === 'firing' ? 'Firing event' : 'Resolved event'}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-slate-600">
                {timestamp(event.createdAt)} ·{' '}
                {ALERT_METRIC_LABELS[event.metric]}:{' '}
                {alertValue(event.metric, event.value)}
              </p>
              {!event.deliveries.length && (
                <p className="mt-3 text-sm text-slate-600">
                  Dashboard history only — no enabled channel was selected.
                </p>
              )}
              <ul className="mt-3 space-y-3">
                {event.deliveries.map((delivery) => (
                  <li key={delivery.id} className="rounded-lg bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words text-sm text-slate-700">
                        {delivery.channelName} · {delivery.type}
                      </span>
                      <Badge
                        tone={
                          delivery.status === 'failed'
                            ? 'rose'
                            : delivery.status === 'delivered'
                              ? 'green'
                              : 'slate'
                        }
                      >
                        {DELIVERY_LABELS[delivery.status]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      {delivery.attempts} of 3 attempts
                      {delivery.nextAttemptAt
                        ? ` · Next attempt ${timestamp(delivery.nextAttemptAt)}`
                        : ''}
                    </p>
                    {delivery.lastError && (
                      <p className="mt-1 break-words text-xs text-rose-800">
                        {delivery.lastError}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
      {data && dialog?.kind === 'rule' && (
        <AlertRuleForm
          tenantId={tenantId}
          rule={dialog.rule}
          configuration={data}
          onClose={() => setDialog(null)}
          onSaved={() =>
            saved('Rule saved. Evaluation will use fresh reports.')
          }
        />
      )}
      {data && dialog?.kind === 'channel' && (
        <AlertChannelForm
          tenantId={tenantId}
          channel={dialog.channel}
          configuration={data}
          onClose={() => setDialog(null)}
          onSaved={() =>
            saved(
              'Channel saved. Select it in the rules that should notify it.',
            )
          }
        />
      )}
      {dialog && 'entry' in dialog && (
        <WorkspaceDialog
          label="Confirm alert deletion"
          centered
          onClose={closeDeletion}
        >
          <div className="p-6">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                Delete {dialog.kind === 'delete-rule' ? 'rule' : 'channel'}?
              </h2>
              <button
                type="button"
                aria-label="Close delete confirmation"
                onClick={closeDeletion}
                className="p-2 text-slate-600"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="mt-3 break-words text-sm text-slate-700">
              {dialog.entry.name}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Pending deliveries are cancelled. Previous event history stays
              available.
              {dialog.kind === 'delete-channel'
                ? ' This channel is removed from any rules that selected it.'
                : ''}
            </p>
            {failure && (
              <p
                role="alert"
                className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800"
              >
                {failure}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeDeletion}
                className={buttonClass}
              >
                Keep it
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void remove()}
                className="rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}
