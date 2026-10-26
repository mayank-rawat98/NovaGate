import { ConfigService } from '@nestjs/config';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  orderControlPlaneEndpoints,
  parseControlPlaneEndpoints,
  type TenantConfig,
} from '@api-gateway/shared-types';
import { ControlPlaneConnectorService } from './control-plane-connector.service';
import type { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

describe('control plane endpoint lists', () => {
  it('parses ordered, optionally labelled WebSocket endpoints', () => {
    expect(
      parseControlPlaneEndpoints(
        ' us-east=wss://us.example.test/ws , wss://plain.example.test,eu-west=ws://127.0.0.1:8080',
      ),
    ).toEqual([
      { region: 'us-east', url: 'wss://us.example.test/ws' },
      { region: null, url: 'wss://plain.example.test/' },
      { region: 'eu-west', url: 'ws://127.0.0.1:8080/' },
    ]);
  });

  it.each([
    '',
    'https://cp.example.test',
    'US=wss://cp.example.test',
    'wss://user:pass@cp.example.test',
    'wss://a.test,wss://a.test',
    'eu=wss://a.test,eu=wss://b.test',
    Array.from({ length: 9 }, (_, i) => `wss://cp${i}.test`).join(','),
  ])('refuses %p', (value) => {
    expect(() => parseControlPlaneEndpoints(value)).toThrow();
  });

  it('moves the preferred region first and keeps the rest in order', () => {
    const endpoints = parseControlPlaneEndpoints(
      'us-east=wss://us.test,eu-west=wss://eu.test,ap=wss://ap.test',
    );
    expect(
      orderControlPlaneEndpoints(endpoints, 'ap').map((e) => e.region),
    ).toEqual(['ap', 'us-east', 'eu-west']);
    expect(
      orderControlPlaneEndpoints(endpoints, 'missing').map((e) => e.region),
    ).toEqual(['us-east', 'eu-west', 'ap']);
  });
});

/** A minimal control plane: answers auth with its region and a config. */
async function controlPlane(region: string, port = 0) {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  await once(server, 'listening');
  const auths: Array<Record<string, unknown>> = [];
  /** Parsed gateway frames; fields are read loosely in assertions. */
  type Frame = { type: string; payload: Array<{ i: number }> } & Record<
    string,
    unknown
  >;
  const received: Array<{ at: number; message: Frame }> = [];
  const sockets = new Set<WebSocket>();
  let config: Partial<TenantConfig> = {};
  server.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push({ at: Date.now(), message });
      if (message.type !== 'auth') return;
      auths.push(message.payload);
      ws.send(
        JSON.stringify({
          type: 'auth_ok',
          payload: {
            tenantId: 'tenant',
            configVersion: 7,
            controlPlaneRegion: region,
            config: { routes: [], services: [], consumers: [], ...config },
          },
        }),
      );
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    auths,
    received,
    sockets,
    setConfig(next: Partial<TenantConfig>) {
      config = next;
    },
    push(next: Partial<TenantConfig>, version: number) {
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            type: 'config.update',
            version,
            payload: { routes: [], services: [], consumers: [], ...next },
          }),
        );
    },
    async stop() {
      for (const ws of sockets) ws.terminate();
      await new Promise((done) => server.close(done));
    },
  };
}

