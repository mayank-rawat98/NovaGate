'use client';

import useSWR from 'swr';
import { useLiveMetrics } from '../../lib/use-live-metrics';
import Link from 'next/link';
import {
  Activity,
  Layers3,
  Route,
  ShieldCheck,
  ArrowUpRight,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { GatewayStatusPill } from '../../components/gateway-status-pill';
import { getGatewayStatus, getRoutes, getLogs } from '../../lib/api-client';
import { useTenantId } from '../../lib/auth';
import type {
  MetricsSnapshot,
  Route as RouteEntity,
} from '../../lib/api-client';
import type { RequestLog } from '../../lib/api-client';

const SWR_OPTS = { refreshInterval: 30000 };

function StatCard({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="nova-stat-icon">
        <Icon size={18} aria-hidden="true" />
      </div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      {children}
    </div>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-100 ${className}`} />;
}

export default function DashboardPage() {
  const tenantId = useTenantId() ?? '';

  const {
    data: status,
    error: statusError,
    mutate: retryStatus,
  } = useSWR(
    tenantId ? `gateway-status-${tenantId}` : null,
    () => getGatewayStatus(tenantId),
    SWR_OPTS,
  );

  const {
    data: metrics1h,
    isLoading: metricsLoading,
    error: metricsError,
    retry: retryMetrics,
    connection: metricConnection,
    stale: metricsStale,
  } = useLiveMetrics(tenantId);

  const {
    data: routes,
    error: routesError,
    mutate: retryRoutes,
  } = useSWR(
    tenantId ? `routes-${tenantId}` : null,
    () => getRoutes(tenantId),
    SWR_OPTS,
  );

  const {
    data: logsResult,
    error: logsError,
    mutate: retryLogs,
  } = useSWR(
    tenantId ? `logs-${tenantId}` : null,
    () => getLogs(tenantId, { page: 1 }),
    SWR_OPTS,
  );

  const snapshots: MetricsSnapshot[] = Array.isArray(metrics1h)
    ? metrics1h
    : [];
  const latestMetric: MetricsSnapshot | undefined =
    snapshots[snapshots.length - 1];
  const activeRoutes: RouteEntity[] = (routes ?? []).filter(
    (route) => route.enabled,
  );
  const recentLogs: RequestLog[] = logsResult?.items ?? [];

  // Aggregate top 5 routes from recent logs
  const routeStats = recentLogs.reduce<
    Record<string, { count: number; totalLatency: number }>
  >((acc, log) => {
    const key = `${log.method} ${log.path}`;
    if (!acc[key]) acc[key] = { count: 0, totalLatency: 0 };
    acc[key].count++;
    acc[key].totalLatency += log.responseTimeMs;
    return acc;
  }, {});
  const topRoutes = Object.entries(routeStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([key, stats]) => {
      const [method, ...pathParts] = key.split(' ');
      return {
        method,
        path: pathParts.join(' '),
        count: stats.count,
        avgLatency: Math.round(stats.totalLatency / stats.count),
      };
    });

  const sparklineData = snapshots.map((s) => ({
    time: new Date(s.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
    rps: s.rps,
  }));

  const isDegraded =
    status?.online === true && (latestMetric?.errorRate ?? 0) > 0.05;

  return (
    <div className="p-4 sm:p-8">
      <section
        className="nova-overview-hero"
        aria-labelledby="overview-heading"
      >
        <div className="relative z-10">
          <p className="nova-eyebrow mb-3">Workspace overview</p>
          <h1
            id="overview-heading"
            className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl"
          >
            Your traffic, at a glance.
          </h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-600">
            Manage your API routes and see how your gateway is doing. Everything
            you need, in one place.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link
              href="/routes"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white"
            >
              Manage routes
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
            <Link
              href="/logs"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white/70 px-4 py-2.5 text-sm font-medium text-slate-700"
            >
              View request logs
            </Link>
          </div>
        </div>
        <div className="nova-hero-art" aria-hidden="true">
          <span className="nova-clay-orb">
            <Layers3 size={32} />
          </span>
          <span className="nova-clay-orb">
            <ShieldCheck size={24} />
          </span>
          <span className="nova-clay-orb" />
        </div>
      </section>
      {(statusError || metricsError || routesError || logsError) && (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p>
            Some workspace data could not be loaded. Showing the latest
            available information.
          </p>
          <button
            type="button"
            onClick={() => {
              void retryStatus();
              void retryMetrics();
              void retryRoutes();
              void retryLogs();
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-400 px-3 py-2 font-medium"
          >
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
        </div>
      )}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-800">
          Gateway activity
        </h2>
        <span className="text-xs text-slate-600">
          Latest HTTP samples · up to one hour
        </span>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
        <p role="status">
          {metricConnection === 'connecting'
            ? 'Connecting live metrics…'
            : metricConnection === 'reconnecting'
              ? 'Reconnecting live metrics. Last samples remain visible.'
              : metricsStale
                ? 'Live connection · last sample is stale. Waiting for the gateway.'
                : 'Live metrics connected'}{' '}
          · Latency percentiles are histogram estimates.
        </p>
        <button
          type="button"
          onClick={retryMetrics}
          className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 font-medium"
        >
          Reconnect metrics
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* Gateway Status */}
        <StatCard label="Gateway status" icon={ShieldCheck}>
          {status === undefined && !statusError ? (
            <Skeleton className="h-6 w-24 mt-2" />
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              <GatewayStatusPill
                online={status?.online ?? false}
                degraded={isDegraded}
                state={statusError && !status ? 'unknown' : undefined}
              />
              {status && !status.online && (
                <p className="text-xs text-gray-500">
                  Gateway is not connected
                </p>
              )}
            </div>
          )}
        </StatCard>

        {/* RPS sparkline */}
        <StatCard label="Requests / second" icon={Activity}>
          {metricsLoading ? (
            <Skeleton className="h-16 w-full mt-2" />
          ) : snapshots.length === 0 ? (
            <p className="mt-3 text-sm text-gray-400">Waiting for traffic</p>
          ) : (
            <div>
              <p className="mb-1 text-2xl font-bold text-gray-900">
                {(latestMetric?.rps ?? 0).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </p>
              <ResponsiveContainer width="100%" height={64}>
                <AreaChart data={sparklineData}>
                  <XAxis dataKey="time" hide />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={{ fontSize: 11, padding: '2px 8px' }}
                    formatter={(v) => [`${v} rps`, 'RPS']}
                  />
                  <Area
                    isAnimationActive={false}
                    type="monotone"
                    dataKey="rps"
                    stroke="#6157bf"
                    fill="#efecfa"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </StatCard>

        {/* Error Rate */}
        <StatCard label="Error rate" icon={Activity}>
          {metricsLoading ? (
            <Skeleton className="h-8 w-20 mt-2" />
          ) : !latestMetric ? (
            <p className="mt-3 text-sm text-gray-400">Waiting for traffic</p>
          ) : (
            <div className="mt-2">
              <p
                className={`text-2xl font-bold ${
                  (latestMetric.errorRate ?? 0) > 0.05
                    ? 'text-red-600'
                    : 'text-gray-900'
                }`}
              >
                {((latestMetric.errorRate ?? 0) * 100).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-500">
                p95 {latestMetric.p95Ms ?? 0}ms · p99 {latestMetric.p99Ms ?? 0}
                ms
              </p>
            </div>
          )}
        </StatCard>

        {/* Active Routes */}
        <StatCard label="Active routes" icon={Route}>
          {routes === undefined ? (
            <Skeleton className="h-8 w-12 mt-2" />
          ) : (
            <div className="mt-2">
              <p className="text-2xl font-bold text-gray-900">
                {activeRoutes.length}
              </p>
              <p className="text-xs text-gray-500">enabled routes</p>
            </div>
          )}
        </StatCard>
      </div>

      {/* Recent popular routes */}
      <div className="mt-8">
        <h2 className="mb-3 text-base font-semibold text-gray-900">
          Recent popular routes
        </h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  Method
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                  Path
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                  Requests
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                  Avg Latency
                </th>
              </tr>
            </thead>
            <tbody>
              {topRoutes.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-sm text-gray-400"
                  >
                    Your recent requests will appear here once traffic reaches
                    the gateway.
                  </td>
                </tr>
              ) : (
                topRoutes.map(({ method, path, count, avgLatency }) => (
                  <tr
                    key={`${method}-${path}`}
                    className="border-b border-gray-100 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <span className="inline-block rounded bg-gray-100 px-2 py-0.5 font-mono text-xs font-medium">
                        {method}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {path}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {count}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                      {avgLatency}ms
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
