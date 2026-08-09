import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { ErrorEnvelopeFilter } from './common/error.filter.js';

export async function createApplication() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
  );
  await app.register(import('@fastify/cors'), {
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
  });
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Work Chat API')
      .setDescription('Versioned API for the Work Chat internal alpha')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
  await app.init();
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await createApplication();
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Core API listening on http://localhost:${port}`, 'Bootstrap');
}

