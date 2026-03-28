import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ToolSafetyLevel } from '../tool.types';

/**
 * Safety policy determines the maximum allowed safety level for tool execution.
 *
 * - permissive: all safety levels are allowed (local-first default)
 * - standard:   safe + moderate are allowed; dangerous tools are blocked
 * - strict:     only safe tools are allowed; moderate + dangerous are blocked
 */
export type ToolSafetyPolicy = 'permissive' | 'standard' | 'strict';

export interface ToolSafetyDecision {
  allowed: boolean;
  reason?: string;
}

const ALLOWED_LEVELS: Record<ToolSafetyPolicy, ReadonlySet<ToolSafetyLevel>> = {
  permissive: new Set(['safe', 'moderate', 'dangerous']),
  standard: new Set(['safe', 'moderate']),
  strict: new Set(['safe']),
};

const VALID_POLICIES = new Set<string>(['permissive', 'standard', 'strict']);

/**
 * Centralized tool safety enforcement.
 *
 * Evaluates whether a tool is permitted to execute based on:
 * 1. Global safety policy (permissive / standard / strict)
 * 2. Explicit blocklist (always denied regardless of policy)
 * 3. Explicit allowlist (overrides policy for specific tools)
 *
 * Used by ToolExecutorService (pre-execution gate) and
 * ToolRegistryService (filters definitions exposed to LLM).
 */
@Injectable()
export class ToolSafetyService {
  private readonly logger = new Logger(ToolSafetyService.name);
  readonly policy: ToolSafetyPolicy;
  private readonly blockedNames: ReadonlySet<string>;
  private readonly allowedNames: ReadonlySet<string>;

  constructor(private readonly configService: ConfigService) {
    const rawPolicy = (
      this.configService.get<string>('tools.safetyPolicy', 'permissive') ?? 'permissive'
    ).trim().toLowerCase();

    this.policy = VALID_POLICIES.has(rawPolicy)
      ? (rawPolicy as ToolSafetyPolicy)
      : 'permissive';

    if (!VALID_POLICIES.has(rawPolicy)) {
      this.logger.warn(
        `Invalid TOOLS_SAFETY_POLICY="${rawPolicy}", falling back to "permissive"`,
      );
    }

    this.blockedNames = new Set(
      this.parseNameList(this.configService.get<string>('tools.blockedNames', '')),
    );

    this.allowedNames = new Set(
      this.parseNameList(this.configService.get<string>('tools.allowedNames', '')),
    );

    this.logger.log(
      `Tool safety policy: ${this.policy}` +
        (this.blockedNames.size ? ` | blocked: ${[...this.blockedNames].join(', ')}` : '') +
        (this.allowedNames.size ? ` | allowed: ${[...this.allowedNames].join(', ')}` : ''),
    );
  }

  /**
   * Evaluate whether a tool is allowed to execute.
   */
  evaluate(toolName: string, safetyLevel: ToolSafetyLevel): ToolSafetyDecision {
    // 1. Explicit blocklist — always wins
    if (this.blockedNames.has(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is explicitly blocked via TOOLS_BLOCKED_NAMES`,
      };
    }

    // 2. Explicit allowlist — overrides policy
    if (this.allowedNames.has(toolName)) {
      return { allowed: true };
    }

    // 3. Policy-based evaluation
    const allowedLevels = ALLOWED_LEVELS[this.policy];
    if (!allowedLevels.has(safetyLevel)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" (safety=${safetyLevel}) is blocked by policy "${this.policy}"`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a tool should be visible to the LLM (included in definitions).
   * Uses the same logic as evaluate — hidden tools cannot be called.
   */
  isVisible(toolName: string, safetyLevel: ToolSafetyLevel): boolean {
    return this.evaluate(toolName, safetyLevel).allowed;
  }

  private parseNameList(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
}
