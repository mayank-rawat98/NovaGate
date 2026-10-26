/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app/app.module';
import { configureConfigImportParser } from './config-import/config-import.body-parser';
import { configureFederationParser } from './graphql-federation/graphql-federation.body-parser';

async function bootstrap() {
  // Stream services end their responses in lifecycle cleanup. Also close remaining
  // transport sockets when disposing the adapter, including idle preconnections.
  const app = await NestFactory.create(AppModule, {
    forceCloseConnections: true,
    // Stripe webhook signatures cover the exact request bytes.
    rawBody: true,
  });
  app.enableShutdownHooks();
  configureConfigImportParser(app);
  configureFederationParser(app);
  // Security headers (clickjacking, MIME sniffing, etc.). API serves JSON only,
  // so deny framing outright.
  app.use(
    helmet({
      frameguard: { action: 'deny' },
      contentSecurityPolicy: {
        directives: { 'frame-ancestors': ["'none'"] },
      },
    }),
  );
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  app.enableCors({
    origin: [
      'http://localhost:3003',
      'http://localhost:3001',
      'https://novagate.dev',
      'https://app.novagate.dev',
    ],
    methods: ['GET', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'x-device-id',
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Access-Control-Allow-Origin',
      'Accept',
      'If-Match',
    ],
    credentials: true,
  });
  const port = 3001;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
