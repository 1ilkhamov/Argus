import { randomUUID } from 'crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

import './request-context';
import { resolveClientIp } from './request-ip';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly configService: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    req.requestId = this.resolveRequestId(req.header('x-request-id'));
    req.clientIp = resolveClientIp(req, this.configService.get<number>('http.trustedProxyHops', 0));
    res.setHeader('X-Request-ID', req.requestId);
    next();
  }

  private resolveRequestId(rawValue: string | undefined): string {
    const value = rawValue?.trim();
    if (value && value.length <= 128) {
      return value;
    }

    return randomUUID();
  }
}
