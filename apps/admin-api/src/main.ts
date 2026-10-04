/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
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