async function until(check: () => boolean, label: string, timeout = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

describe('ControlPlaneConnectorService failover', () => {
  let connector: ControlPlaneConnectorService | undefined;
  const servers: Array<Awaited<ReturnType<typeof controlPlane>>> = [];
  afterEach(async () => {
    connector?.onModuleDestroy();
    for (const server of servers.splice(0)) await server.stop();
  });

  function start(urls: string, failbackMs: number) {
    let version: number | null = 3;
    let installed: TenantConfig | null = null;
    const config = {
      warmStart: async () => undefined,
      loadConfig: async (_t: string, next: TenantConfig, v: number) => {
        installed = next;
        version = v;
      },
      getConfig: () => installed,
      getTenantId: () => 'tenant',
      get configVersion() {
        return version;
      },
    } as unknown as GatewayConfigManagerService;
    connector = new ControlPlaneConnectorService(
      new ConfigService({
        GATEWAY_API_KEY: 'gateway-key',
        controlPlane: {
          endpoints: parseControlPlaneEndpoints(urls),
          failbackMs,
          instanceName: 'edge-1',
        },
      }),
      config,
    );
    return connector.onModuleInit();
  }

  it('fails over to the next region, fails back, and follows the preferred region', async () => {
    const us = await controlPlane('us-east');
    const eu = await controlPlane('eu-west');
    servers.push(us, eu);
    await start(
      `us-east=ws://127.0.0.1:${us.port},eu-west=ws://127.0.0.1:${eu.port}`,
      1500,
    );
    await until(() => connector?.connectedRegion() === 'us-east', 'us-east');
    expect(us.auths[0]).toEqual({
      apiKey: 'gateway-key',
      instanceId: connector?.instanceId,
      instanceName: 'edge-1',
      configVersion: 3,
    });

    // The primary region goes away: the gateway moves to eu-west.
    const port = us.port;
    await us.stop();
    servers.splice(servers.indexOf(us), 1);
    await until(() => connector?.connectedRegion() === 'eu-west', 'failover');
    // Same process identity, current version, so nothing is lost.
    expect(eu.auths.at(-1)).toMatchObject({
      instanceId: connector?.instanceId,
      configVersion: 7,
    });

    // The primary comes back on the same address: fail back after 1.5 s.
    const back = await controlPlane('us-east', port);
    servers.push(back);
    await until(
      () => connector?.connectedRegion() === 'us-east',
      'failback',
      8000,
    );
    expect(back.auths).toHaveLength(1);

    // The workspace prefers eu-west: the gateway moves there and stays.
    eu.setConfig({ preferredRegion: 'eu-west' });
    back.push({ preferredRegion: 'eu-west' }, 8);
    await until(
      () => connector?.connectedRegion() === 'eu-west',
      'preferred region',
    );
    await new Promise((done) => setTimeout(done, 2000));
    expect(connector?.connectedRegion()).toBe('eu-west');
    expect(back.auths).toHaveLength(1);
  }, 30000);

  it('drains telemetry buffered while disconnected in order, paced, after the ACK', async () => {
    const cp = await controlPlane('solo');
    const port = cp.port;
    await cp.stop();
    await start(`ws://127.0.0.1:${port}`, 60000);
    for (let i = 0; i < 40; i++)
      connector?.send({ type: 'logs', payload: [{ i }] } as never);
    const back = await controlPlane('solo', port);
    servers.push(back);
    await until(
      () =>
        back.received.filter((r) => r.message.type === 'logs').length === 40,
      'backlog delivered',
    );
    const types = back.received.map((r) => r.message.type);
    expect(types.indexOf('config.ack')).toBeLessThan(types.indexOf('logs'));
    const logs = back.received.filter((r) => r.message.type === 'logs');
    expect(logs.map((r) => r.message.payload[0].i)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
    // Never more than two batches (8 frames) inside any 50 ms window.
    for (const first of logs)
      expect(
        logs.filter((r) => r.at >= first.at && r.at < first.at + 50).length,
      ).toBeLessThanOrEqual(8);
    // A new message after the backlog goes straight out.
    connector?.send({ type: 'logs', payload: [{ i: 40 }] } as never);
    await until(
      () =>
        back.received.filter((r) => r.message.type === 'logs').length === 41,
      'live message',
    );
  }, 20000);

  it('backs off failback while the first region stays down', async () => {
    const down = await controlPlane('us-east');
    const downPort = down.port;
    await down.stop();
    const eu = await controlPlane('eu-west');
    servers.push(eu);
    await start(
      `us-east=ws://127.0.0.1:${downPort},eu-west=ws://127.0.0.1:${eu.port}`,
      400,
    );
    await until(() => connector?.connectedRegion() === 'eu-west', 'fallback');
    await new Promise((done) => setTimeout(done, 6000));
    // Fixed 400 ms failback would reconnect about 10 times in 6 s; doubling
    // (0.4, 0.8, 1.6, 3.2 s plus reconnects) leaves a handful.
    expect(eu.auths.length).toBeLessThanOrEqual(5);
    expect(connector?.connectedRegion()).toBe('eu-west');
  }, 15000);

  it('keeps retrying a single endpoint with backoff', async () => {
    const cp = await controlPlane('solo');
    servers.push(cp);
    await start(`ws://127.0.0.1:${cp.port}`, 1000);
    await until(() => connector?.connectedRegion() === 'solo', 'connect');
    // A single endpoint never fails back to itself.
    await new Promise((done) => setTimeout(done, 1500));
    expect(cp.auths).toHaveLength(1);
  }, 10000);
});
