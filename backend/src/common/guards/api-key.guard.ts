import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import '../auth/request-identity';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const authEnabled = this.configService.get<boolean>('auth.enabled', false);
    if (!authEnabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const identity = request.identity;

    if (!identity?.authenticated || identity.authType !== 'api_key') {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
