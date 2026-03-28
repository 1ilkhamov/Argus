import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

/** Default execution timeout (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Maximum code length */
const MAX_CODE_LENGTH = 50_000;
/** Maximum output length returned to the LLM */
const MAX_OUTPUT_LENGTH = 12_000;
/** Maximum timeout a user can request */
const MAX_TIMEOUT_MS = 120_000;

type SupportedLanguage = 'python' | 'javascript' | 'typescript';

interface LanguageConfig {
  /** Command to execute the script file */
  command: string;
  /** Additional command-line arguments before the script path */
  args: string[];
  /** File extension for the temp script */
  ext: string;
  /** Preamble code injected before user code (e.g. sandbox helpers) */
  preamble: string;
}

/**
 * Resolves the interpreter command for each language, cross-platform (macOS, Linux, Windows).
 */
function resolveLanguageConfig(lang: SupportedLanguage): LanguageConfig {
  const isWindows = os.platform() === 'win32';

  switch (lang) {
    case 'python': {
      // Windows: python, macOS/Linux: python3 (fallback python)
      const cmd = isWindows ? 'python' : 'python3';
      return {
        command: cmd,
        args: ['-u'], // unbuffered output
        ext: '.py',
        preamble: [
          'import sys, os',
          'sys.stdout.reconfigure(line_buffering=True) if hasattr(sys.stdout, "reconfigure") else None',
          '',
        ].join('\n'),
      };
    }
    case 'javascript':
      return {
        command: 'node',
        args: ['--max-old-space-size=256'],
        ext: '.mjs',
        preamble: '',
      };
    case 'typescript':
      return {
        command: 'npx',
        args: ['tsx'],
        ext: '.ts',
        preamble: '',
      };
  }
}

/**
 * Code execution tool — run Python, JavaScript, or TypeScript code in an isolated subprocess.
 *
 * Cross-platform: works on macOS, Linux, and Windows.
 * Sandbox: temp directory, timeout, output cap, no inherited env secrets.
 */
