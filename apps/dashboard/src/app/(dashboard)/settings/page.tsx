'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Copy, Check, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { getTenant, rotateGatewayKey } from '../../../lib/api-client';
import { getTenantId } from '../../../lib/auth';

const CONTROL_PLANE_WS_URL = 'wss://ws.novagate.dev/gateway-ws';
const GATEWAY_IMAGE = 'ghcr.io/rawatshahab/novagate/api:latest';

function buildDockerCompose(apiKey: string): string {
  return `services:
  gateway:
    image: ${GATEWAY_IMAGE}
    restart: unless-stopped
    environment:
      GATEWAY_API_KEY: ${apiKey}
      CONTROL_PLANE_URL: ${CONTROL_PLANE_WS_URL}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: \${JWT_SECRET}
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      - redis
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

volumes:
  redis_data:`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {label ?? (copied ? 'Copied!' : 'Copy')}
    </button>
  );
}

export default function SettingsPage() {
  const tenantId = getTenantId() ?? '';
  const [apiKey, setApiKey] = useState<string>('');
  const [showKey, setShowKey] = useState(false);
  const [rotating, setRotating] = useState(false);

  const { data: tenant } = useSWR(
    tenantId ? `tenant-${tenantId}` : null,
    () => getTenant(tenantId),
  );

  useEffect(() => {
    const stored = localStorage.getItem('gw_setup_api_key');
    if (stored) setApiKey(stored);
  }, []);

  const maskedKey = apiKey ? `${apiKey.slice(0, 8)}${'•'.repeat(24)}${apiKey.slice(-4)}` : '—';

  async function handleRotate() {
    if (!tenantId) return;
    setRotating(true);
    try {
      const { apiKey: newKey } = await rotateGatewayKey(tenantId);
      setApiKey(newKey);
      localStorage.setItem('gw_setup_api_key', newKey);
      setShowKey(true);
      toast.success('API key rotated. Update GATEWAY_API_KEY on your VPS — the old key is now invalid.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rotate key');
    } finally {
      setRotating(false);
    }
  }

  const dockerCompose = buildDockerCompose(apiKey || 'YOUR_GATEWAY_API_KEY');

  return (
    <div className="max-w-3xl p-8">
      <h1 className="mb-6 text-2xl font-semibold text-gray-900">Settings</h1>

      {/* Tenant info */}
      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Tenant</h2>
        </div>
        <div className="divide-y divide-gray-100">
          <div className="flex items-center justify-between px-6 py-3">
            <span className="text-sm text-gray-500">Name</span>
            <span className="text-sm font-medium text-gray-900">{tenant?.name ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between px-6 py-3">
            <span className="text-sm text-gray-500">Tenant ID</span>
            <span className="font-mono text-xs text-gray-600">{tenantId || '—'}</span>
          </div>
          <div className="flex items-center justify-between px-6 py-3">
            <span className="text-sm text-gray-500">Config Version</span>
            <span className="font-mono text-xs text-gray-600">
              {tenant?.gatewayConfigVersion != null ? `v${tenant.gatewayConfigVersion}` : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* Gateway API Key */}
      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Gateway API Key</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Authenticates your gateway instance with the control plane. Keep this secret.
          </p>
        </div>
        <div className="px-6 py-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-800">
              {showKey ? (apiKey || '—') : maskedKey}
            </code>
            <button
              onClick={() => setShowKey((v) => !v)}
              className="rounded-md border border-gray-300 p-2 text-gray-500 hover:bg-gray-50"
              title={showKey ? 'Hide key' : 'Reveal key'}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <CopyButton text={apiKey} />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-gray-400">
              Set as <code className="rounded bg-gray-100 px-1 text-xs">GATEWAY_API_KEY</code> on your VPS.
            </p>
            <button
              onClick={handleRotate}
              disabled={rotating}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${rotating ? 'animate-spin' : ''}`} />
              Rotate Key
            </button>
          </div>
        </div>
      </div>

      {/* Docker Compose */}
      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Docker Compose</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Save as <code className="rounded bg-gray-100 px-1 text-xs">docker-compose.yml</code> on your VPS and run{' '}
              <code className="rounded bg-gray-100 px-1 text-xs">docker compose up -d</code>
            </p>
          </div>
          <CopyButton text={dockerCompose} label="Copy YAML" />
        </div>
        <pre className="overflow-x-auto bg-gray-900 px-6 py-4 font-mono text-xs leading-relaxed text-gray-100">
          {dockerCompose}
        </pre>
      </div>

      {/* Environment variables */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Environment Variables</h2>
          <p className="mt-0.5 text-xs text-gray-500">All env vars the gateway process reads on startup.</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Variable</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Default</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {[
              { name: 'GATEWAY_API_KEY', def: 'required', note: 'From this page — authenticates with control plane' },
              { name: 'CONTROL_PLANE_URL', def: CONTROL_PLANE_WS_URL, note: 'WebSocket URL — pre-filled in the compose above' },
              { name: 'REDIS_URL', def: 'required', note: 'redis://… for config cache and rate limiting' },
              { name: 'JWT_SECRET', def: 'required', note: 'Min 32 chars — validates consumer JWT tokens' },
              { name: 'PORT', def: '3000', note: 'HTTP port the gateway listens on' },
              { name: 'PROXY_TIMEOUT_MS', def: '10000', note: 'Downstream request timeout in ms' },
              { name: 'RATE_LIMIT_WINDOW_MS', def: '60000', note: 'Sliding window size for rate limiting' },
              { name: 'RATE_LIMIT_UNAUTH_MAX', def: '100', note: 'Max req/window for unauthenticated clients' },
              { name: 'RATE_LIMIT_AUTH_MAX', def: '500', note: 'Max req/window for authenticated consumers' },
            ].map((row) => (
              <tr key={row.name}>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-800">{row.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{row.def}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
