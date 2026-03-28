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
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const authEnabled = this.configService.get<boolean>('auth.enabled', false);
    if (!authEnabled) {
      return true;
    }

    const adminApiKey = this.configService.get<string>('auth.adminApiKey', '');
    if (!adminApiKey) {
      throw new UnauthorizedException('Admin API key is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const identity = request.identity;

    if (identity?.role !== 'admin' || identity.authType !== 'api_key') {
      throw new UnauthorizedException('Admin API key required');
    }

    return true;
  }
}
