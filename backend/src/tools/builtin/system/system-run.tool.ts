import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'node:child_process';
import * as path from 'node:path';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

/** Default timeout for command execution */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Maximum output length returned to the LLM */
const MAX_OUTPUT_LENGTH = 10_000;
/** Maximum command length */
const MAX_COMMAND_LENGTH = 2_000;

/**
 * Commands/patterns that are blocked outright.
 * Matched against the raw command string (case-insensitive).
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*f[a-z]*\s+)?\/(?!\w)/i,   // rm -rf / or rm /
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\//i,                     // dd of=/dev/...
  /\bformat\b.*[a-z]:/i,                      // format C:
  /:(){ :|:& };:/,                             // fork bomb
  /\b>\s*\/dev\/sd[a-z]/i,                     // > /dev/sda
  /\bchmod\s+(-[a-z]*\s+)?777\s+\//i,         // chmod 777 /
  /\bchown\s+.*\s+\/(?!\w)/i,                  // chown ... /
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\binit\s+0\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bpasswd\b/i,
  /\blaunchctl\b/i,
];

const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(?:^|\s)\/?(?:etc|System|Library|private|dev|proc|sys)\//i,
  /(?:^|\s)~?\/\.?(?:ssh|gnupg|aws|kube)(?:\/|\s|$)/i,
  /(?:^|\s)~?\/.*(?:\.env(?:\.(?:local|development|production|staging|test))?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\s]+\.(?:pem|key|p12|pfx))(?:\s|$)/i,
  /(?:127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|localhost)/i,
];

@Injectable()
export class SystemRunTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(SystemRunTool.name);
  private readonly timeoutMs: number;
  private readonly workingDirectory: string;
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'system_run',
    description:
      'Execute a shell command on the host machine and return stdout, stderr, and exit code. Use this for system tasks like checking disk space, listing files, running scripts, installing packages, git operations, etc. Commands run in a shell (bash/zsh). Some destructive commands are blocked for safety.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g. "ls -la", "df -h", "git status").',
        },
        working_directory: {
          type: 'string',
          description: 'Optional working directory for the command. Defaults to the configured workspace directory.',
        },
        timeout_ms: {
          type: 'number',
          description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}ms. Max ${DEFAULT_TIMEOUT_MS * 2}ms.`,
        },
      },
      required: ['command'],
    },
    safety: 'moderate',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('tools.systemRun.enabled', true);
    this.timeoutMs = this.configService.get<number>('tools.systemRun.timeoutMs', DEFAULT_TIMEOUT_MS);
    this.workingDirectory = this.configService.get<string>('tools.systemRun.workingDirectory', process.cwd());
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('system_run tool is disabled via config');
      return;
    }
    this.registry.register(this);
    this.logger.log('system_run tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '').trim();
    const timeout = Math.min(
      Number(args.timeout_ms) || this.timeoutMs,
      this.timeoutMs * 2,
    );

    // ─── Validation ──────────────────────────────────────────────────────────

    if (!command) {
      return 'Error: No command provided.';
    }

    if (command.length > MAX_COMMAND_LENGTH) {
      return `Error: Command too long (${command.length} chars, max ${MAX_COMMAND_LENGTH}).`;
    }

    let cwd: string;
    try {
      cwd = this.resolveWorkingDirectory(String(args.working_directory ?? '').trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }

    const blocked = this.isBlocked(command);
    if (blocked) {
      this.logger.warn(`Blocked dangerous command: "${command}"`);
      return `Error: Command blocked for safety. Pattern matched: ${blocked}. If you believe this is a false positive, ask the user to run it manually.`;
    }

    // ─── Execution ───────────────────────────────────────────────────────────

    this.logger.log(`Executing: "${truncate(command, 200)}" in ${cwd}`);

    try {
      const result = await this.execCommand(command, cwd, timeout);

      const lines: string[] = [
        `Command: ${command}`,
        `Working directory: ${cwd}`,
        `Exit code: ${result.exitCode}`,
      ];

      if (result.stdout) {
        lines.push('', '--- stdout ---', truncate(result.stdout.trim(), MAX_OUTPUT_LENGTH));
      }

      if (result.stderr) {
        lines.push('', '--- stderr ---', truncate(result.stderr.trim(), MAX_OUTPUT_LENGTH / 2));
      }

      if (result.timedOut) {
        lines.push('', `⚠ Command timed out after ${timeout}ms`);
      }

      return lines.join('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Command execution failed: ${message}`);
      return `Error executing command: ${message}`;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private isBlocked(command: string): string | null {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return pattern.source;
      }
    }

    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(command)) {
        return pattern.source;
      }
    }

    return null;
  }

  private resolveWorkingDirectory(requestedCwd: string): string {
    const target = requestedCwd
      ? path.isAbsolute(requestedCwd)
        ? path.normalize(requestedCwd)
        : path.resolve(this.workingDirectory, requestedCwd)
      : this.workingDirectory;

    const relative = path.relative(this.workingDirectory, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`working_directory must stay within ${this.workingDirectory}`);
    }

    return target;
  }

  private execCommand(
    command: string,
    cwd: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      const cleanEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: this.workingDirectory,
        USERPROFILE: this.workingDirectory,
        TMPDIR: this.workingDirectory,
        TEMP: this.workingDirectory,
        TMP: this.workingDirectory,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PAGER: 'cat',
      };

      if (process.platform === 'win32') {
        cleanEnv.SYSTEMROOT = process.env.SYSTEMROOT ?? 'C:\\Windows';
        cleanEnv.ComSpec = process.env.ComSpec ?? 'cmd.exe';
      }

      let settled = false;
      const killTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, timeout + 5_000);

      const child = exec(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        shell: process.platform === 'win32'
          ? process.env.ComSpec ?? 'cmd.exe'
          : process.env.SHELL ?? '/bin/bash',
        env: cleanEnv,
      }, (error, stdout, stderr) => {
        settled = true;
        clearTimeout(killTimer);

        const exitCode = error?.code ?? (error ? 1 : 0);
        const timedOut = error?.killed === true;

        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          timedOut,
        });
      });
    });
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 50) + `\n\n... (truncated, ${text.length} total chars)`;
}
