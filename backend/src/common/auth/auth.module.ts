import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { AuthMiddleware } from './auth.middleware';
import { AuthService } from './auth.service';
import { RequestContextMiddleware } from '../request/request-context.middleware';

@Global()
@Module({
  providers: [AuthService, RequestContextMiddleware],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, AuthMiddleware).forRoutes('{*path}');
  }
}
