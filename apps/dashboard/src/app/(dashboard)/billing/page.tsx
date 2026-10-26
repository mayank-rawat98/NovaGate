'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { AlertTriangle, CreditCard, PauseCircle } from 'lucide-react';
import type {
  BillingOverview,
  Plan,
  UsageMeter,
} from '@api-gateway/shared-types';
import { getBilling, startCheckout } from '../../../lib/api-client';
import { useTenantId } from '../../../lib/auth';
import { DataLoadNotice } from '../../../components/data-load-notice';

const WARN_PERCENT = 80;
const CRITICAL_PERCENT = 98;

function formatDate(value: string) {
  return new Date(value).toLocaleDateString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
function limit(value: number | null, unit: string) {
  return value === null
    ? `Unlimited ${unit}`
    : `${value.toLocaleString()} ${unit}`;
}
function price(plan: Plan) {
  if (plan.priceMonthlyCents === null) return 'Custom pricing';
  if (plan.priceMonthlyCents === 0) return 'Free';
  return `$${(plan.priceMonthlyCents / 100).toLocaleString()} / month`;
}

export default function BillingPage() {
  const tenantId = useTenantId() ?? '';
  return <BillingWorkspace key={tenantId} tenantId={tenantId} />;
}

function Meter({
  label,
  meter,
  unit,
  note,
}: {
  label: string;
  meter: UsageMeter;
  unit: string;
  note?: string;
}) {
  const percent = meter.percent;
  const tone =
    percent === null
      ? 'bg-indigo-600'
      : percent >= CRITICAL_PERCENT
        ? 'bg-red-600'
        : percent >= WARN_PERCENT
          ? 'bg-amber-500'
          : 'bg-indigo-600';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-800">{label}</h3>
        <span className="text-sm text-slate-700">
          {meter.used.toLocaleString()}
          {meter.limit === null
            ? ''
            : ` / ${meter.limit.toLocaleString()}`}{' '}
          {unit}
        </span>
      </div>
      {meter.limit === null ? (
        <p className="mt-2 text-xs text-slate-600">No limit on this plan.</p>
      ) : (
        <div
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(percent ?? 0, 100)}
          aria-valuetext={`${percent}%`}
          className="mt-3 h-2 w-full rounded-full bg-slate-100"
        >
          <div
            className={`h-2 rounded-full ${tone}`}
            style={{ width: `${Math.min(percent ?? 0, 100)}%` }}
          />
        </div>
      )}
      {note && <p className="mt-2 text-xs text-slate-600">{note}</p>}
    </div>
  );
}

function BillingWorkspace({ tenantId }: { tenantId: string }) {
  const { data, error, mutate } = useSWR(
    tenantId ? ['billing', tenantId] : null,
    () => getBilling(tenantId),
    { refreshInterval: 30000 },
  );
  const [checkout, setCheckout] = useState<'success' | 'cancelled' | null>(
    null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    // Read after mount so server and first browser renders agree.
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (result === 'success' || result === 'cancelled') setCheckout(result);
    return () => request.current?.abort();
  }, []);

  async function upgrade(plan: Plan) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(plan.id);
    setFailure('');
    try {
      const { url } = await startCheckout(tenantId, plan.id, controller.signal);
      if (!controller.signal.aborted) window.location.assign(url);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setFailure(
          cause instanceof Error
            ? cause.message
            : 'Checkout could not start. Try again.',
        );
        request.current = null;
        setPending(null);
      }
    }
  }

  return (
    <div className="p-4 sm:p-8">
      <div className="mb-6 flex items-center gap-2">
        <CreditCard aria-hidden="true" className="h-6 w-6 text-indigo-700" />
        <h1 className="text-2xl font-semibold text-gray-900">Plan & usage</h1>
      </div>
      {error && !data && (
        <DataLoadNotice label="Plan and usage" onRetry={() => mutate()} />
      )}
      {checkout === 'success' && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          Payment received. Your plan changes as soon as Stripe confirms it,
          usually within a minute.
        </p>
      )}
      {checkout === 'cancelled' && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800"
        >
          Checkout was cancelled. Nothing was charged.
        </p>
      )}
      {!data ? (
        !error && (
          <p role="status" className="text-sm text-gray-600">
            Loading plan and usage…
          </p>
        )
      ) : (
        <Overview
          data={data}
          pending={pending}
          failure={failure}
          onUpgrade={upgrade}
        />
      )}
    </div>
  );
}

