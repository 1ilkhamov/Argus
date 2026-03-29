import type { AgentBehaviorLevel, AgentVerbosity } from '../../core-contract';

// ─── Soul Config ──────────────────────────────────────────────────────────────

export interface SoulConfig {
  /** Agent display name */
  name: string;

  /** One-line role description */
  role: string;

  /** Core mission statements (1-3 lines) */
  mission: string[];

  /** Personality traits — concrete, actionable character descriptions */
  personality: string[];

  /** Hard invariants — never overridden by memory, mode, or user preference */
  invariants: string[];

  /** Anti-patterns — specific behaviors to avoid (concrete, not abstract) */
  never: string[];

  /** Values — prioritization rules when goals conflict */
  values: string[];

  /** Baseline behavior levels */
  defaultBehavior: {
    initiative: AgentBehaviorLevel;
    assertiveness: AgentBehaviorLevel;
    warmth: AgentBehaviorLevel;
    verbosity: AgentVerbosity;
  };

  /** Interaction contract — rules of engagement with the user */
  interactionContract: string[];

  /** Anti-goals — high-level things to avoid (servility, fake certainty, etc.) */
  antiGoals: string[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_BEHAVIOR_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_VERBOSITY = new Set(['adaptive', 'concise', 'detailed']);

export function validateSoulConfig(raw: unknown): SoulConfig | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Soul config must be a non-null object' };
  }

  const obj = raw as Record<string, unknown>;

  // Required strings
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return { error: 'Soul config: name is required (non-empty string)' };
  }
  if (typeof obj.role !== 'string' || !obj.role.trim()) {
    return { error: 'Soul config: role is required (non-empty string)' };
  }

  // Required string arrays
  const requiredArrays: (keyof SoulConfig)[] = [
    'mission', 'personality', 'invariants', 'never', 'values',
    'interactionContract', 'antiGoals',
  ];

  for (const key of requiredArrays) {
    const val = obj[key];
    if (!Array.isArray(val) || val.length === 0) {
      return { error: `Soul config: ${key} is required (non-empty string array)` };
    }
    if (!val.every((item) => typeof item === 'string' && item.trim().length > 0)) {
      return { error: `Soul config: ${key} must contain only non-empty strings` };
    }
  }

  // Optional defaultBehavior
  const defaultBehavior: SoulConfig['defaultBehavior'] = {
    initiative: 'medium',
    assertiveness: 'medium',
    warmth: 'medium',
    verbosity: 'adaptive',
  };

  if (obj.defaultBehavior && typeof obj.defaultBehavior === 'object') {
    const b = obj.defaultBehavior as Record<string, unknown>;
    if (typeof b.initiative === 'string' && VALID_BEHAVIOR_LEVELS.has(b.initiative)) {
      defaultBehavior.initiative = b.initiative as AgentBehaviorLevel;
    }
    if (typeof b.assertiveness === 'string' && VALID_BEHAVIOR_LEVELS.has(b.assertiveness)) {
      defaultBehavior.assertiveness = b.assertiveness as AgentBehaviorLevel;
    }
    if (typeof b.warmth === 'string' && VALID_BEHAVIOR_LEVELS.has(b.warmth)) {
      defaultBehavior.warmth = b.warmth as AgentBehaviorLevel;
    }
    if (typeof b.verbosity === 'string' && VALID_VERBOSITY.has(b.verbosity)) {
      defaultBehavior.verbosity = b.verbosity as AgentVerbosity;
    }
  }

  return {
    name: (obj.name as string).trim(),
    role: (obj.role as string).trim(),
    mission: (obj.mission as string[]).map((s) => s.trim()),
    personality: (obj.personality as string[]).map((s) => s.trim()),
    invariants: (obj.invariants as string[]).map((s) => s.trim()),
    never: (obj.never as string[]).map((s) => s.trim()),
    values: (obj.values as string[]).map((s) => s.trim()),
    defaultBehavior,
    interactionContract: (obj.interactionContract as string[]).map((s) => s.trim()),
    antiGoals: (obj.antiGoals as string[]).map((s) => s.trim()),
  };
}

export function isSoulConfigError(result: SoulConfig | { error: string }): result is { error: string } {
  return 'error' in result;
}
