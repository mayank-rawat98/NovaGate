import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
const webhookBodies = [];
const graphqlRequests = [];
const h2Requests = [];
const fallbackRequests = [];
let untrustedCalls = 0;
let trustedWsCalls = 0;
let untrustedWsCalls = 0;
const websocketClients = new Set();
const receivedWsUrls = [];
const trustedHealthRequests = [];
let acknowledged = 0;
let config;
let listenerCa;
let identityCalls = 0;
let inactiveIdentityCalls = 0;
let outboundIdentityCalls = 0;
let untrustedIdentityCalls = 0;
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
function fetch(url, options = {}) {
  return new Promise((done, fail) => {
    const request = https.request(
      url,
      { ca: listenerCa, agent: false, ...options },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', fail);
        response.once('end', () =>
          done(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers,
            }),
          ),
        );
      },
    );
    request.on('error', fail);
    request.end(options.body);
  });
}
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
      if (headers[':path'] === '/test.Mtls/Watch')
        stream.write(frame(replyMessage));
      else stream.end(frame(replyMessage));
    }
  });
  await new Promise((done) => server.listen(0, '0.0.0.0', done));
  return `https://host.docker.internal:${server.address().port}`;
}
async function call(
  port,
  ca,
  authorization = `Bearer ${consumerKey}`,
  credentials = {},
  path = '/test.Echo/Call',
) {
  const session = http2.connect(`https://127.0.0.1:${port}`, {
    ca,
    ...credentials,
  });
  session.on('error', () => {
    /* Propagated by the request promise. */
  });
  try {
    await once(session, 'connect');
    const request = session.request({
      ':method': 'POST',
      ':path': path,
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
function connectWebsocket(
  port,
  path = '/socket',
  headers = {},
  credentials = {},
) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, ['chat'], {
    headers,
    ca: listenerCa,
    ...credentials,
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
  listenerCa = trusted.cert;
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      resolve(directory, 'client.key.pem'),
      '-out',
      resolve(directory, 'client.csr'),
      '-subj',
      '/CN=Packaged client',
    ],
    { stdio: 'ignore', timeout: 15000 },
  );
  writeFileSync(
    resolve(directory, 'client.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      resolve(directory, 'client.csr'),
      '-CA',
      resolve(directory, 'trusted.cert.pem'),
      '-CAkey',
      resolve(directory, 'trusted.key.pem'),
      '-CAcreateserial',
      '-out',
      resolve(directory, 'client.cert.pem'),
      '-days',
      '1',
      '-extfile',
      resolve(directory, 'client.ext'),
    ],
    { stdio: 'ignore', timeout: 15000 },
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      resolve(directory, 'client.csr'),
      '-CA',
      resolve(directory, 'untrusted.cert.pem'),
      '-CAkey',
      resolve(directory, 'untrusted.key.pem'),
      '-CAcreateserial',
      '-out',
      resolve(directory, 'rotated-client.cert.pem'),
      '-days',
      '1',
      '-extfile',
      resolve(directory, 'client.ext'),
    ],
    { stdio: 'ignore', timeout: 15000 },
  );
  const clientCredentials = {
    key: readFileSync(resolve(directory, 'client.key.pem')),
    cert: readFileSync(resolve(directory, 'client.cert.pem')),
  };

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
  const identity = https.createServer(trusted, (req, res) => {
    req.resume();
    req.once('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        outboundIdentityCalls++;
        res.end(
          JSON.stringify({
            access_token: 'upstream-provider-token',
            token_type: 'Bearer',
            expires_in: 300,
          }),
        );
      } else if (req.url === '/inactive') {
        inactiveIdentityCalls++;
        res.end(JSON.stringify({ active: false }));
      } else {
        identityCalls++;
        res.end(
          JSON.stringify({
            active: true,
            sub: 'provider-subject',
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        );
      }
    });
  });
  servers.push(identity);
  await new Promise((done) => identity.listen(0, '0.0.0.0', done));
  const identityBase = `https://host.docker.internal:${identity.address().port}`;
  const untrustedIdentity = https.createServer(untrusted, (_req, res) => {
    untrustedIdentityCalls++;
    res.end(JSON.stringify({ active: true }));
  });
  servers.push(untrustedIdentity);
  await new Promise((done) => untrustedIdentity.listen(0, '0.0.0.0', done));
  const untrustedIdentityEndpoint = `https://host.docker.internal:${untrustedIdentity.address().port}`;

  const webhookUpstream = https.createServer(trusted, (req, res) => {
    if (req.method !== 'POST') {
      req.resume();
      res.end('healthy');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      webhookBodies.push(Buffer.concat(chunks).toString('base64'));
      res.end('verified webhook');
    });
  });
  servers.push(webhookUpstream);
  await new Promise((done) => webhookUpstream.listen(0, '0.0.0.0', done));
  const webhookTarget = `https://host.docker.internal:${webhookUpstream.address().port}`;

  const graphqlUpstream = https.createServer(trusted, (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      req.resume();
      res.end('healthy');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      graphqlRequests.push({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
      });
      res.end('verified GraphQL');
    });
  });
  servers.push(graphqlUpstream);
  await new Promise((done) => graphqlUpstream.listen(0, '0.0.0.0', done));
  const graphqlTarget = `https://host.docker.internal:${graphqlUpstream.address().port}`;

  const http2Upstream = http2.createSecureServer({
    ...trusted,
    allowHTTP1: true,
  });
  servers.push(http2Upstream);
  http2Upstream.on('session', (session) => {
    sockets.add(session);
    session.on('error', () => undefined);
    session.once('close', () => sockets.delete(session));
  });
  http2Upstream.on('request', (req, res) => {
    if (req.httpVersionMajor !== 1) return;
    req.resume();
    res.end('healthy');
  });
  http2Upstream.on('stream', (stream, headers) => {
    stream.on('error', () => undefined);
    if (headers[':path'] === '/health') {
      stream.respond({ ':status': 200 });
      stream.end('healthy');
      return;
    }
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('end', () => {
      const body = Buffer.concat(chunks);
      h2Requests.push({ path: headers[':path'], body: body.toString('hex') });
      if (headers[':path'] === '/reset') {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        return;
      }
      stream.respond({ ':status': 200, 'x-h2-verified': 'yes' });
      if (headers[':path'] === '/stall') {
        const timer = setInterval(() => stream.write('x'), 25);
        stream.once('close', () => clearInterval(timer));
      } else
        stream.end(
          headers[':path'] === '/overflow'
            ? Buffer.alloc(257)
            : body.length
              ? body
              : 'verified HTTP2',
        );
    });
  });
  await new Promise((done) => http2Upstream.listen(0, '0.0.0.0', done));
  const http2Target = `https://host.docker.internal:${http2Upstream.address().port}`;
  const fallbackUpstream = https.createServer(trusted, (req, res) => {
    if (req.url === '/health') {
      req.resume();
      res.end('healthy');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      const body = Buffer.concat(chunks);
      fallbackRequests.push({ path: req.url, body: body.toString('hex') });
      res.setHeader('x-fallback-verified', 'yes');
      if (req.url === '/stall') {
        const timer = setInterval(() => res.write('x'), 25);
        res.once('close', () => clearInterval(timer));
      } else res.end(body);
    });
  });
  servers.push(fallbackUpstream);
  await new Promise((done) => fallbackUpstream.listen(0, '0.0.0.0', done));
  const fallbackTarget = `https://host.docker.internal:${fallbackUpstream.address().port}`;

  const authPlugin = (endpoint = '/introspect') => ({
    name: 'oauth2-client-credentials',
    config: {
      introspectionEndpoint: identityBase + endpoint,
      clientId: 'fixture',
      clientSecret: 'fixture-secret',
    },
  });
  config = {
    caCertPem: trusted.cert.toString(),
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
    'HMAC_MAX_BODY_BYTES=128',
    '-e',
    'HMAC_BODY_TIMEOUT_MS=300',
    '-e',
    'GRAPHQL_MAX_BODY_BYTES=128',
    '-e',
    'GRAPHQL_BODY_TIMEOUT_MS=300',
    '-e',
    'GRAPHQL_MAX_TOKENS=256',
    '-e',
    'HTTP2_MAX_RESPONSE_BYTES=256',
    '-e',
    'GRPC_HOST=0.0.0.0',
    '-e',
    'GRPC_TLS_CERT_FILE=/verification/trusted.cert.pem',
    '-e',
    'GRPC_TLS_KEY_FILE=/verification/trusted.key.pem',
    '-e',
    'HTTP_TLS_CERT_FILE=/verification/trusted.cert.pem',
    '-e',
    'HTTP_TLS_KEY_FILE=/verification/trusted.key.pem',
    '-e',
    'HTTP_TLS_CLIENT_CA_FILE=/verification/trusted.cert.pem',
    '-e',
    'GRPC_TLS_CLIENT_CA_FILE=/verification/trusted.cert.pem',

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
        await fetch(`https://127.0.0.1:${httpPort}/health`, {
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
    const legacy = await fetch(`https://127.0.0.1:${httpPort}${path}`, {
      method,
    });
    assert.equal(legacy.status, 404);
    const error = await legacy.json();
    assert.equal(error.error, 'SERVICE_NOT_FOUND');
    assert.equal(typeof error.requestId, 'string');
  }
  const metrics = await fetch(`https://127.0.0.1:${httpPort}/metrics`);
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
    (await fetch(`https://127.0.0.1:${httpPort}/admin/services`)).status,
    401,
  );
  const proxied = await fetch(`https://127.0.0.1:${httpPort}/admin/services`, {
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
    (await fetch(`https://127.0.0.1:${httpPort}/health`)).status,
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
        await (await fetch(`https://127.0.0.1:${httpPort}/metrics`)).text(),
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
        await (await fetch(`https://127.0.0.1:${httpPort}/metrics`)).text(),
      ),
    'accepted WebSocket metrics',
  );
  // Explicit fallback reaches the transport even if the untrusted health probe
  const removedWs = once(websocket, 'close');
  // Real HTTPS provider and private Redis: reuse within scope, never across providers.
  config.routes[0].plugins = [authPlugin()];
  config.routes.find((route) => route.id === 'ws-route').plugins = [
    authPlugin(),
  ];
  config.routes.push({
    id: 'provider-http',
    method: 'GET',
    pathPattern: '/identity',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: [authPlugin()],
  });
  config.routes.push({
    id: 'inactive-http',
    method: 'GET',
    pathPattern: '/inactive-identity',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: [authPlugin('/inactive')],
  });
  config.routes.push({
    id: 'untrusted-provider',
    method: 'GET',
    pathPattern: '/untrusted-identity',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: [
      {
        name: 'oauth2-client-credentials',
        config: {
          introspectionEndpoint: untrustedIdentityEndpoint,
          clientId: 'fixture',
          clientSecret: 'fixture-secret',
        },
      },
    ],
  });
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 3, payload: config }),
    );
  await until(() => acknowledged === 3, 'provider config ACK');
  const opaque = { authorization: 'Bearer same-provider-token' };
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/identity`, { headers: opaque }))
      .status,
    200,
  );
  assert.equal(
    (await call(grpcPort, trusted.cert, opaque.authorization)).status,
    '0',
  );
  const providerSocket = new WebSocket(`wss://127.0.0.1:${httpPort}/socket`, {
    headers: opaque,
    ca: listenerCa,
  });
  websocketClients.add(providerSocket);
  await once(providerSocket, 'open');
  providerSocket.close();
  await once(providerSocket, 'close');
  assert.equal(
    identityCalls,
    1,
    'HTTP, gRPC and WS share only the identical scoped cache',
  );
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/inactive-identity`, {
        headers: opaque,
      })
    ).status,
    401,
  );
  assert.equal(
    inactiveIdentityCalls,
    1,
    'Other provider must verify despite same token',
  );
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/untrusted-identity`, {
        headers: opaque,
      })
    ).status,
    503,
  );
  assert.equal(untrustedIdentityCalls, 0);
  const cacheKeys = docker(
    'exec',
    redisName,
    'redis-cli',
    '--raw',
    'KEYS',
    'oauth2:introspect:v2:*',
  )
    .split('\n')
    .filter(Boolean);
  assert.equal(cacheKeys.length, 1);
  const lifetime = Number(
    docker('exec', redisName, 'redis-cli', '--raw', 'PTTL', cacheKeys[0]),
  );
  assert.ok(lifetime > 0 && lifetime <= 30000);
  const outbound = {
    name: 'oauth2-client-credentials',
    config: {
      tokenEndpoint: identityBase + '/token',
      clientId: 'fixture',
      clientSecret: 'fixture-secret',
    },
  };
  config.routes.find((route) => route.id === 'provider-http').plugins = [
    outbound,
  ];
  config.routes[0].plugins = undefined;
  config.routes.find((route) => route.id === 'ws-route').plugins = undefined;
  // fails first, so this proves certificate validation in the forwarding path.
  config.services[0].targets = [{ url: untrustedTarget, weight: 1 }];
  config.services[0].unhealthyFallback = true;
  config.services[1].targets = [{ url: untrustedWsTarget, weight: 1 }];

  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 4, payload: config }),
    );
  await until(() => acknowledged === 4, 'updated target ACK');
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/identity`)).status,
    401,
  );
  assert.equal(outboundIdentityCalls, 1);
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
        await (await fetch(`https://127.0.0.1:${httpPort}/metrics`)).text(),
      ),
    'released WebSocket metrics',
  );

  config.services[0].targets = [{ url: trustedTarget, weight: 1 }];
  config.services[1].targets = [{ url: trustedWsTarget, weight: 1 }];
  const mtls = [{ name: 'mtls', config: { required: true } }];
  config.routes.push({
    id: 'mtls-http',
    method: 'GET',
    pathPattern: '/mtls',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: mtls,
  });
  config.routes.push({
    id: 'mtls-grpc-watch',
    method: 'POST',
    pathPattern: '/test.Mtls/Watch',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: mtls,
  });
  config.routes.push({
    id: 'mtls-grpc',
    method: 'POST',
    pathPattern: '/test.Mtls/Call',
    serviceId: 'service',
    enabled: true,
    authRequired: true,
    plugins: mtls,
  });
  config.routes.push({
    id: 'mtls-ws',
    method: 'GET',
    pathPattern: '/mtls-socket',
    serviceId: 'ws-service',
    enabled: true,
    authRequired: true,
    plugins: mtls,
  });
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 5, payload: config }),
    );
  await until(() => acknowledged === 5, 'native client trust ACK');
  assert.equal((await fetch(`https://127.0.0.1:${httpPort}/mtls`)).status, 403);
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/mtls`, {
        headers: {
          ssl_client_cert: encodeURIComponent(
            clientCredentials.cert.toString(),
          ),
          ssl_client_verify: 'SUCCESS',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/mtls`, clientCredentials))
      .status,
    200,
  );
  assert.equal(
    (await call(grpcPort, trusted.cert, '', {}, '/test.Mtls/Call')).status,
    '7',
  );
  assert.equal(
    (
      await call(
        grpcPort,
        trusted.cert,
        '',
        clientCredentials,
        '/test.Mtls/Call',
      )
    ).status,
    '0',
  );
  assert.equal((await rejectedWebsocket(httpPort, '/mtls-socket')).status, 403);
  const mtlsSocket = connectWebsocket(
    httpPort,
    '/mtls-socket',
    {},
    clientCredentials,
  );
  await once(mtlsSocket, 'open');
  mtlsSocket.send('native mTLS');
  assert.equal(
    (await once(mtlsSocket, 'message'))[0].toString(),
    'native mTLS',
  );
  const revokedSocket = once(mtlsSocket, 'close');
  const mtlsSession = http2.connect(`https://127.0.0.1:${grpcPort}`, {
    ca: trusted.cert,
    ...clientCredentials,
  });
  mtlsSession.on('error', () => {
    /* Intentional trust cancellation. */
  });
  sockets.add(mtlsSession);
  await once(mtlsSession, 'connect');
  const watched = mtlsSession.request({
    ':method': 'POST',
    ':path': '/test.Mtls/Watch',
    'content-type': 'application/grpc',
    te: 'trailers',
  });
  watched.on('error', () => {
    /* Intentional trust cancellation. */
  });
  watched.end(frame([]));
  await once(watched, 'data');
  const stoppedTrust = once(watched, 'trailers');

  config.caCertPem = untrusted.cert.toString();
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 6, payload: config }),
    );
  await until(() => acknowledged === 6, 'tenant trust removal ACK');
  await revokedSocket;
  assert.equal((await stoppedTrust)[0]['grpc-status'], '14');
  mtlsSession.destroy();
  sockets.delete(mtlsSession);
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/mtls`, clientCredentials))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        grpcPort,
        trusted.cert,
        '',
        clientCredentials,
        '/test.Mtls/Call',
      )
    ).status,
    '7',
  );
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/health`)).status,
    200,
  );
  const rotatedCredentials = {
    key: clientCredentials.key,
    cert: readFileSync(resolve(directory, 'rotated-client.cert.pem')),
  };
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/mtls`, rotatedCredentials))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        grpcPort,
        trusted.cert,
        '',
        rotatedCredentials,
        '/test.Mtls/Call',
      )
    ).status,
    '0',
  );
  const rotatedSocket = connectWebsocket(
    httpPort,
    '/mtls-socket',
    {},
    rotatedCredentials,
  );
  await once(rotatedSocket, 'open');
  rotatedSocket.close();
  await once(rotatedSocket, 'close');
  config.services.push({
    id: 'webhook-service',
    name: 'webhook-fixture',
    targets: [{ url: webhookTarget, weight: 1 }],
  });
  config.routes.push({
    id: 'webhook-route',
    method: 'POST',
    pathPattern: '/webhook',
    serviceId: 'webhook-service',
    enabled: true,
    authRequired: true,
    plugins: [
      { name: 'request-size-limit', config: { maxBodyBytes: 256 } },
      {
        name: 'hmac-auth',
        config: {
          mode: 'stripe',
          header: 'stripe-signature',
          algorithm: 'sha256',
          secrets: ['fixture-old', 'fixture-new'],
        },
      },
    ],
  });
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 7, payload: config }),
    );
  await until(() => acknowledged === 7, 'webhook config ACK');
  const webhookBody = Buffer.from([0, 255, 128, 32, 13, 10, 123, 125]);
  const webhookSignature = (body, timestamp = Math.floor(Date.now() / 1000)) =>
    `t=${timestamp},v1=${createHmac('sha256', 'fixture-new').update(`${timestamp}.`).update(body).digest('hex')}`;
  const sendWebhook = (body, signature = webhookSignature(body)) =>
    fetch(`https://127.0.0.1:${httpPort}/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body,
    });
  assert.equal((await sendWebhook(webhookBody)).status, 200);
  assert.deepEqual(webhookBodies, [webhookBody.toString('base64')]);
  assert.equal(
    (await sendWebhook(Buffer.from('changed'), webhookSignature(webhookBody)))
      .status,
    401,
  );
  assert.equal(
    (
      await sendWebhook(
        webhookBody,
        webhookSignature(webhookBody, Math.floor(Date.now() / 1000) - 600),
      )
    ).status,
    401,
  );
  assert.equal((await sendWebhook(Buffer.alloc(129, 1))).status, 413);
  assert.equal(webhookBodies.length, 1);
  const stalled = await new Promise((done, fail) => {
    const request = https.request(
      `https://127.0.0.1:${httpPort}/webhook`,
      {
        ca: listenerCa,
        agent: false,
        method: 'POST',
        headers: {
          'stripe-signature': webhookSignature(webhookBody),
          'transfer-encoding': 'chunked',
        },
      },
      (res) => {
        res.resume();
        res.once('end', () => {
          request.destroy();
          done(res.statusCode);
        });
      },
    );
    request.on('error', fail);
    request.write(webhookBody);
  });
  assert.equal(stalled, 408);
  assert.equal((await sendWebhook(webhookBody)).status, 200);
  assert.equal(webhookBodies.length, 2);

  config.services.push({
    id: 'graphql-service',
    name: 'graphql-fixture',
    healthCheckPath: '/health',
    targets: [{ url: graphqlTarget, weight: 1 }],
  });
  config.routes.push({
    id: 'graphql-route',
    method: 'ANY',
    pathPattern: '/graphql',
    serviceId: 'graphql-service',
    enabled: true,
    authRequired: false,
    plugins: [
      { name: 'request-size-limit', config: { maxBodyBytes: 256 } },
      {
        name: 'graphql-guard',
        config: { maxDepth: 3, maxComplexity: 10, introspectionAllowed: false },
      },
    ],
  });
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 8, payload: config }),
    );
  await until(() => acknowledged === 8, 'GraphQL config ACK');
  const sendQuery = (query) =>
    fetch(
      `https://127.0.0.1:${httpPort}/graphql?query=${encodeURIComponent(query)}`,
    );
  assert.equal((await sendQuery('{ user { id } }')).status, 200);
  const queryBytes = Buffer.from(
    '{ "query": "{ user { id } }", "variables": {} }',
  );
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: queryBytes,
      })
    ).status,
    200,
  );
  assert.equal(graphqlRequests.length, 2);
  assert.equal(graphqlRequests.at(-1).body, queryBytes.toString());
  for (const query of [
    '{ root { ...A } } fragment A on Node { child { value { id } } }',
    '{ ...A } fragment A on Query { hidden: __schema { types { name } } }',
    '{ a: user { id } b: user { id } c: user { id } d: user { id } }',
    '{ ...A } fragment A on Query { ...A }',
  ])
    assert.equal((await sendQuery(query)).status, 400);
  assert.equal((await sendQuery('mutation { update }')).status, 405);
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.alloc(129, 32),
      })
    ).status,
    413,
  );
  assert.equal(graphqlRequests.length, 2);
  assert.equal((await sendQuery('{ user { id } }')).status, 200);

  config.services.push(
    {
      id: 'h2-service',
      name: 'bounded-h2',
      targets: [{ url: http2Target, weight: 1 }],
      h2: true,
      healthCheckPath: '/health',
      timeoutMs: 300,
    },
    {
      id: 'h2-fallback-service',
      name: 'fallback-h2',
      targets: [{ url: fallbackTarget, weight: 1 }],
      h2: true,
      healthCheckPath: '/health',
      timeoutMs: 3000,
    },
  );
  config.routes.push(
    {
      id: 'h2-route',
      method: 'ANY',
      pathPattern: '/h2',
      serviceId: 'h2-service',
      enabled: true,
      authRequired: false,
    },
    {
      id: 'h2-fallback-route',
      method: 'ANY',
      pathPattern: '/fallback',
      serviceId: 'h2-fallback-service',
      enabled: true,
      authRequired: false,
    },
  );
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 9, payload: config }),
    );
  await until(() => acknowledged === 9, 'HTTP2 config ACK');
  const exactBytes = Buffer.from([0, 255, 13, 10, 1, 32]);
  const exactH2 = await fetch(`https://127.0.0.1:${httpPort}/h2/echo`, {
    method: 'POST',
    body: exactBytes,
  });
  assert.equal(exactH2.status, 200);
  assert.equal(exactH2.headers.get('x-h2-verified'), 'yes');
  assert.deepEqual(Buffer.from(await exactH2.arrayBuffer()), exactBytes);
  assert.equal(h2Requests.at(-1).body, exactBytes.toString('hex'));
  const exactFallback = await fetch(
    `https://127.0.0.1:${httpPort}/fallback/echo`,
    { method: 'POST', body: exactBytes },
  );
  assert.equal(exactFallback.status, 200);
  assert.equal(exactFallback.headers.get('x-fallback-verified'), 'yes');
  assert.deepEqual(Buffer.from(await exactFallback.arrayBuffer()), exactBytes);
  assert.equal(fallbackRequests.length, 1);
  assert.equal(fallbackRequests[0].body, exactBytes.toString('hex'));
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/h2/overflow`)).status,
    502,
  );
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/h2/stall`)).status,
    504,
  );
  assert.equal(
    (
      await fetch(`https://127.0.0.1:${httpPort}/h2/reset`, {
        method: 'POST',
        body: exactBytes,
      })
    ).status,
    502,
  );
  assert.equal(h2Requests.filter((r) => r.path === '/reset').length, 1);
  assert.equal(fallbackRequests.length, 1);
  assert.equal(
    (await fetch(`https://127.0.0.1:${httpPort}/h2/echo`)).status,
    200,
  );

  const fallbackStarted = Date.now();
  await assert.rejects(fetch(`https://127.0.0.1:${httpPort}/fallback/stall`));
  assert.ok(Date.now() - fallbackStarted < 4500);
  assert.equal(fallbackRequests.length, 2);

  config.services.push({
    id: 'least-service',
    name: 'weighted-least-connections',
    targets: [
      { url: http2Target, weight: 1 },
      { url: fallbackTarget, weight: 1 },
    ],
    loadBalancing: 'least-connections',
    h2: true,
    healthCheckPath: '/health',
    timeoutMs: 2000,
  });
  config.routes.push({
    id: 'least-route',
    method: 'ANY',
    pathPattern: '/least',
    serviceId: 'least-service',
    enabled: true,
    authRequired: false,
  });
  for (const socket of plane.clients)
    socket.send(
      JSON.stringify({ type: 'config.update', version: 10, payload: config }),
    );
  await until(() => acknowledged === 10, 'least-connections config ACK');
  const stallsBefore = h2Requests.filter(
    (request) => request.path === '/stall',
  ).length;
  const busyAbort = new AbortController();
  const busy = fetch(`https://127.0.0.1:${httpPort}/least/stall`, {
    signal: busyAbort.signal,
  }).catch((error) => {
    if (error.name !== 'AbortError') throw error;
    return null;
  });
  try {
    await until(
      () =>
        h2Requests.filter((request) => request.path === '/stall').length >
        stallsBefore,
      'busy least-connections upstream dispatch',
    );
    const concurrent = await fetch(`https://127.0.0.1:${httpPort}/least/echo`, {
      method: 'POST',
      body: exactBytes,
    });
    assert.equal(concurrent.status, 200);
    assert.equal(concurrent.headers.get('x-fallback-verified'), 'yes');
    assert.deepEqual(Buffer.from(await concurrent.arrayBuffer()), exactBytes);
  } finally {
    busyAbort.abort();
    await busy;
  }
  // A cancelled busy stream must become eligible again, without resetting config.
  await until(async () => {
    const recovered = await fetch(`https://127.0.0.1:${httpPort}/least/echo`);
    assert.equal(recovered.status, 200);
    return recovered.headers.get('x-h2-verified') === 'yes';
  }, 'least-connections cancelled target recovery');

  const healthCommand = JSON.parse(
    docker(
      'inspect',
      gatewayName,
      '--format',
      '{{json .Config.Healthcheck.Test}}',
    ),
  );
  assert.equal(healthCommand[0], 'CMD-SHELL');
  docker('exec', gatewayName, 'sh', '-c', healthCommand[1]);
  docker(
    'exec',
    gatewayName,
    'wget',
    '--no-check-certificate',
    '-qO-',
    'https://localhost:3000/health',
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
        untrustedIdentityCalls,
        identityCalls,
        inactiveIdentityCalls,
        outboundIdentityCalls,
        checks: [
          'least-connections-concurrent-busy-H2-target-verified-HTTP1-fallback-cancel-recovery',
          'HTTP2-verified-HTTPS-exact-binary-POST-and-predispatch-HTTP1-fallback',
          'HTTP2-response-bound-absolute-deadline-reset-no-mutation-replay-recovery',
          'HTTP1-fallback-trickle-stream-absolute-deadline',
          'GraphQL-HTTPS-GET-POST-AST-fragments-alias-cost-cycle-introspection-method-body-boundaries',
          'GraphQL-original-POST-bytes-and-failure-recovery',
          'Stripe-HTTPS-binary-rotation-tamper-staleness-body-limit-deadline-recovery',
          'signed-byte-preparation-before-earlier-body-limit-hook',
          'native-client-private-key-proof-HTTPS-gRPC-WSS',
          'copied-public-certificate-assertion-denied',
          'tenant-trust-removal-cancels-gRPC-and-WSS-denies-new-requests',
          'native-HTTPS-anonymous-loopback-health',
          'new-client-CA-accepted-without-listener-restart-HTTPS-gRPC-WSS',
          'configured-Docker-HTTPS-health-command',
          'HTTPS-provider-scoped-Redis-HTTP-gRPC-WebSocket',
          'identical-token-other-provider-inactive',
          'untrusted-provider-certificate-rejected',
          'live-Redis-active-result-expiration-capped',
          'outbound-provider-token-does-not-authenticate-client',
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
