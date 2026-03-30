import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { deriveScopeKey } from './scope-key';
import type { RequestIdentity } from './request-identity';

type PublicSessionPayload = {
  sessionId: string;
  expiresAt: number;
};

@Injectable()
export class AuthService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolves identity from an incoming HTTP request.
   * Called once per request by the AuthMiddleware.
   */
  resolveIdentity(request: Request, response?: Response): RequestIdentity {
    const authEnabled = this.configService.get<boolean>('auth.enabled', false);
    const apiKey = this.extractApiKey(request);

    if (!authEnabled) {
      return {
        authenticated: true,
        role: 'admin',
        authType: apiKey ? 'api_key' : 'none',
        scopeKey: deriveScopeKey(apiKey),
        apiKey,
      };
    }

    if (apiKey) {
      return this.resolveApiKeyIdentity(apiKey);
    }

    if (this.configService.get<boolean>('auth.publicSessionsEnabled', false) && this.isPublicSessionEligiblePath(request)) {
      const publicSession = this.resolvePublicSession(request, response);
      if (publicSession) {
        return {
          authenticated: true,
          role: 'user',
          authType: 'public_session',
          scopeKey: deriveScopeKey(publicSession.sessionId, 'session'),
        };
      }
    }

    return this.buildAnonymousIdentity();
  }

  private resolveApiKeyIdentity(apiKey: string): RequestIdentity {
    const adminApiKey = this.configService.get<string>('auth.adminApiKey', '');
    if (adminApiKey && apiKey === adminApiKey) {
      return {
        authenticated: true,
        role: 'admin',
        authType: 'api_key',
        scopeKey: deriveScopeKey(apiKey),
        apiKey,
      };
    }

    const allowedApiKeys = this.configService.get<string[]>('auth.apiKeys', []);
    if (allowedApiKeys.includes(apiKey)) {
      return {
        authenticated: true,
        role: 'user',
        authType: 'api_key',
        scopeKey: deriveScopeKey(apiKey),
        apiKey,
      };
    }

    return this.buildAnonymousIdentity(apiKey, 'api_key');
  }

  private buildAnonymousIdentity(
    apiKey?: string,
    authType: RequestIdentity['authType'] = 'none',
  ): RequestIdentity {
    return {
      authenticated: false,
      role: 'anonymous',
      authType,
      scopeKey: deriveScopeKey(undefined),
      apiKey,
    };
  }

  private resolvePublicSession(request: Request, response?: Response): PublicSessionPayload | undefined {
    const cookieName = this.configService.get<string>('auth.publicSessionCookieName', 'argus_public_session');
    const sessionSecret = this.configService.get<string>('auth.publicSessionSecret', '');
    if (!cookieName || !sessionSecret) {
      return undefined;
    }

    const existingToken = this.extractCookie(request, cookieName);
    const existingSession = existingToken ? this.verifyPublicSession(existingToken, sessionSecret) : undefined;
    if (existingSession) {
      return existingSession;
    }

    if (!response) {
      return undefined;
    }

    const ttlDays = this.configService.get<number>('auth.publicSessionTtlDays', 30);
    const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
    const sessionId = randomUUID();
    const token = this.signPublicSession({ sessionId, expiresAt }, sessionSecret);

    response.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.shouldUseSecureCookies(request),
      path: '/api',
      maxAge: ttlDays * 24 * 60 * 60 * 1000,
    });

    return { sessionId, expiresAt };
  }

  private shouldUseSecureCookies(request: Request): boolean {
    if (request.secure) {
      return true;
    }

    const forwardedProto = request.header('x-forwarded-proto');
    if (!forwardedProto) {
      return false;
    }

    return forwardedProto
      .split(',')
      .some((value) => value.trim().toLowerCase() === 'https');
  }

  private isPublicSessionEligiblePath(request: Request): boolean {
    const rawCandidatePaths: string[] = [
      request.originalUrl ?? '',
      request.url ?? '',
      `${request.baseUrl || ''}${request.path || ''}`,
      request.path ?? '',
    ];

    const candidatePaths = new Set<string>();
    for (const rawPath of rawCandidatePaths) {
      const normalizedPath = rawPath.split('?')[0];
      if (normalizedPath) {
        candidatePaths.add(normalizedPath);
      }
    }

    for (const path of candidatePaths) {
      if (
        path.startsWith('/api/chat')
        || path.startsWith('/chat')
        || path.startsWith('/api/memory/v2')
        || path.startsWith('/memory/v2')
      ) {
        return true;
      }
    }

    return false;
  }

  private extractCookie(request: Request, cookieName: string): string | undefined {
    const cookieHeader = request.header('cookie');
    if (!cookieHeader) {
      return undefined;
    }

    return cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  }

  private signPublicSession(payload: PublicSessionPayload, secret: string): string {
    const signature = createHmac('sha256', secret)
      .update(`${payload.sessionId}.${payload.expiresAt}`)
      .digest('hex');
    return `${payload.sessionId}.${payload.expiresAt}.${signature}`;
  }

  private verifyPublicSession(token: string, secret: string): PublicSessionPayload | undefined {
    const [sessionId, expiresAtRaw, providedSignature] = token.split('.');
    const expiresAt = Number.parseInt(expiresAtRaw ?? '', 10);
    if (!sessionId || !expiresAtRaw || !providedSignature || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return undefined;
    }

    const expectedSignature = createHmac('sha256', secret)
      .update(`${sessionId}.${expiresAt}`)
      .digest('hex');
    if (expectedSignature.length !== providedSignature.length) {
      return undefined;
    }

    const isValid = timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
    if (!isValid) {
      return undefined;
    }

    return { sessionId, expiresAt };
  }

  extractApiKey(request: Request): string | undefined {
    const headerValue = request.header('x-api-key');
    if (headerValue) {
      return headerValue;
    }

    const authorization = request.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim() || undefined;
    }

    return undefined;
  }
}
