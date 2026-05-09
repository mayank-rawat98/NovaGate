'use client';

export default function SettingsPage() {
  const apiKey = 'gw_placeholder_key'; // Would be fetched

  const dockerCompose = `
services:
  gateway:
    image: ghcr.io/your-org/api-gateway:latest
    environment:
      GATEWAY_API_KEY: \${GATEWAY_API_KEY}
      CONTROL_PLANE_URL: wss://control.yourdomain.com
      REDIS_URL: redis://redis:6379
    depends_on:
      - redis
  redis:
    image: redis:7-alpine
`;

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Gateway Settings</h1>

      <div className="bg-white p-6 rounded-lg shadow mb-8">
        <h2 className="text-lg font-semibold mb-4">Gateway API Key</h2>
        <p className="text-sm text-gray-600 mb-4">
          Use this key to authenticate your gateway instance with our control
          plane.
        </p>
        <div className="flex items-center gap-2">
          <code className="bg-gray-100 p-2 rounded flex-1 border font-mono text-sm">
            {apiKey}
          </code>
          <button className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium">
            Copy
          </button>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-lg font-semibold mb-4">
          Deployment (Docker Compose)
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          Copy this to a <code>docker-compose.yml</code> file on your VPS.
        </p>
        <pre className="bg-gray-900 text-gray-100 p-4 rounded font-mono text-xs overflow-x-auto">
          {dockerCompose}
        </pre>
      </div>
    </div>
  );
}
