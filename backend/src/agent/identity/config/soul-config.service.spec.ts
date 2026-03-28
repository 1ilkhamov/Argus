import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { SoulConfigService } from './soul-config.service';
import {
  type SoulConfig,
  validateSoulConfig,
  isSoulConfigError,
} from './soul-config.types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  } as unknown as import('@nestjs/config').ConfigService;
}

function createService(overrides: Record<string, unknown> = {}): SoulConfigService {
  const service = new SoulConfigService(makeConfigService(overrides));
  service.onModuleInit();
  return service;
}

// ─── Validation tests ───────────────────────────────────────────────────────

describe('validateSoulConfig', () => {
  const validConfig = {
    name: 'Argus',
    role: 'an AI assistant',
    mission: ['Help users'],
    personality: ['Direct and clear'],
    invariants: ['Be helpful'],
    never: ['Start with filler'],
    values: ['Accuracy over speed'],
    interactionContract: ['Answer directly'],
    antiGoals: ['fake certainty'],
  };

  it('accepts a valid config', () => {
    const result = validateSoulConfig(validConfig);
    expect(isSoulConfigError(result)).toBe(false);
    const config = result as SoulConfig;
    expect(config.name).toBe('Argus');
    expect(config.role).toBe('an AI assistant');
    expect(config.personality).toEqual(['Direct and clear']);
    expect(config.defaultBehavior.initiative).toBe('medium');
  });

  it('accepts custom defaultBehavior', () => {
    const result = validateSoulConfig({
      ...validConfig,
      defaultBehavior: {
        initiative: 'high',
        assertiveness: 'low',
        warmth: 'high',
        verbosity: 'concise',
      },
    });
    expect(isSoulConfigError(result)).toBe(false);
    const config = result as SoulConfig;
    expect(config.defaultBehavior).toEqual({
      initiative: 'high',
      assertiveness: 'low',
      warmth: 'high',
      verbosity: 'concise',
    });
  });

  it('rejects null', () => {
    const result = validateSoulConfig(null);
    expect(isSoulConfigError(result)).toBe(true);
  });

  it('rejects missing name', () => {
    const result = validateSoulConfig({ ...validConfig, name: '' });
    expect(isSoulConfigError(result)).toBe(true);
  });

  it('rejects missing role', () => {
    const result = validateSoulConfig({ ...validConfig, role: undefined });
    expect(isSoulConfigError(result)).toBe(true);
  });

  it('rejects empty mission array', () => {
    const result = validateSoulConfig({ ...validConfig, mission: [] });
    expect(isSoulConfigError(result)).toBe(true);
  });

  it('rejects mission with empty strings', () => {
    const result = validateSoulConfig({ ...validConfig, mission: ['  '] });
    expect(isSoulConfigError(result)).toBe(true);
  });

  it.each([
    'personality', 'invariants', 'never', 'values', 'interactionContract', 'antiGoals',
  ] as const)('rejects missing %s', (key) => {
    const result = validateSoulConfig({ ...validConfig, [key]: undefined });
    expect(isSoulConfigError(result)).toBe(true);
  });

  it('trims whitespace from all string fields', () => {
    const result = validateSoulConfig({
      ...validConfig,
      name: '  Argus  ',
      role: '  role  ',
      mission: ['  mission  '],
      personality: ['  trait  '],
    });
    expect(isSoulConfigError(result)).toBe(false);
    const config = result as SoulConfig;
    expect(config.name).toBe('Argus');
    expect(config.role).toBe('role');
    expect(config.mission).toEqual(['mission']);
    expect(config.personality).toEqual(['trait']);
  });

  it('ignores invalid behavior level values', () => {
    const result = validateSoulConfig({
      ...validConfig,
      defaultBehavior: { initiative: 'extreme', assertiveness: 'medium' },
    });
    expect(isSoulConfigError(result)).toBe(false);
    const config = result as SoulConfig;
    expect(config.defaultBehavior.initiative).toBe('medium'); // kept default
    expect(config.defaultBehavior.assertiveness).toBe('medium');
  });
});

// ─── Service tests ──────────────────────────────────────────────────────────

