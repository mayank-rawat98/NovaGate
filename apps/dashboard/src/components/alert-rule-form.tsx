'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  AlertRule,
  AlertConfiguration,
  AlertMetric,
  AlertOperator,
  CreateAlertRuleDto,
} from '@api-gateway/shared-types';
import { createAlertRule, updateAlertRule } from '../lib/api-client';
import { WorkspaceDialog } from './workspace-dialog';

export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  error_rate: 'Error rate',
  downstream_timeout_rate: 'Downstream timeout rate',
  p95_latency_ms: 'p95 latency',
  rps: 'Requests per second',
};
export function isRateMetric(metric: AlertMetric) {
  return metric === 'error_rate' || metric === 'downstream_timeout_rate';
}
export function alertValue(metric: AlertMetric, value: number) {
  return isRateMetric(metric)
    ? `${Number((value * 100).toFixed(2))}%`
    : `${Number(value.toFixed(2))}${metric === 'p95_latency_ms' ? ' ms' : ' req/s'}`;
}
const inputClass =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900';
export function AlertRuleForm({
  tenantId,
  rule,
  configuration,
  onSaved,
  onClose,
}: {
  tenantId: string;
  rule?: AlertRule;
  configuration: AlertConfiguration;
  onSaved: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const pending = useRef<AbortController | null>(null);
  const [name, setName] = useState(rule?.name ?? '');
  const [metric, setMetric] = useState<AlertMetric>(
    rule?.metric ?? 'error_rate',
  );
  const [operator, setOperator] = useState<AlertOperator>(
    rule?.operator ?? '>',
  );
  const [threshold, setThreshold] = useState(
    String(rule ? rule.threshold * (isRateMetric(rule.metric) ? 100 : 1) : 5),
  );
  const [windowMinutes, setWindow] = useState(String(rule?.windowMinutes ?? 1));
  const [minRequests, setMinRequests] = useState(
    String(rule?.minRequests ?? 20),
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [channelIds, setChannelIds] = useState(rule?.channelIds ?? []);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => () => pending.current?.abort(), []);
  function changeMetric(value: AlertMetric) {
    setMetric(value);
    setThreshold(
      isRateMetric(value) ? '5' : value === 'p95_latency_ms' ? '1000' : '1',
    );
    setMinRequests(value === 'rps' ? '0' : '20');
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure('');
    const numeric = Number(threshold);
    const window = Number(windowMinutes);
    const minimum = Number(minRequests);
    const maximum = isRateMetric(metric)
      ? 100
      : metric === 'p95_latency_ms'
        ? 3600000
        : 1000000000;
    if (
      !threshold.trim() ||
      !Number.isFinite(numeric) ||
      numeric < 0 ||
      numeric > maximum ||
      !windowMinutes.trim() ||
      !Number.isInteger(window) ||
      window < 1 ||
      window > 60 ||
      !minRequests.trim() ||
      !Number.isInteger(minimum) ||
      minimum < 0 ||
      minimum > 1000000 ||
      channelIds.length > 5
    ) {
      setFailure(
        'Choose a valid threshold, a 1–60 minute window and a whole request minimum.',
      );
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    const dto: CreateAlertRuleDto = {
      name: name.trim(),
      metric,
      operator,
      threshold: numeric / (isRateMetric(metric) ? 100 : 1),
      windowMinutes: window,
      minRequests: minimum,
      channelIds,
      enabled,
    };
    try {
      if (rule)
        await updateAlertRule(
          tenantId,
          rule.id,
          { ...dto, revision: rule.revision },
          controller.signal,
        );
      else await createAlertRule(tenantId, dto, controller.signal);
      if (!controller.signal.aborted) {
        onSaved();
        onClose();
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setFailure(
          error instanceof Error
            ? error.message
            : 'Rule could not be saved. Refresh before trying again.',
        );
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  return (
    <WorkspaceDialog
      label={rule ? 'Edit alert rule' : 'Create alert rule'}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {rule ? 'Edit alert rule' : 'Create alert rule'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Choose when NovaGate should get your attention.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close rule form"
            onClick={onClose}
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
              Rule name
            </label>
            <input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              placeholder="e.g. Checkout error rate"
              className={inputClass}
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-metric`}
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              Metric
            </label>
            <select
              id={`${id}-metric`}
              value={metric}
              onChange={(e) => changeMetric(e.target.value as AlertMetric)}
              className={inputClass}
            >
              {Object.entries(ALERT_METRIC_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-600">
              HTTP completions. Errors include 4xx and 5xx; p95 is a histogram
              upper estimate.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor={`${id}-operator`}
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Condition
              </label>
              <select
                id={`${id}-operator`}
                value={operator}
                onChange={(e) => setOperator(e.target.value as AlertOperator)}
                className={inputClass}
              >
                <option value=">">Above</option>
                <option value=">=">At or above</option>
                <option value="<">Below</option>
                <option value="<=">At or below</option>
              </select>
            </div>
            <div>
              <label
                htmlFor={`${id}-threshold`}
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Threshold (
                {isRateMetric(metric)
                  ? '%'
                  : metric === 'p95_latency_ms'
                    ? 'ms'
                    : 'req/s'}
                )
              </label>
              <input
                id={`${id}-threshold`}
                type="number"
                min={0}
                max={
                  isRateMetric(metric)
                    ? 100
                    : metric === 'p95_latency_ms'
                      ? 3600000
                      : 1000000000
                }
                step="any"
                required
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor={`${id}-window`}
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Window (minutes)
              </label>
              <input
                id={`${id}-window`}
                type="number"
                min={1}
                max={60}
                step={1}
                required
                value={windowMinutes}
                onChange={(e) => setWindow(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label
                htmlFor={`${id}-minimum`}
                className="mb-1 block text-sm font-medium text-slate-700"
              >
                Minimum requests
              </label>
              <input
                id={`${id}-minimum`}
                type="number"
                min={0}
                max={1000000}
                step={1}
                required
                value={minRequests}
                onChange={(e) => setMinRequests(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-slate-600">
            At least 80% of the window needs recent reports. Missing reports or
            too few requests show “No data”, not healthy. A zero minimum is
            useful for low-traffic RPS rules.
          </p>
          <fieldset className="rounded-xl border border-slate-200 p-4">
            <legend className="px-1 text-sm font-medium text-slate-700">
              Send to
            </legend>
            <p className="mb-3 text-xs text-slate-600">
              Choose up to 5 channels. With none selected, events appear only in
              this dashboard.
            </p>
            {configuration.channels.length === 0 && (
              <p className="text-sm text-slate-600">
                Add a notification channel after saving this rule.
              </p>
            )}
            <div className="space-y-3">
              {configuration.channels.map((channel) => (
                <label
                  key={channel.id}
                  className="flex items-start gap-3 text-sm text-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={channelIds.includes(channel.id)}
                    disabled={
                      !channelIds.includes(channel.id) && channelIds.length >= 5
                    }
                    onChange={(e) =>
                      setChannelIds(
                        e.target.checked
                          ? [...channelIds, channel.id]
                          : channelIds.filter((value) => value !== channel.id),
                      )
                    }
                    className="mt-1 accent-indigo-600"
                  />
                  <span className="min-w-0 break-words">
                    {channel.name}
                    <span className="block text-xs text-slate-600">
                      {channel.type}
                      {!channel.enabled
                        ? ' · Paused'
                        : !configuration.deliveryAvailability[channel.type]
                          ? ' · Delivery unavailable'
                          : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-600"
            />
            Rule enabled
          </label>
          <p className="rounded-xl bg-indigo-50 p-3 text-xs leading-relaxed text-indigo-900">
            Firing notifications are limited to once every 5 minutes per rule.
            Verified recovery creates a resolved event. Saving an edit resets
            evaluation and cancels pending deliveries.
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
            disabled={saving}
            className="rounded-xl bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
          </button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
