'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getTenant, getGatewayStatus } from '../../lib/api-client';
import { getTenantId } from '../../lib/auth';
import type { Tenant as TenantEntity } from '../../lib/api-client';

const CP_WS_URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_WS_URL ??
  'wss://your-control-plane/gateway-ws';

function maskKey(key: string): string {
  return key.slice(0, 8) + '•'.repeat(24) + key.slice(-4);
}

function buildDockerCompose(apiKey: string, cpUrl: string): string {
  return `services:
  gateway:
    image: ghcr.io/rawatshahab/novagate/api:latest
    environment:
      GATEWAY_API_KEY: ${apiKey}
      CONTROL_PLANE_URL: ${cpUrl}
      REDIS_URL: redis://redis:6379
  redis:
    image: redis:7-alpine
    volumes: [redis-data:/data]
    command: redis-server --appendonly yes
volumes:
  redis-data:`;
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [tenant, setTenant] = useState<TenantEntity | null>(null);
  // Plaintext key is stored in localStorage only during onboarding (set by registration flow)
  const [apiKey, setApiKey] = useState('gw_YOUR_TENANT_ID_…');
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedDocker, setCopiedDocker] = useState(false);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const id = getTenantId();
    if (!id) return;
    const storedKey =
      typeof window !== 'undefined'
        ? localStorage.getItem('gw_setup_api_key')
        : null;
    if (storedKey) setApiKey(storedKey);
    getTenant(id)
      .then((t) => setTenant(t))
      .catch(() => null);
  }, []);

  const pollStatus = useCallback(() => {
    const id = getTenantId();
    if (!id) return;
    getGatewayStatus(id)
      .then((s) => setOnline(s.online))
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (step !== 3) return;
    pollStatus();
    const interval = setInterval(pollStatus, 3000);
    return () => clearInterval(interval);
  }, [step, pollStatus]);

  function copyKey() {
    navigator.clipboard.writeText(apiKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copyDocker() {
    navigator.clipboard
      .writeText(buildDockerCompose(apiKey, CP_WS_URL))
      .then(() => {
        setCopiedDocker(true);
        setTimeout(() => setCopiedDocker(false), 2000);
      });
  }

  const steps = ['API Key', 'Docker Setup', 'Waiting for Gateway'];

  return (
    <div className="flex min-h-screen flex-col items-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-xl">
        <h1 className="mb-8 text-2xl font-semibold text-gray-900">
          Gateway Setup
        </h1>

        {/* Step indicators */}
        <div className="mb-8 flex gap-0">
          {steps.map((label, i) => {
            const n = i + 1;
            const done = step > n;
            const active = step === n;
            return (
              <div key={n} className="flex flex-1 items-center">
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                      done
                        ? 'bg-green-500 text-white'
                        : active
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-200 text-gray-500'
                    }`}
                  >
                    {done ? '✓' : n}
                  </div>
                  <span
                    className={`text-sm ${active ? 'font-medium text-gray-900' : 'text-gray-500'}`}
                  >
                    {label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className="mx-3 flex-1 border-t border-gray-300" />
                )}
              </div>
            );
          })}
        </div>

        {/* Step 1: API Key */}
        {step === 1 && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-1 text-base font-semibold text-gray-900">
              Your Gateway API Key
            </h2>
            <p className="mb-4 text-sm text-gray-500">
              This key authenticates your gateway instance with our control
              plane. Store it securely.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <code className="flex-1 overflow-hidden text-ellipsis font-mono text-sm text-gray-800">
                {revealed ? apiKey : maskKey(apiKey)}
              </code>
              <button
                onClick={() => setRevealed((r) => !r)}
                className="shrink-0 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-200"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <button
                onClick={copyKey}
                className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            {tenant && (
              <p className="mt-2 text-xs text-gray-400">
                Tenant: {tenant.name} ({tenant.id})
              </p>
            )}
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setStep(2)}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Docker */}
        {step === 2 && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-1 text-base font-semibold text-gray-900">
              Deploy with Docker Compose
            </h2>
            <p className="mb-4 text-sm text-gray-500">
              Copy this to a{' '}
              <code className="rounded bg-gray-100 px-1 font-mono text-xs">
                docker-compose.yml
              </code>{' '}
              file on your VPS and run{' '}
              <code className="rounded bg-gray-100 px-1 font-mono text-xs">
                docker compose up -d
              </code>
              .
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 font-mono text-xs text-gray-100">
                {buildDockerCompose(apiKey, CP_WS_URL)}
              </pre>
              <button
                onClick={copyDocker}
                className="absolute right-3 top-3 rounded bg-gray-700 px-2 py-1 text-xs font-medium text-gray-200 hover:bg-gray-600"
              >
                {copiedDocker ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setStep(1)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ← Back
              </button>
              <button
                onClick={() => setStep(3)}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Waiting */}
        {step === 3 && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm text-center">
            <h2 className="mb-1 text-base font-semibold text-gray-900">
              Waiting for Gateway
            </h2>
            <p className="mb-6 text-sm text-gray-500">
              Start your gateway with Docker Compose, then this page will detect
              the connection automatically.
            </p>
            {online ? (
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
                  <span className="text-2xl">✓</span>
                </div>
                <p className="font-medium text-green-700">Gateway connected!</p>
                <button
                  onClick={() => router.replace('/dashboard')}
                  className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Go to Dashboard
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
                <p className="text-sm text-gray-500">
                  Polling every 3 seconds…
                </p>
              </div>
            )}
            <div className="mt-6 flex justify-start">
              <button
                onClick={() => setStep(2)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ← Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
