import { assertSafeUrl, assertSafeRawUrl, isPrivateIp, isRedirectStatus } from './ssrf-guard';

// Mock dns lookup
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'node:dns/promises';
const mockLookup = lookup as jest.MockedFunction<typeof lookup>;

describe('ssrf-guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });

  // ─── assertSafeUrl ───────────────────────────────────────────────────────

  describe('assertSafeUrl', () => {
    it('should accept valid HTTPS URL', async () => {
      await expect(assertSafeUrl(new URL('https://example.com'))).resolves.toBeUndefined();
    });

    it('should accept valid HTTP URL', async () => {
      await expect(assertSafeUrl(new URL('http://example.com'))).resolves.toBeUndefined();
    });

    it('should reject non-HTTP protocols', async () => {
      await expect(assertSafeUrl(new URL('ftp://example.com'))).rejects.toThrow('Only HTTP and HTTPS');
      await expect(assertSafeUrl(new URL('file:///etc/passwd'))).rejects.toThrow('Only HTTP and HTTPS');
    });

    it('should reject URLs with embedded credentials', async () => {
      await expect(assertSafeUrl(new URL('http://user:pass@example.com'))).rejects.toThrow('credentials');
    });

    it('should block localhost', async () => {
      await expect(assertSafeUrl(new URL('http://localhost'))).rejects.toThrow('blocked host');
    });

    it('should block 127.0.0.1', async () => {
      await expect(assertSafeUrl(new URL('http://127.0.0.1'))).rejects.toThrow('blocked host');
    });

    it('should block 0.0.0.0', async () => {
      await expect(assertSafeUrl(new URL('http://0.0.0.0'))).rejects.toThrow('blocked host');
    });

    it('should block ::1', async () => {
      await expect(assertSafeUrl(new URL('http://[::1]'))).rejects.toThrow('blocked host');
    });

    it('should block metadata endpoint', async () => {
      await expect(assertSafeUrl(new URL('http://169.254.169.254'))).rejects.toThrow('blocked host');
    });

    it('should block .local suffix', async () => {
      await expect(assertSafeUrl(new URL('http://myhost.local'))).rejects.toThrow('blocked host');
    });

    it('should block .internal suffix', async () => {
      await expect(assertSafeUrl(new URL('http://db.internal'))).rejects.toThrow('blocked host');
    });

    it('should block private IP 10.x', async () => {
      await expect(assertSafeUrl(new URL('http://10.0.0.1'))).rejects.toThrow('private');
    });

    it('should block private IP 192.168.x', async () => {
      await expect(assertSafeUrl(new URL('http://192.168.1.1'))).rejects.toThrow('private');
    });

    it('should block private IP 172.16-31.x', async () => {
      await expect(assertSafeUrl(new URL('http://172.16.0.1'))).rejects.toThrow('private');
      await expect(assertSafeUrl(new URL('http://172.31.255.255'))).rejects.toThrow('private');
    });

    it('should allow 172.32.x (not private)', async () => {
      mockLookup.mockResolvedValue([{ address: '172.32.0.1', family: 4 }] as never);
      // 172.32.x.x is not in private range — direct IP access
      await expect(assertSafeUrl(new URL('http://172.32.0.1'))).resolves.toBeUndefined();
    });

    it('should block DNS resolving to private IP', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
      await expect(assertSafeUrl(new URL('http://evil.example.com'))).rejects.toThrow('resolves to blocked');
    });

    it('should reject unresolvable hostname', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(assertSafeUrl(new URL('http://nonexistent.invalid'))).rejects.toThrow('Could not resolve');
    });
  });

  // ─── assertSafeRawUrl ────────────────────────────────────────────────────

  describe('assertSafeRawUrl', () => {
    it('should parse and validate a good URL', async () => {
      const url = await assertSafeRawUrl('https://example.com/page');
      expect(url.hostname).toBe('example.com');
    });

    it('should reject malformed URLs', async () => {
      await expect(assertSafeRawUrl('not-a-url')).rejects.toThrow('Invalid URL');
    });

    it('should reject unsafe URLs after parsing', async () => {
      await expect(assertSafeRawUrl('http://localhost:3000')).rejects.toThrow('blocked host');
    });
  });

  // ─── isPrivateIp ─────────────────────────────────────────────────────────

  describe('isPrivateIp', () => {
    const privateCases = [
      '0.0.0.0', '10.0.0.1', '10.255.255.255',
      '127.0.0.1', '127.255.255.255',
      '169.254.1.1',
      '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '192.168.255.255',
      '100.64.0.1', '100.127.255.255',
      '198.18.0.1', '198.19.255.255',
    ];

    for (const ip of privateCases) {
      it(`should detect ${ip} as private`, () => {
        expect(isPrivateIp(ip)).toBe(true);
      });
    }

    const publicCases = [
      '8.8.8.8', '93.184.216.34', '1.1.1.1',
      '172.32.0.1', '100.63.255.255', '198.20.0.1',
    ];

    for (const ip of publicCases) {
      it(`should detect ${ip} as public`, () => {
        expect(isPrivateIp(ip)).toBe(false);
      });
    }

    // IPv6
    it('should detect ::1 as private', () => {
      expect(isPrivateIp('::1')).toBe(true);
    });

    it('should detect :: as private', () => {
      expect(isPrivateIp('::')).toBe(true);
    });

    it('should detect fc00:: as private', () => {
      expect(isPrivateIp('fc00::1')).toBe(true);
    });

    it('should detect fd00:: as private', () => {
      expect(isPrivateIp('fd00::1')).toBe(true);
    });

    it('should detect fe80:: as private', () => {
      expect(isPrivateIp('fe80::1')).toBe(true);
    });

    it('should detect ::ffff:127.0.0.1 as private', () => {
      expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('should detect ::ffff:10.0.0.1 as private', () => {
      expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    });

    it('should detect ::ffff:192.168.1.1 as private', () => {
      expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    });

    it('should detect non-private IPv6 as public', () => {
      expect(isPrivateIp('2001:db8::1')).toBe(false);
    });

    it('should return false for non-IP strings', () => {
      expect(isPrivateIp('example.com')).toBe(false);
    });
  });

  // ─── isRedirectStatus ────────────────────────────────────────────────────

  describe('isRedirectStatus', () => {
    it('should detect redirect status codes', () => {
      expect(isRedirectStatus(301)).toBe(true);
      expect(isRedirectStatus(302)).toBe(true);
      expect(isRedirectStatus(303)).toBe(true);
      expect(isRedirectStatus(307)).toBe(true);
      expect(isRedirectStatus(308)).toBe(true);
    });

    it('should reject non-redirect status codes', () => {
      expect(isRedirectStatus(200)).toBe(false);
      expect(isRedirectStatus(404)).toBe(false);
      expect(isRedirectStatus(500)).toBe(false);
    });
  });
});
