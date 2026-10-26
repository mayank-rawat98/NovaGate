import { bindTenantClientTrust } from './gateway/shared/tls-client-trust';
import { GatewayConfigManagerService } from './gateway/config-manager/gateway-config-manager.service';
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type * as http from 'http';
import { AppModule } from './app/app.module';
import configuration, {
  DEFAULT_TLS,
  type GatewayConfig,
} from './config/configuration';
import { listenerTlsOptions } from './config/tls-options';
import { WsProxyService } from './gateway/proxy/ws-proxy.service';

async function bootstrap() {
  // Plugins and proxying need the exact incoming bytes. A JSON parser would
  // consume/rewrite the stream before size limits and HMAC verification.
  await ConfigModule.envVariablesLoaded;
  const tlsSettings = configuration().tls;
  const httpsOptions = listenerTlsOptions(tlsSettings);
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    ...(httpsOptions ? { httpsOptions } : {}),
  });
  app.enableShutdownHooks();
  const configService = app.get(ConfigService<GatewayConfig, true>);
  const port = configService.get('port', { infer: true });
  app
    .getHttpAdapter()
    .getInstance()
    .set(
      'trust proxy',
      configService.get('trustedProxies', { infer: true }) ?? false,
    );

  // Attach the upgrade boundary before accepting traffic.
  const httpServer = app.getHttpServer() as http.Server;
  if (httpsOptions) {
    httpServer.maxConnections =
      tlsSettings.maxConnections ?? DEFAULT_TLS.maxConnections;
    bindTenantClientTrust(
      httpServer as import('https').Server,
      httpsOptions,
      app.get(GatewayConfigManagerService),
    );
  }
  const wsProxy = app.get(WsProxyService);
  httpServer.on('upgrade', (req, socket, head) => {
    void wsProxy.handleUpgrade(req, socket as import('net').Socket, head);
  });

  await app.listen(port);

  Logger.log(
    `Application is running on: ${httpsOptions ? 'https' : 'http'}://localhost:${port}`,
  );
}

bootstrap();
