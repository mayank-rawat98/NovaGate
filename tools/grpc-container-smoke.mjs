import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as http2 from 'node:http2';
import * as https from 'node:https';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';

// Run after building docker/Dockerfile.api. The gateway and Redis are isolated
// on a disposable network without PostgreSQL. Existing resources are untouched.
const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.local-work');
mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(resolve(artifacts, 'grpc-container-'));
chmodSync(directory, 0o755); // Disposable verification certificates, never production keys.
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const networkName = `novagate-grpc-${suffix}`;
const redisName = `novagate-grpc-redis-${suffix}`;
const gatewayName = `novagate-grpc-gateway-${suffix}`;
const grpcurlName = `novagate-grpc-client-${suffix}`;
const image = process.env.NOVAGATE_GRPC_IMAGE ?? 'novagate-api:verification';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const sockets = new Set();
const servers = [];
let plane;
let networkCreated = false;
let trustedCalls = 0;
let untrustedCalls = 0;
let trustedWsCalls = 0;
let untrustedWsCalls = 0;
const websocketClients = new Set();
const receivedWsUrls = [];
const trustedHealthRequests = [];
let acknowledged = 0;
let config;
const consumerKey = 'container-verification-consumer';
const replyText = 'packaged TLS response';
const replyMessage = Buffer.concat([
  Buffer.from([10, Buffer.byteLength(replyText)]),
  Buffer.from(replyText),
]);
const grpcurlImage =
  'fullstorydev/grpcurl:v1.9.3@sha256:085e183ca334eb4e81ca81ee12cbb2b2737505d1d77f5e33dabc5d066593d998';