function Overview({
  data,
  pending,
  failure,
  onUpgrade,
}: {
  data: BillingOverview;
  pending: string | null;
  failure: string;
  onUpgrade: (plan: Plan) => void;
}) {
  const requests = data.requests.percent ?? 0;
  const enforced = data.quotasEnforced;
  return (
    <div className="flex flex-col gap-6">
      {data.suspended ? (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"
        >
          <PauseCircle aria-hidden="true" className="h-5 w-5 shrink-0" />
          <p>
            <strong>Traffic is paused.</strong> This workspace used its{' '}
            {data.plan.requestsPerMonth?.toLocaleString()} monthly requests, so
            the gateway answers every request with 429 until{' '}
            {formatDate(data.suspended.until)} (UTC).{' '}
            {data.plans.some(
              (plan) => plan.purchasable && plan.id !== data.plan.id,
            )
              ? 'Upgrade to resume now.'
              : 'Contact us to raise the limit.'}
          </p>
        </div>
      ) : data.requests.limit !== null && requests >= WARN_PERCENT ? (
        <div
          role="alert"
          className={`flex gap-3 rounded-xl border p-4 text-sm ${requests >= CRITICAL_PERCENT ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-950'}`}
        >
          <AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0" />
          <p>
            This workspace has used {requests}% of its monthly requests.{' '}
            {enforced
              ? 'At 100% the gateway pauses all traffic until the monthly reset.'
              : 'Limits are not enforced on this installation.'}
          </p>
        </div>
      ) : null}

      <section
        aria-labelledby="billing-usage-title"
        className="rounded-2xl border border-slate-200 bg-slate-50 p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="billing-usage-title"
            className="text-lg font-semibold text-slate-900"
          >
            {data.plan.name} plan
          </h2>
          <p className="text-sm text-slate-700">
            Usage resets on {formatDate(data.resetsAt)} (UTC)
          </p>
        </div>
        {!enforced && (
          <p className="mt-1 text-sm text-slate-700">
            Plan limits are shown for reference; this installation does not
            enforce them.
          </p>
        )}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Meter
            label="Requests this month"
            meter={data.requests}
            unit="requests"
            note="Counted by your gateways and reported about every 30 seconds."
          />
          <Meter label="Consumers" meter={data.consumers} unit="consumers" />
          <Meter label="Routes" meter={data.routes} unit="routes" />
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-medium text-slate-800">
              Log retention
            </h3>
            <p className="mt-1 text-sm text-slate-700">
              {data.logRetentionDays.configured} days configured · up to{' '}
              {data.logRetentionDays.max} days on this plan
            </p>
            <Link
              href="/settings"
              className="mt-2 inline-block text-xs font-medium text-indigo-800 underline"
            >
              Change retention in Settings
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="billing-plans-title">
        <h2
          id="billing-plans-title"
          className="mb-3 text-lg font-semibold text-slate-900"
        >
          Plans
        </h2>
        {failure && (
          <p
            role="alert"
            className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {failure}
          </p>
        )}
        <ul className="grid gap-3 md:grid-cols-3">
          {data.plans.map((plan) => {
            const current = plan.id === data.plan.id;
            return (
              <li
                key={plan.id}
                className={`flex flex-col rounded-2xl border bg-white p-5 ${current ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-slate-200'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-900">
                    {plan.name}
                  </h3>
                  {current && (
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">
                      Current plan
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-700">{price(plan)}</p>
                <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-700">
                  <li>{limit(plan.requestsPerMonth, 'requests / month')}</li>
                  <li>{limit(plan.consumersMax, 'consumers')}</li>
                  <li>{limit(plan.routesMax, 'routes')}</li>
                  <li>{plan.logRetentionDays} days of logs</li>
                </ul>
                {current ? null : plan.purchasable && data.checkoutAvailable ? (
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => onUpgrade(plan)}
                    className="mt-4 rounded-xl bg-indigo-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {pending === plan.id
                      ? 'Opening checkout…'
                      : `Switch to ${plan.name}`}
                  </button>
                ) : plan.priceMonthlyCents === null ? (
                  <Link
                    href="/contact"
                    className="mt-4 rounded-xl border border-slate-300 px-4 py-2 text-center text-sm font-medium text-slate-800"
                  >
                    Contact sales
                    <span className="sr-only"> about {plan.name}</span>
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-slate-600">
          Payments are handled by Stripe. Plan changes apply when Stripe
          confirms them; a paid upgrade lifts a paused workspace immediately.
        </p>
      </section>
    </div>
  );
}
