import { ConfigService } from '@nestjs/config';

import { ToolSafetyService } from './tool-safety.service';

const createConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
  const config: Record<string, unknown> = {
    'tools.safetyPolicy': 'permissive',
    'tools.blockedNames': '',
    'tools.allowedNames': '',
    ...overrides,
  };

  return { get: jest.fn((key: string, def?: unknown) => config[key] ?? def) } as unknown as ConfigService;
};

describe('ToolSafetyService', () => {
  // ── Policy: permissive ─────────────────────────────────────────────────────

  describe('permissive policy (default)', () => {
    let service: ToolSafetyService;

    beforeEach(() => {
      service = new ToolSafetyService(createConfigService());
    });

    it('allows safe tools', () => {
      expect(service.evaluate('web_search', 'safe').allowed).toBe(true);
    });

    it('allows moderate tools', () => {
      expect(service.evaluate('system_run', 'moderate').allowed).toBe(true);
    });

    it('allows dangerous tools', () => {
      expect(service.evaluate('process', 'dangerous').allowed).toBe(true);
    });

    it('reports permissive policy', () => {
      expect(service.policy).toBe('permissive');
    });
  });

  // ── Policy: standard ───────────────────────────────────────────────────────

  describe('standard policy', () => {
    let service: ToolSafetyService;

    beforeEach(() => {
      service = new ToolSafetyService(
        createConfigService({ 'tools.safetyPolicy': 'standard' }),
      );
    });

    it('allows safe tools', () => {
      expect(service.evaluate('web_search', 'safe').allowed).toBe(true);
    });

    it('allows moderate tools', () => {
      expect(service.evaluate('system_run', 'moderate').allowed).toBe(true);
    });

    it('blocks dangerous tools', () => {
      const decision = service.evaluate('process', 'dangerous');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('blocked by policy "standard"');
    });
  });

  // ── Policy: strict ─────────────────────────────────────────────────────────

  describe('strict policy', () => {
    let service: ToolSafetyService;

    beforeEach(() => {
      service = new ToolSafetyService(
        createConfigService({ 'tools.safetyPolicy': 'strict' }),
      );
    });

    it('allows safe tools', () => {
      expect(service.evaluate('web_search', 'safe').allowed).toBe(true);
    });

    it('blocks moderate tools', () => {
      const decision = service.evaluate('system_run', 'moderate');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('blocked by policy "strict"');
    });

    it('blocks dangerous tools', () => {
      const decision = service.evaluate('process', 'dangerous');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('blocked by policy "strict"');
    });
  });

  // ── Invalid policy falls back to permissive ────────────────────────────────

  it('falls back to permissive for invalid policy value', () => {
    const service = new ToolSafetyService(
      createConfigService({ 'tools.safetyPolicy': 'yolo' }),
    );
    expect(service.policy).toBe('permissive');
    expect(service.evaluate('process', 'dangerous').allowed).toBe(true);
  });

  // ── Blocklist ──────────────────────────────────────────────────────────────

  describe('blocklist', () => {
    it('blocks a tool by name regardless of safety level', () => {
      const service = new ToolSafetyService(
        createConfigService({ 'tools.blockedNames': 'process, system_run' }),
      );

      expect(service.evaluate('process', 'safe').allowed).toBe(false);
      expect(service.evaluate('system_run', 'safe').allowed).toBe(false);
      expect(service.evaluate('web_search', 'safe').allowed).toBe(true);
    });

    it('blocklist reason mentions TOOLS_BLOCKED_NAMES', () => {
      const service = new ToolSafetyService(
        createConfigService({ 'tools.blockedNames': 'process' }),
      );
      const decision = service.evaluate('process', 'dangerous');
      expect(decision.reason).toContain('TOOLS_BLOCKED_NAMES');
    });

    it('blocklist wins over allowlist', () => {
      const service = new ToolSafetyService(
        createConfigService({
          'tools.blockedNames': 'process',
          'tools.allowedNames': 'process',
        }),
      );
      expect(service.evaluate('process', 'dangerous').allowed).toBe(false);
    });
  });

  // ── Allowlist ──────────────────────────────────────────────────────────────

  describe('allowlist', () => {
    it('allows a tool that would be blocked by policy', () => {
      const service = new ToolSafetyService(
        createConfigService({
          'tools.safetyPolicy': 'strict',
          'tools.allowedNames': 'system_run',
        }),
      );
      expect(service.evaluate('system_run', 'moderate').allowed).toBe(true);
      // Other moderate tools remain blocked
      expect(service.evaluate('file_ops', 'moderate').allowed).toBe(false);
    });

    it('allows a dangerous tool under standard policy when allowlisted', () => {
      const service = new ToolSafetyService(
        createConfigService({
          'tools.safetyPolicy': 'standard',
          'tools.allowedNames': 'process',
        }),
      );
      expect(service.evaluate('process', 'dangerous').allowed).toBe(true);
    });
  });

  // ── isVisible ──────────────────────────────────────────────────────────────

  describe('isVisible', () => {
    it('returns true for allowed tools', () => {
      const service = new ToolSafetyService(createConfigService());
      expect(service.isVisible('web_search', 'safe')).toBe(true);
    });

    it('returns false for blocked tools', () => {
      const service = new ToolSafetyService(
        createConfigService({
          'tools.safetyPolicy': 'strict',
        }),
      );
      expect(service.isVisible('system_run', 'moderate')).toBe(false);
    });
  });

  // ── Name parsing ───────────────────────────────────────────────────────────

  it('handles comma-separated and newline-separated name lists', () => {
    const service = new ToolSafetyService(
      createConfigService({
        'tools.blockedNames': 'process,system_run\napplescript',
      }),
    );
    expect(service.evaluate('process', 'safe').allowed).toBe(false);
    expect(service.evaluate('system_run', 'safe').allowed).toBe(false);
    expect(service.evaluate('applescript', 'safe').allowed).toBe(false);
    expect(service.evaluate('web_search', 'safe').allowed).toBe(true);
  });

  it('handles empty/whitespace name lists gracefully', () => {
    const service = new ToolSafetyService(
      createConfigService({ 'tools.blockedNames': '  , ,  ' }),
    );
    expect(service.evaluate('process', 'safe').allowed).toBe(true);
  });
});
