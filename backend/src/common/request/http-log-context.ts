import type { Request } from 'express';

export function buildHttpLogContext(
  request: Request,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId: request.requestId,
    method: request.method,
    path: request.originalUrl || request.url,
    clientIp: request.clientIp ?? request.ip,
    scopeKey: request.identity?.scopeKey,
    authRole: request.identity?.role,
    authType: request.identity?.authType,
    ...extra,
  };
}
