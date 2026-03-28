import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default execution timeout (15 seconds) */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum timeout a user can request */
const MAX_TIMEOUT_MS = 60_000;

/** Maximum script length */
const MAX_SCRIPT_LENGTH = 10_000;

/** Maximum output length returned to LLM */
const MAX_OUTPUT_LENGTH = 12_000;

/**
 * Blocked patterns — dangerous AppleScript/JXA operations.
 * These prevent the LLM from accidentally running destructive commands.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  // File deletion / disk operations
  /\bdelete\s+(every\s+)?(?:file|folder|disk|item)/i,
  /\bempty\s+(the\s+)?trash\b/i,
  /\bermove\s+(the\s+)?trash\b/i,
  /\bdo\s+shell\s+script\s*"[^"]*\brm\s/i,
  /\bdo\s+shell\s+script\s*"[^"]*\bsudo\b/i,
  /\bdo\s+shell\s+script\s*"[^"]*\bmkfs\b/i,
  /\bdo\s+shell\s+script\s*"[^"]*\bdd\s/i,
  /\bdo\s+shell\s+script\s*"[^"]*\bformat\b/i,
  // Keystroke injection of passwords / credentials
  /keystroke\s+.*(?:password|passwd|secret|token|api.?key)/i,
  // System modification
  /\bshutdown\b/i,
  /\brestart\b/i,
  /\bsystem\s+preferences\b.*\bsecurity\b/i,
  // Network exfiltration via shell
  /\bdo\s+shell\s+script\s*"[^"]*\bcurl\b[^"]*\b(?:password|secret|token|api.?key)/i,
];

/**
 * Blocked JXA patterns (JavaScript for Automation).
 */
const BLOCKED_JXA_PATTERNS: RegExp[] = [
  /\brequire\s*\(\s*['"]child_process['"]\s*\)/i,
  /\bexecSync\b/i,
  /\bspawnSync\b/i,
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /\b\$\.(NSTask|NSAppleScript)\b/i,
  /\bObjC\.import\s*\(\s*['"]stdlib['"]\)/i,
];

// ─── Tool ────────────────────────────────────────────────────────────────────

@Injectable()
export class AppleScriptTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(AppleScriptTool.name);
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  readonly definition: ToolDefinition = {
    name: 'applescript',
    description:
      'Execute AppleScript or JavaScript for Automation (JXA) on macOS.\n\n' +
      'Use this for macOS automation:\n' +
      '- Control applications (Finder, Safari, Music, Calendar, Reminders, Notes, etc.)\n' +
      '- Get system information (active app, screen resolution, battery, Wi-Fi, etc.)\n' +
      '- Manage windows and workspaces\n' +
      '- Display dialogs and notifications\n' +
      '- Clipboard manipulation via AppleScript\n' +
      '- Open URLs, files, applications\n\n' +
      'Languages:\n' +
      '- applescript: Classic AppleScript syntax\n' +
      '- jxa: JavaScript for Automation (more modern, uses JXA runtime)\n\n' +
      'Only available on macOS. Some operations may require Accessibility permissions.',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The AppleScript or JXA code to execute.',
        },
        language: {
          type: 'string',
          enum: ['applescript', 'jxa'],
          description: 'Script language: "applescript" (default) or "jxa" (JavaScript for Automation).',
        },
        timeout_ms: {
          type: 'number',
          description: `Execution timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}ms, max: ${MAX_TIMEOUT_MS}ms.`,
        },
      },
      required: ['script'],
    },
    safety: 'moderate',
    timeoutMs: MAX_TIMEOUT_MS,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('tools.applescript.enabled', true);
    this.timeoutMs = this.configService.get<number>('tools.applescript.timeoutMs', DEFAULT_TIMEOUT_MS);
  }

  onModuleInit(): void {
    if (os.platform() !== 'darwin') {
      this.logger.warn('applescript tool is only available on macOS — skipping registration');
      return;
    }

    if (!this.enabled) {
      this.logger.warn('applescript tool is disabled via config');
      return;
    }

    this.registry.register(this);
    this.logger.log('applescript tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    if (os.platform() !== 'darwin') {
      return 'Error: AppleScript is only available on macOS.';
    }

    const script = String(args.script ?? '').trim();
    const language = String(args.language ?? 'applescript').trim().toLowerCase();
    const timeout = Math.min(
      Math.max(Number(args.timeout_ms) || this.timeoutMs, 1000),
      MAX_TIMEOUT_MS,
    );

    // ─── Validation ──────────────────────────────────────────────────────

    if (!script) return 'Error: "script" is required.';

    if (script.length > MAX_SCRIPT_LENGTH) {
      return `Error: Script too long (${script.length} chars, max ${MAX_SCRIPT_LENGTH}).`;
    }

    if (language !== 'applescript' && language !== 'jxa') {
      return `Error: Unsupported language "${language}". Use "applescript" or "jxa".`;
    }

    // Safety checks
    const blockResult = this.checkBlocked(script, language);
    if (blockResult) return blockResult;

    // ─── Execution ───────────────────────────────────────────────────────

    try {
      const result = await this.runScript(script, language, timeout);
      return this.formatResult(language, result, timeout);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`applescript failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  // ─── Safety ──────────────────────────────────────────────────────────────

  private checkBlocked(script: string, language: string): string | null {
    const patterns = language === 'jxa'
      ? [...BLOCKED_PATTERNS, ...BLOCKED_JXA_PATTERNS]
      : BLOCKED_PATTERNS;

    for (const pattern of patterns) {
      if (pattern.test(script)) {
        return `Error: Script contains a blocked pattern for safety (matched: ${pattern.source.slice(0, 60)}). ` +
          'Rewrite the script to avoid dangerous operations.';
      }
    }

    return null;
  }

  // ─── Execution ───────────────────────────────────────────────────────────

  private runScript(
    script: string,
    language: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      const args = language === 'jxa'
        ? ['-l', 'JavaScript', '-e', script]
        : ['-e', script];

      let settled = false;

      const child = execFile('osascript', args, {
        timeout,
        maxBuffer: 1024 * 1024, // 1 MB
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? 'en_US.UTF-8',
        },
      }, (error, stdout, stderr) => {
        if (settled) return;
        settled = true;

        const exitCode = error?.code ?? (error ? 1 : 0);
        const timedOut = error?.killed === true;

        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          timedOut,
        });
      });

      // Safety net
      const killTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, timeout + 3_000);
      killTimer.unref();
    });
  }

  // ─── Formatting ──────────────────────────────────────────────────────────

  private formatResult(
    language: string,
    result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean },
    timeout: number,
  ): string {
    const lines: string[] = [
      `Language: ${language}`,
      `Exit code: ${result.exitCode}`,
    ];

    if (result.timedOut) {
      lines.push(`⚠ Execution timed out after ${timeout}ms`);
    }

    if (result.stdout.trim()) {
      lines.push('', '--- output ---', truncate(result.stdout.trim(), MAX_OUTPUT_LENGTH));
    }

    if (result.stderr.trim()) {
      lines.push('', '--- stderr ---', truncate(result.stderr.trim(), MAX_OUTPUT_LENGTH / 2));
    }

    if (!result.stdout.trim() && !result.stderr.trim() && result.exitCode === 0) {
      lines.push('', '(script executed successfully with no output)');
    }

    return lines.join('\n');
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 50) + `\n\n... (truncated, ${text.length} total chars)`;
}
