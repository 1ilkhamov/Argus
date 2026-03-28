import type { Request } from 'express';

function normalizeIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

export function resolveClientIp(request: Request, trustedProxyHops = 0): string {
  const forwardedForHeader = request.header('x-forwarded-for');
  const forwardedFor = forwardedForHeader
    ?.split(',')
    .map((value) => normalizeIp(value))
    .filter((value): value is string => Boolean(value));

  if (trustedProxyHops > 0 && forwardedFor && forwardedFor.length > 0) {
    const index = Math.max(forwardedFor.length - trustedProxyHops, 0);
    const candidate = forwardedFor[index];
    if (candidate) {
      return candidate;
    }
  }

  const realIp = normalizeIp(request.header('x-real-ip'));
  if (trustedProxyHops > 0 && realIp) {
    return realIp;
  }

  return normalizeIp(request.ip) ?? normalizeIp(request.socket?.remoteAddress) ?? 'anonymous';
}
