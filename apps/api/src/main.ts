import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type * as http from 'http';
import { AppModule } from './app/app.module';
import type { GatewayConfig } from './config/configuration';
import { WsProxyService } from './gateway/proxy/ws-proxy.service';

async function bootstrap() {
  // Plugins and proxying need the exact incoming bytes. A JSON parser would
  // consume/rewrite the stream before size limits and HMAC verification.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService<GatewayConfig, true>);
  const port = configService.get('port', { infer: true });
  app
    .getHttpAdapter()
    .getInstance()
    .set(
      'trust proxy',
      configService.get('trustedProxies', { infer: true }) ?? false,
    );

  await app.listen(port);

  // Wire WebSocket upgrade events to WsProxyService after the server is listening
  const httpServer = app.getHttpServer() as http.Server;
  const wsProxy = app.get(WsProxyService);
  httpServer.on('upgrade', (req, socket, head) => {
    wsProxy.handleUpgrade(req, socket as import('net').Socket, head);
  });

  Logger.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
