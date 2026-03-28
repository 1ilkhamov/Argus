import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import configuration from './configuration';
import { validateEnvironment } from './validate-environment';

@Module({
  imports: [
    NestConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
      envFilePath: ['.env'],
      validate: validateEnvironment,
    }),
  ],
})
export class AppConfigModule {}
