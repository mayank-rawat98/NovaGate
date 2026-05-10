'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { getTenantId } from '../../../lib/auth';
import { rotateGatewayKey } from '../../../lib/api-client';

const CONTROL_PLANE_WS_URL = 'wss://ws.novagate.dev/gateway-ws';
const GATEWAY_IMAGE = 'ghcr.io/rawatshahab/novagate/api:latest';

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('gw_setup_api_key');
    if (stored) setApiKey(stored);
  }, []);

  async function handleRotate() {
    const tenantId = getTenantId();
    if (!tenantId) return;
    setRotating(true);
    try {
      const { apiKey: newKey } = await rotateGatewayKey(tenantId);
      setApiKey(newKey);
      localStorage.setItem('gw_setup_api_key', newKey);
      toast.success('Gateway key rotated — update your container before the old key expires.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Key rotation failed');
    } finally {
      setRotating(false);
    }
  }

  function handleCopy() {
    if (!apiKey) return;
    navigator.clipboard.writeText(apiKey);
    toast.success('API key copied to clipboard');
  }

  const dockerCompose = `services:
  gateway:
    image: ${GATEWAY_IMAGE}
    environment:
      GATEWAY_API_KEY: \${GATEWAY_API_KEY}
      CONTROL_PLANE_URL: ${CONTROL_PLANE_WS_URL}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: \${JWT_SECRET}
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      - redis
  redis:
    image: redis:7-alpine`;

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Gateway Settings</h1>

      {/* API Key */}
      <div className="bg-white p-6 rounded-lg shadow mb-8">
        <h2 className="text-lg font-semibold mb-1">Gateway API Key</h2>
        <p className="text-sm text-gray-600 mb-4">
          This key authenticates your gateway instance with our control plane.
          It is shown once — copy it now. If lost, rotate to generate a new one.
        </p>

        {apiKey ? (
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={apiKey}
              className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 font-mono text-sm text-gray-900 outline-none"
            />
            <button
              onClick={handleCopy}
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <span className="font-mono text-sm tracking-widest text-gray-400 select-none">
              gw_••••••••••••••••••••••••••••••••
            </span>
            <span className="text-xs text-gray-400">rotate to get a new key</span>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleRotate}
            disabled={rotating}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
          >
            {rotating ? 'Rotating…' : 'Rotate Key'}
          </button>
          <p className="text-xs text-red-500">
            Rotating immediately invalidates the current key — update your gateway before rotating.
          </p>
        </div>
      </div>

      {/* Docker Compose */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-semibold mb-1">Deployment (Docker Compose)</h2>
        <p className="text-sm text-gray-600 mb-4">
          Copy this to a{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">docker-compose.yml</code>{' '}
          on your VPS. Set <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">GATEWAY_API_KEY</code> from the key above.
        </p>
        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-xs overflow-x-auto leading-relaxed">
          {dockerCompose}
        </pre>
      </div>
    </div>
  );
}
