'use client';

import useSWR from 'swr';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { GatewayStatusPill } from '../../components/gateway-status-pill';
import {
  getGatewayStatus,
  getMetrics,
  getRoutes,
  getLogs,
} from '../../lib/api-client';
import { getTenantId } from '../../lib/auth';
import type { MetricsSnapshot, Route as RouteEntity } from '../../lib/api-client';
import type { RequestLog } from '../../lib/api-client';

const SWR_OPTS = { refreshInterval: 30000 };

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      {children}
    </div>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-100 ${className}`} />;
}


export default function DashboardPage() {
  const tenantId = getTenantId() ?? '';

  const { data: status } = useSWR(
    tenantId ? `gateway-status-${tenantId}` : null,
    () => getGatewayStatus(tenantId),
    SWR_OPTS,
  );

  const { data: metrics1h } = useSWR(
    tenantId ? `metrics-1h-${tenantId}` : null,
    () => getMetrics(tenantId, '1h'),
    SWR_OPTS,
  );

  const { data: routes } = useSWR(
    tenantId ? `routes-${tenantId}` : null,
    () => getRoutes(tenantId),
    SWR_OPTS,
  );

  const { data: logsResult } = useSWR(
    tenantId ? `logs-${tenantId}` : null,
    () => getLogs(tenantId, { page: 1 }),
    SWR_OPTS,
  );

  const snapshots: MetricsSnapshot[] = Array.isArray(metrics1h) ? metrics1h : [];
  const latestMetric: MetricsSnapshot | undefined = snapshots[snapshots.length - 1];
  const activeRoutes: RouteEntity[] = routes ?? [];
  const recentLogs: RequestLog[] = logsResult?.items ?? [];

  // Aggregate top 5 routes from recent logs
  const routeStats = recentLogs.reduce<Record<string, { count: number; totalLatency: number }>>(
    (acc, log) => {
      const key = `${log.method} ${log.path}`;
      if (!acc[key]) acc[key] = { count: 0, totalLatency: 0 };
      acc[key].count++;
      acc[key].totalLatency += log.responseTimeMs;
      return acc;
    },
    {},
  );
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
    time: new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    rps: s.rps,
  }));

  const isDegraded = status?.online === true && (latestMetric?.errorRate ?? 0) > 0.05;

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-semibold text-gray-900">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4">
        {/* Gateway Status */}
        <StatCard label="Gateway Status">
          {status === undefined ? (
            <Skeleton className="h-6 w-24 mt-2" />
          ) : (
            <div className="mt-2 flex flex-col gap-1.5">
              <GatewayStatusPill online={status.online} degraded={isDegraded} />
              {status.online && latestMetric && (
                <p className="text-xs text-gray-500">
                  Config v{/* configVersion not in GatewayStatus type; placeholder */}—
                </p>
              )}
              {!status.online && (
                <p className="text-xs text-gray-500">Gateway is not connected</p>
              )}
            </div>
          )}
        </StatCard>

        {/* RPS sparkline */}
        <StatCard label="Requests / Second">
          {snapshots.length === 0 ? (
            <Skeleton className="h-16 w-full mt-2" />
          ) : (
            <div>
              <p className="mb-1 text-2xl font-bold text-gray-900">
                {latestMetric?.rps ?? 0}
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
                    type="monotone"
                    dataKey="rps"
                    stroke="#3b82f6"
                    fill="#eff6ff"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </StatCard>

        {/* Error Rate */}
        <StatCard label="Error Rate">
          {latestMetric === undefined ? (
            <Skeleton className="h-8 w-20 mt-2" />
          ) : (
            <div className="mt-2">
              <p
                className={`text-2xl font-bold ${
                  (latestMetric.errorRate ?? 0) > 0.05 ? 'text-red-600' : 'text-gray-900'
                }`}
              >
                {((latestMetric.errorRate ?? 0) * 100).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-500">
                p95 {latestMetric.p95Ms ?? 0}ms · p99 {latestMetric.p99Ms ?? 0}ms
              </p>
            </div>
          )}
        </StatCard>

        {/* Active Routes */}
        <StatCard label="Active Routes">
          {routes === undefined ? (
            <Skeleton className="h-8 w-12 mt-2" />
          ) : (
            <div className="mt-2">
              <p className="text-2xl font-bold text-gray-900">{activeRoutes.length}</p>
              <p className="text-xs text-gray-500">configured routes</p>
            </div>
          )}
        </StatCard>
      </div>

      {/* Top 5 Routes */}
      <div className="mt-8">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Top 5 Routes</h2>
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
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
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">
                    No request data yet
                  </td>
                </tr>
              ) : (
                topRoutes.map(({ method, path, count, avgLatency }) => (
                  <tr key={`${method}-${path}`} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3">
                      <span className="inline-block rounded bg-gray-100 px-2 py-0.5 font-mono text-xs font-medium">
                        {method}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{path}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">{count}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">{avgLatency}ms</td>
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
