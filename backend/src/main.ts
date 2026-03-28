import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { DEFAULT_CORS_ORIGIN, DEFAULT_PORT } from './config/defaults';

type NestLoggerLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose' | 'fatal';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const loggerLevels: NestLoggerLevel[] =
    process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'];

  const app = await NestFactory.create(AppModule, {
    logger: loggerLevels,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', DEFAULT_PORT);
  const corsOrigin = configService.get<string>('cors.origin', DEFAULT_CORS_ORIGIN);
  const trustedProxyHops = configService.get<number>('http.trustedProxyHops', 0);

  app.use(helmet());
  app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyHops);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  });

  await app.listen(port);
  logger.log(`Argus backend running on http://localhost:${port}`);
}

bootstrap();