describe('SoulConfigService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the bundled default soul.yml from source', () => {
    const service = createService();
    const config = service.getSoulConfig();

    expect(config.name).toBe('Argus');
    expect(config.role).toContain('intelligent');
    expect(config.mission.length).toBeGreaterThan(0);
    expect(config.personality.length).toBeGreaterThan(0);
    expect(config.invariants.length).toBeGreaterThan(0);
    expect(config.never.length).toBeGreaterThan(0);
    expect(config.values.length).toBeGreaterThan(0);
    expect(config.interactionContract.length).toBeGreaterThan(0);
    expect(config.antiGoals.length).toBeGreaterThan(0);

    service.onModuleDestroy();
  });

  it('falls back to core-contract when no soul file exists', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    const service = createService();
    const config = service.getSoulConfig();

    expect(config.name).toBe('Argus');
    expect(config.invariants.length).toBeGreaterThan(0);

    service.onModuleDestroy();
  });

  it('loads from a custom path when configured', () => {
    const tmpDir = path.join(__dirname, '__test_tmp__');
    const tmpPath = path.join(tmpDir, 'custom-soul.yml');

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpPath, yaml.dump({
      name: 'CustomAgent',
      role: 'a custom assistant',
      mission: ['Custom mission'],
      personality: ['Custom trait'],
      invariants: ['Be custom'],
      never: ['Be boring'],
      values: ['Fun over boring'],
      interactionContract: ['Be awesome'],
      antiGoals: ['boredom'],
    }));

    try {
      const service = createService({ 'soul.configPath': tmpPath });
      const config = service.getSoulConfig();

      expect(config.name).toBe('CustomAgent');
      expect(config.role).toBe('a custom assistant');
      expect(config.personality).toEqual(['Custom trait']);

      service.onModuleDestroy();
    } finally {
      fs.unlinkSync(tmpPath);
      fs.rmdirSync(tmpDir);
    }
  });

  it('ignores invalid custom config and falls back', () => {
    const tmpDir = path.join(__dirname, '__test_tmp__');
    const tmpPath = path.join(tmpDir, 'bad-soul.yml');

    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpPath, yaml.dump({ name: '', role: '' }));

    try {
      const service = createService({ 'soul.configPath': tmpPath });
      const config = service.getSoulConfig();

      // Should fall back to default or core-contract
      expect(config.name).toBe('Argus');

      service.onModuleDestroy();
    } finally {
      fs.unlinkSync(tmpPath);
      fs.rmdirSync(tmpDir);
    }
  });
});

// ─── Default YAML file validity ─────────────────────────────────────────────

describe('soul.default.yml', () => {
  it('is valid YAML that passes validation', () => {
    const defaultPath = path.join(__dirname, 'soul.default.yml');
    const raw = fs.readFileSync(defaultPath, 'utf-8');
    const parsed = yaml.load(raw);
    const result = validateSoulConfig(parsed);

    expect(isSoulConfigError(result)).toBe(false);
    const config = result as SoulConfig;
    expect(config.name).toBe('Argus');
    expect(config.personality.length).toBeGreaterThanOrEqual(3);
    expect(config.never.length).toBeGreaterThanOrEqual(3);
    expect(config.values.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Prompt builder integration ─────────────────────────────────────────────

describe('buildPersonalitySection integration', () => {
  it('personality section appears in built prompt when SoulConfigService is available', () => {
    // Import dynamically to avoid circular issues
    const { buildPersonalitySection } = require('../../prompt/sections');

    const soul: SoulConfig = {
      name: 'TestAgent',
      role: 'test role',
      mission: ['test'],
      personality: ['Be direct', 'Be honest'],
      invariants: ['invariant'],
      never: ['Do not lie', 'Do not hedge'],
      values: ['Truth over comfort'],
      defaultBehavior: { initiative: 'medium', assertiveness: 'medium', warmth: 'medium', verbosity: 'adaptive' },
      interactionContract: ['contract'],
      antiGoals: ['bad'],
    };

    const section = buildPersonalitySection(soul);

    expect(section).toContain('Core personality: Be direct Be honest');
    expect(section).toContain('Never: Do not lie; Do not hedge.');
    expect(section).toContain('Values: Truth over comfort.');
  });

  it('personality section is empty when soul has no personality/never/values', () => {
    const { buildPersonalitySection } = require('../../prompt/sections');

    const emptySoul: SoulConfig = {
      name: 'X',
      role: 'x',
      mission: ['x'],
      personality: [],
      invariants: ['x'],
      never: [],
      values: [],
      defaultBehavior: { initiative: 'medium', assertiveness: 'medium', warmth: 'medium', verbosity: 'adaptive' },
      interactionContract: ['x'],
      antiGoals: ['x'],
    };

    const section = buildPersonalitySection(emptySoul);
    expect(section).toEqual([]);
  });
});