@Injectable()
export class CodeExecTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(CodeExecTool.name);
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'code_exec',
    description:
      'Execute code (Python, JavaScript, or TypeScript) and return the output.\n\n' +
      'Use this for:\n' +
      '- Complex calculations, data analysis, statistics\n' +
      '- Data transformation (CSV, JSON parsing/filtering)\n' +
      '- String manipulation, regex testing\n' +
      '- Generating charts/plots (matplotlib → saved as file)\n' +
      '- Quick prototyping and code validation\n' +
      '- Any task that benefits from actual code execution\n\n' +
      'Code runs in a temp directory with a timeout. stdout and stderr are captured.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'typescript'],
          description: 'Programming language to use.',
        },
        code: {
          type: 'string',
          description: 'The code to execute. Use print()/console.log() for output.',
        },
        timeout_ms: {
          type: 'number',
          description: `Execution timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}ms, max: ${MAX_TIMEOUT_MS}ms.`,
        },
      },
      required: ['language', 'code'],
    },
    safety: 'moderate',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {
    this.timeoutMs = this.configService.get<number>('tools.codeExec.timeoutMs', DEFAULT_TIMEOUT_MS);
    this.enabled = this.configService.get<boolean>('tools.codeExec.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('code_exec tool is disabled via config');
      return;
    }
    this.registry.register(this);
    this.logger.log('code_exec tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const language = String(args.language ?? '').trim() as SupportedLanguage;
    const code = String(args.code ?? '');
    const timeout = Math.min(
      Math.max(Number(args.timeout_ms) || this.timeoutMs, 1000),
      MAX_TIMEOUT_MS,
    );

    // ─── Validation ──────────────────────────────────────────────────────

    if (!['python', 'javascript', 'typescript'].includes(language)) {
      return `Error: Unsupported language "${language}". Supported: python, javascript, typescript.`;
    }

    if (!code.trim()) {
      return 'Error: No code provided.';
    }

    if (code.length > MAX_CODE_LENGTH) {
      return `Error: Code too long (${code.length} chars, max ${MAX_CODE_LENGTH}).`;
    }

    // ─── Execution ───────────────────────────────────────────────────────

    const config = resolveLanguageConfig(language);
    const tmpDir = await this.createTempDir();

    try {
      const scriptPath = path.join(tmpDir, `script${config.ext}`);
      const fullCode = config.preamble ? config.preamble + code : code;
      await fs.writeFile(scriptPath, fullCode, 'utf-8');

      this.logger.log(`Executing ${language} code (${code.length} chars, timeout=${timeout}ms)`);

      const result = await this.runScript(config.command, [...config.args, scriptPath], tmpDir, timeout);

      // Check for generated files (charts, outputs, etc.)
      const generatedFiles = await this.listGeneratedFiles(tmpDir, scriptPath);

      return this.formatResult(language, code, result, generatedFiles, timeout);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`code_exec failed: ${msg}`);
      return `Error: ${msg}`;
    } finally {
      // Clean up temp directory
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async createTempDir(): Promise<string> {
    const prefix = path.join(os.tmpdir(), 'argus-code-');
    return fs.mkdtemp(prefix);
  }

  private runScript(
    command: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      const homeDir = path.join(cwd, 'home');
      const cacheDir = path.join(cwd, '.cache');

      // Build a clean env: inherit only what is needed to locate runtimes,
      // but do not expose the real user home or secret-bearing env vars.
      const cleanEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: homeDir,
        TMPDIR: cwd,
        TEMP: cwd,
        TMP: cwd,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        USERPROFILE: homeDir,
        XDG_CONFIG_HOME: homeDir,
        XDG_CACHE_HOME: cacheDir,
        npm_config_cache: path.join(cwd, '.npm-cache'),
        PYTHONPYCACHEPREFIX: cacheDir,
      };

      // Windows needs additional env vars
      if (os.platform() === 'win32') {
        cleanEnv.SYSTEMROOT = process.env.SYSTEMROOT ?? 'C:\\Windows';
        cleanEnv.APPDATA = process.env.APPDATA ?? '';
        cleanEnv.APPDATA = homeDir;
        cleanEnv.LOCALAPPDATA = homeDir;
      }

      // Node needs NODE_PATH for npx/tsx to work
      if (process.env.NODE_PATH) cleanEnv.NODE_PATH = process.env.NODE_PATH;
      if (process.env.npm_config_prefix) cleanEnv.npm_config_prefix = process.env.npm_config_prefix;

      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const launch = async (): Promise<void> => {
        await fs.mkdir(homeDir, { recursive: true });
        await fs.mkdir(cacheDir, { recursive: true });

        const child = execFile(command, args, {
          cwd,
          timeout,
          maxBuffer: 2 * 1024 * 1024, // 2MB
          env: cleanEnv,
          shell: os.platform() === 'win32', // Windows needs shell for npx
        }, (error, stdout, stderr) => {
          settled = true;
          if (killTimer) {
            clearTimeout(killTimer);
          }

          const exitCode = error?.code ?? (error ? 1 : 0);
          const timedOut = error?.killed === true;

          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode: typeof exitCode === 'number' ? exitCode : 1,
            timedOut,
          });
        });


        // Safety net: force kill after timeout + grace
        killTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          try {
            child.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, timeout + 5_000);
      };

      launch().catch((error: unknown) => {
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
        }
        const message = error instanceof Error ? error.message : String(error);
        resolve({ stdout: '', stderr: message, exitCode: 1, timedOut: false });
      });
    });
  }

  private async listGeneratedFiles(tmpDir: string, scriptPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(tmpDir);
      return entries
        .filter((name) => {
          const full = path.join(tmpDir, name);
          return full !== scriptPath;
        })
        .slice(0, 20); // cap at 20 files
    } catch {
      return [];
    }
  }

  private formatResult(
    language: string,
    code: string,
    result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean },
    generatedFiles: string[],
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
      lines.push('', '--- stdout ---', truncate(result.stdout.trim(), MAX_OUTPUT_LENGTH));
    }

    if (result.stderr.trim()) {
      // For Python, stderr often contains warnings — show it but capped
      lines.push('', '--- stderr ---', truncate(result.stderr.trim(), MAX_OUTPUT_LENGTH / 2));
    }

    if (!result.stdout.trim() && !result.stderr.trim() && result.exitCode === 0) {
      lines.push('', '(no output — code executed successfully with no print/console.log)');
    }

    if (generatedFiles.length > 0) {
      lines.push('', `--- generated files (${generatedFiles.length}) ---`);
      for (const f of generatedFiles) {
        lines.push(`  ${f}`);
      }
    }

    return lines.join('\n');
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 50) + `\n\n... (truncated, ${text.length} total chars)`;
}