const frame = (value) => {
  const payload = Buffer.from(value);
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(payload.length, 1);
  return Buffer.concat([prefix, payload]);
};
async function until(predicate, description, timeout = 15000) {
  const expires = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > expires) throw new Error(`Timed out: ${description}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
function certificate(name) {
  const key = resolve(directory, `${name}.key.pem`);
  const cert = resolve(directory, `${name}.cert.pem`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:host.docker.internal',
    ],
    { stdio: 'ignore', timeout: 15000 },
  );
  chmodSync(key, 0o644); // Allow the non-root container to read its disposable fixture.
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
async function upstream(tls, count, healthRequests = []) {
  const server = http2.createSecureServer(tls);
  servers.push(server);
  server.on('session', (session) => {
    sockets.add(session);
    session.on('error', () => {
      /* Deliberate TLS/cancellation checks. */
    });
    session.once('close', () => sockets.delete(session));
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {
      /* Deliberate cancellation checks. */
    });
    stream.resume();
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc' },
      { waitForTrailers: true },
    );
    stream.once('wantTrailers', () =>
      stream.sendTrailers({ 'grpc-status': '0', 'verification-bin': 'AQID' }),
    );
    if (headers[':path'] === '/grpc.health.v1.Health/Check') {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.once('end', () => {
        healthRequests.push(Buffer.concat(chunks));
        stream.end(Buffer.from([0, 0, 0, 0, 2, 8, 1]));
      });
    } else {
      count();
      stream.end(frame(replyMessage));
    }
  });
  await new Promise((done) => server.listen(0, '0.0.0.0', done));
  return `https://host.docker.internal:${server.address().port}`;
}
async function call(port, ca, authorization = `Bearer ${consumerKey}`) {
  const session = http2.connect(`https://127.0.0.1:${port}`, { ca });
  session.on('error', () => {
    /* Propagated by the request promise. */
  });
  try {
    await once(session, 'connect');
    const request = session.request({
      ':method': 'POST',
      ':path': '/test.Echo/Call',
      'content-type': 'application/grpc',
      te: 'trailers',
      authorization,
      'grpc-timeout': '3000m',
    });
    let status;
    let trailers = {};
    const chunks = [];
    request.on('response', (headers) => {
      status = headers['grpc-status'];
    });
    request.on('trailers', (headers) => {
      trailers = headers;
      status = headers['grpc-status'];
    });
    request.on('data', (chunk) => chunks.push(chunk));
    const ended = once(request, 'end');
    request.end(frame('test'));
    await ended;
    return { status: String(status), trailers, body: Buffer.concat(chunks) };
  } finally {
    session.destroy();
  }
}
async function websocketUpstream(tls, count) {
  const server = https.createServer(tls, (_req, res) => res.end('healthy'));
  servers.push(server);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    count();
    receivedWsUrls.push(req.url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      ws.on('message', (data, binary) => ws.send(data, { binary }));
    });
  });
  await new Promise((done) => server.listen(0, '0.0.0.0', done));
  return `https://host.docker.internal:${server.address().port}`;
}
function connectWebsocket(port, path = '/socket', headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, ['chat'], {
    headers,
    perMessageDeflate: true,
    handshakeTimeout: 5000,
  });
  websocketClients.add(ws);
  ws.on('error', () => {
    /* Rejections are asserted separately. */
  });
  return ws;
}
async function rejectedWebsocket(port, path = '/socket', headers = {}) {
  const ws = connectWebsocket(port, path, headers);
  return new Promise((done, fail) => {
    ws.once('open', () => fail(new Error('Unexpected accepted WebSocket')));
    ws.once('unexpected-response', (_req, response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        ws.terminate();
        done({ status: response.statusCode, body });
      });
    });
    ws.once('error', fail);
  });
}
try {
  assert.equal(
    docker('context', 'show'),
    'orbstack',
    'Container verification requires OrbStack',
  );
  docker('network', 'create', networkName);
  networkCreated = true;
  const trusted = certificate('trusted');
  const untrusted = certificate('untrusted');
  const trustedTarget = await upstream(
    trusted,
    () => trustedCalls++,
    trustedHealthRequests,
  );
  const untrustedTarget = await upstream(untrusted, () => untrustedCalls++);
  const trustedWsTarget = await websocketUpstream(
    trusted,
    () => trustedWsCalls++,
  );
  const untrustedWsTarget = await websocketUpstream(
    untrusted,
    () => untrustedWsCalls++,
  );
  config = {
    routes: [
      {
        id: 'route',
        method: 'POST',
        pathPattern: '/test.Echo/Call',
        serviceId: 'service',
        authRequired: true,
        enabled: true,
      },
    ],
    services: [
      {
        id: 'service',
        name: 'tls-echo',
        targets: [{ url: trustedTarget, weight: 1 }],
        h2: true,
        timeoutMs: 5000,
        healthCheckPath: '/health',
        healthCheckProtocol: 'grpc',
        healthCheckService: 'test.Echo',
      },
    ],
    consumers: [
      {
        id: 'consumer',
        name: 'verification',
        keyHash: createHash('sha256').update(consumerKey).digest('hex'),
        rateLimitTier: 'authenticated',
        groups: [],
      },
    ],
    rateLimit: { windowMs: 60000, authMax: 100, unauthMax: 10 },
  };
  plane = new WebSocketServer({ port: 0, host: '0.0.0.0' });
  await once(plane, 'listening');
  plane.on('connection', (socket) => {
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'auth') {
        assert.equal(message.payload.apiKey, 'container-verification-api-key');
        socket.send(
          JSON.stringify({
            type: 'auth_ok',
            payload: { tenantId: 'tenant', config, configVersion: 1 },
          }),
        );
      }
      if (message.type === 'config.ack') acknowledged = message.version;
    });
  });
  docker(
    'run',
    '-d',
    '--name',
    redisName,
    '--network',
    networkName,
    'redis:7-alpine',
  );
  await until(() => {
    try {
      return docker('exec', redisName, 'redis-cli', 'ping') === 'PONG';
    } catch {
      return false;
    }
  }, 'private Redis startup');
  docker(
    'run',
    '-d',
    '--name',
    gatewayName,
    '--network',
    networkName,
    '-p',
    '127.0.0.1::50051',
    '-p',
    '127.0.0.1::3000',
    '--mount',
    `type=bind,src=${directory},dst=/verification,readonly`,
    '-e',
    `REDIS_URL=redis://${redisName}:6379`,
    '-e',
    'JWT_SECRET=container-verification-secret-at-least-32-characters',
    '-e',
    `CONTROL_PLANE_URL=ws://host.docker.internal:${plane.address().port}`,
    '-e',
    'GATEWAY_API_KEY=container-verification-api-key',
    '-e',
    'GRPC_ENABLED=true',
    '-e',
    'WS_ALLOW_QUERY_TOKEN=true',
    '-e',
    'WS_MAX_CONNECTIONS=2',
    '-e',
    'GRPC_HOST=0.0.0.0',
    '-e',
    'GRPC_TLS_CERT_FILE=/verification/trusted.cert.pem',
    '-e',
    'GRPC_TLS_KEY_FILE=/verification/trusted.key.pem',
    '-e',
    'NODE_EXTRA_CA_CERTS=/verification/trusted.cert.pem',
    '-e',
    'HEALTH_FAILURE_THRESHOLD=1',
    '-e',
    'HEALTH_RECOVERY_THRESHOLD=1',
    image,
  );
  const httpPort = Number(
    docker('port', gatewayName, '3000/tcp').split(':').at(-1),
  );
  const grpcPort = Number(
    docker('port', gatewayName, '50051/tcp').split(':').at(-1),
  );
  await until(
    () => acknowledged === 1,
    'packaged control-plane config ACK',
    30000,
  );
  await until(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${httpPort}/health`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, 'packaged HTTP and gRPC readiness');
  await until(
    () => trustedHealthRequests.length > 0,
    'packaged native health RPC',
  );
  assert.deepEqual(
    trustedHealthRequests[0],
    frame(Buffer.concat([Buffer.from([10, 9]), Buffer.from('test.Echo')])),
  );
  for (const [method, path] of [
    ['GET', '/admin/services'],
    ['GET', '/admin/services/unused'],
    ['POST', '/admin/services'],
    ['PUT', '/admin/services/unused'],
    ['DELETE', '/admin/services/unused'],
  ]) {
    const legacy = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
      method,
    });
    assert.equal(legacy.status, 404);
    const error = await legacy.json();
    assert.equal(error.error, 'SERVICE_NOT_FOUND');
    assert.equal(typeof error.requestId, 'string');
  }
  const metrics = await fetch(`http://127.0.0.1:${httpPort}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /gateway_grpc_active_calls/);
  const result = await call(grpcPort, trusted.cert);
  assert.equal(result.status, '0');
  assert.deepEqual(result.body, frame(replyMessage));
  assert.equal(result.trailers['verification-bin'], 'AQID');
  assert.equal(trustedCalls, 1);
  writeFileSync(
    resolve(directory, 'verification.proto'),
    'syntax = "proto3"; package test; service Echo { rpc Call(Message) returns (Message); } message Message { string message = 1; }',
  );
  const { stdout: grpcurlOutput } = await promisify(execFile)(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      grpcurlName,
      '--network',
      networkName,
      '--mount',
      `type=bind,src=${directory},dst=/verification,readonly`,
      grpcurlImage,
      '-cacert',
      '/verification/trusted.cert.pem',
      '-authority',
      'host.docker.internal',
      '-import-path',
      '/verification',
      '-proto',
      'verification.proto',
      '-max-time',
      '5',
      '-H',
      `authorization: Bearer ${consumerKey}`,
      '-d',
      '{"message":"test"}',
      `${gatewayName}:50051`,
      'test.Echo/Call',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(JSON.parse(grpcurlOutput).message, replyText);
  assert.equal(trustedCalls, 2);
  assert.equal(
    (await call(grpcPort, trusted.cert, 'Bearer unverified')).status,
    '16',
  );
  assert.equal(trustedCalls, 2);
  // This prefix is an ordinary tenant route, not a hidden local CRUD surface.
  config.routes.push({
    id: 'http-route',
    method: 'GET',
    pathPattern: '/admin/services',
    serviceId: 'service',
    authRequired: true,
    enabled: true,
  });
  config.routes.push({
    id: 'limited-ws-route',
    method: 'GET',
    pathPattern: '/limited-socket',
    serviceId: 'ws-service',
    authRequired: true,
    enabled: true,
    rateLimitOverride: 1,
  });
  config.routes.push({
    id: 'ws-route',
    method: 'GET',
    pathPattern: '/socket',
    serviceId: 'ws-service',
    authRequired: true,
    enabled: true,
  });
  config.services.push({
    id: 'ws-service',
    name: 'secure-ws',
    targets: [{ url: trustedWsTarget, weight: 1 }],
    timeoutMs: 5000,
    healthCheckPath: '/health',
    supportsWebSocket: true,
    unhealthyFallback: true,
  });
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 2, payload: config }),
    );
  await until(() => acknowledged === 2, 'tenant HTTP route ACK');
  assert.equal(
    (await fetch(`http://127.0.0.1:${httpPort}/admin/services`)).status,
    401,
  );
  const proxied = await fetch(`http://127.0.0.1:${httpPort}/admin/services`, {
    headers: { authorization: `Bearer ${consumerKey}` },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(
    Buffer.from(await proxied.arrayBuffer()),
    frame(replyMessage),
  );
  assert.equal(trustedCalls, 3);
  assert.equal((await rejectedWebsocket(httpPort)).status, 401);
  const malformed = await rejectedWebsocket(httpPort, '/socket?token=%QQ');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'TOKEN_INVALID');
  assert.equal(
    docker('inspect', gatewayName, '--format', '{{.State.Running}}'),
    'true',
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${httpPort}/health`)).status,
    200,
  );
  assert.equal(trustedWsCalls, 0);
  const limited = connectWebsocket(httpPort, '/limited-socket', {
    authorization: `Bearer ${consumerKey}`,
  });
  await once(limited, 'open');
  const quotaDenied = await rejectedWebsocket(httpPort, '/limited-socket', {
    authorization: `Bearer ${consumerKey}`,
  });
  assert.equal(quotaDenied.status, 429);
  assert.equal(quotaDenied.body.error, 'RATE_LIMIT_EXCEEDED');
  const limitedClosed = once(limited, 'close');
  limited.close(1000);
  await limitedClosed;
  await until(
    async () =>
      /gateway_ws_active_connections 0(?:\n|$)/.test(
        await (await fetch(`http://127.0.0.1:${httpPort}/metrics`)).text(),
      ),
    'limited WebSocket metric cleanup',
  );
  const websocket = connectWebsocket(
    httpPort,
    `/socket?room=a%2fb&token=${consumerKey}`,
  );
  await once(websocket, 'open');
  assert.equal(websocket.protocol, 'chat');
  assert.match(websocket.extensions, /permessage-deflate/);
  assert.equal(receivedWsUrls.at(-1), '/socket?room=a%2fb');
  let reply = once(websocket, 'message');
  websocket.send('packaged websocket');
  assert.equal((await reply)[0].toString(), 'packaged websocket');
  const binary = Buffer.from([0, 255, 128, 1]);
  reply = once(websocket, 'message');
  websocket.send(binary);
  const binaryReply = await reply;
  assert.deepEqual(binaryReply[0], binary);
  assert.equal(binaryReply[1], true);
  const pong = once(websocket, 'pong');
  websocket.ping('verification');
  assert.equal((await pong)[0].toString(), 'verification');
  const secondWs = connectWebsocket(httpPort, '/socket', {
    authorization: `Bearer ${consumerKey}`,
  });
  await once(secondWs, 'open');
  const capacity = await rejectedWebsocket(httpPort, '/socket', {
    authorization: `Bearer ${consumerKey}`,
  });
  assert.equal(capacity.status, 503);
  assert.equal(capacity.body.error, 'WS_CAPACITY_EXHAUSTED');
  const secondClosed = once(secondWs, 'close');
  secondWs.close(1000);
  await secondClosed;
  await until(
    async () =>
      /gateway_ws_active_connections 1(?:\n|$)/.test(
        await (await fetch(`http://127.0.0.1:${httpPort}/metrics`)).text(),
      ),
    'accepted WebSocket metrics',
  );
  // Explicit fallback reaches the transport even if the untrusted health probe
  // fails first, so this proves certificate validation in the forwarding path.
  config.services[0].targets = [{ url: untrustedTarget, weight: 1 }];
  config.services[0].unhealthyFallback = true;
  config.services[1].targets = [{ url: untrustedWsTarget, weight: 1 }];
  const removedWs = once(websocket, 'close');
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 3, payload: config }),
    );
  await until(() => acknowledged === 3, 'updated target ACK');
  assert.equal((await call(grpcPort, trusted.cert)).status, '14');
  assert.equal(untrustedCalls, 0);
  await removedWs;
  assert.equal(
    (
      await rejectedWebsocket(httpPort, '/socket', {
        authorization: `Bearer ${consumerKey}`,
      })
    ).status,
    502,
  );
  assert.equal(untrustedWsCalls, 0);
  await until(
    async () =>
      /gateway_ws_active_connections 0(?:\n|$)/.test(
        await (await fetch(`http://127.0.0.1:${httpPort}/metrics`)).text(),
      ),
    'released WebSocket metrics',
  );
  const environment = JSON.parse(
    docker('inspect', gatewayName, '--format', '{{json .Config.Env}}'),
  );
  assert.ok(!environment.some((entry) => entry.startsWith('DATABASE_URL=')));
  const runtime = docker(
    'exec',
    gatewayName,
    'node',
    '-p',
    'JSON.stringify({uid:process.getuid(),node:process.version})',
  );
  assert.equal(JSON.parse(runtime).uid, 1000);
  writeFileSync(
    resolve(artifacts, 'grpc-container-evidence.json'),
    JSON.stringify(
      {
        image,
        imageId: docker('inspect', gatewayName, '--format', '{{.Image}}'),
        databaseRequired: false,
        runtime: JSON.parse(runtime),
        trustedCalls,
        trustedWsCalls,
        untrustedWsCalls,
        trustedHealthChecks: trustedHealthRequests.length,
        grpcurlImage,
        untrustedCalls,
        configVersion: acknowledged,
        checks: [
          'trusted-listener-and-upstream-TLS',
          'native-health-RPC',
          'metadata-trailers',
          'grpcurl-unary-protobuf',
          'verified-consumer',
          'invalid-auth-denied',
          'untrusted-upstream-denied',
          'non-root-runtime',
          'postgres-free-startup',
          'legacy-admin-CRUD-absent',
          'authenticated-tenant-HTTP-prefix-route',
          'websocket-malformed-query-does-not-crash',
          'websocket-verified-consumer-TLS-upstream',
          'websocket-text-binary-compression-subprotocol-ping-close',
          'websocket-capacity-and-active-metrics',
          'websocket-live-Redis-route-quota',
          'websocket-target-removal',
          'websocket-untrusted-upstream-denied',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Packaged HTTP/gRPC/WebSocket TLS/auth/config/streaming checks passed.',
  );
} finally {
  try {
    writeFileSync(
      resolve(artifacts, 'grpc-container.log'),
      await promisify(execFile)('docker', ['logs', gatewayName], {
        encoding: 'utf8',
        timeout: 15000,
      }).then(({ stdout, stderr }) => stdout + stderr),
    );
  } catch {
    /* Startup may fail before creation. */
  }
  for (const client of websocketClients) client.terminate();
  for (const name of [grpcurlName, gatewayName, redisName]) {
    try {
      docker('rm', '-f', name);
    } catch {
      /* Remove only this invocation's containers. */
    }
  }
  if (plane) {
    for (const socket of plane.clients) socket.terminate();
    await new Promise((done) => plane.close(done));
  }
  for (const socket of sockets) socket.destroy();
  for (const server of servers) await new Promise((done) => server.close(done));
  if (networkCreated) docker('network', 'rm', networkName);
  rmSync(directory, { recursive: true, force: true });
}
