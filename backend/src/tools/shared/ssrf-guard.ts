import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Hostnames that must never be reached by any tool. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '0.0.0.0', '127.0.0.1', '::1',
  '169.254.169.254', 'metadata.google.internal', 'metadata',
]);

/** DNS suffixes considered local/internal. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate that a URL is safe to request (SSRF protection).
 *
 * Checks:
 * 1. Protocol must be HTTP or HTTPS
 * 2. No embedded credentials
 * 3. Hostname not in blocked list / suffixes
 * 4. IP address is not private/special-purpose
 * 5. DNS resolution does not point to a private/special-purpose IP
 *
 * @param url  — a URL object to validate
 * @throws Error with a descriptive message if the URL is unsafe
 */
export async function assertSafeUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }

  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))
  ) {
    throw new Error(`Requests to ${hostname} are not allowed (blocked host).`);
  }

  if (isPrivateIp(hostname)) {
    throw new Error(`Requests to private/special IP ${hostname} are not allowed.`);
  }

  // DNS resolution check for non-IP hostnames
  if (isIP(hostname) === 0) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error(`Could not resolve hostname ${hostname}.`);
    }

    if (addresses.length === 0) {
      throw new Error(`Could not resolve hostname ${hostname}.`);
    }

    for (const record of addresses) {
      if (isPrivateIp(record.address)) {
        throw new Error(`Hostname ${hostname} resolves to blocked address ${record.address}.`);
      }
    }
  }
}

/**
 * Convenience: validate a raw URL string (parses first).
 * @throws Error if the URL is malformed or unsafe
 */
export async function assertSafeRawUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}".`);
  }
  await assertSafeUrl(url);
  return url;
}

/**
 * Check whether an IP address belongs to a private, loopback,
 * link-local, or other special-purpose range.
 */
export function isPrivateIp(address: string): boolean {
  const v = isIP(address);

  if (v === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127) ||
      (a === 198 && ((b ?? 0) === 18 || (b ?? 0) === 19))
    );
  }

  if (v === 6) {
    const n = address.toLowerCase();
    return (
      n === '::' || n === '::1' ||
      n.startsWith('fc') || n.startsWith('fd') ||
      n.startsWith('fe80:') ||
      n.startsWith('::ffff:127.') || n.startsWith('::ffff:10.') ||
      n.startsWith('::ffff:192.168.') ||
      /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(n)
    );
  }

  return false;
}

/** Check if an HTTP status code is a redirect. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
