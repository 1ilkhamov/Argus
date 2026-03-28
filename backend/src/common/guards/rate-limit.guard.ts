import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import '../auth/request-identity';
import { RateLimitService } from '../services/rate-limit.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimitService: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const key = this.buildRateLimitKey(request);
    const result = await this.rateLimitService.consume(key);

    response.setHeader('X-RateLimit-Limit', String(result.limit));
    response.setHeader('X-RateLimit-Remaining', String(result.remaining));
    response.setHeader('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  private buildRateLimitKey(request: Request): string {
    const clientIp = request.clientIp || request.ip || 'anonymous';
    const identity = request.identity;
    const prefix = identity?.authenticated ? `id:${identity.scopeKey}` : `ip:${clientIp}`;
    return `${prefix}:${clientIp}:${request.method}:${request.path}`;
  }
}
