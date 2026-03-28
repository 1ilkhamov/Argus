import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

/** Maximum clipboard content length returned to the LLM */
const MAX_CONTENT_LENGTH = 12_000;
/** Maximum content length for write operations */
const MAX_WRITE_LENGTH = 50_000;
/** Command timeout */
const TIMEOUT_MS = 5_000;

/**
 * Clipboard tool — read from and write to the system clipboard (macOS pbcopy/pbpaste).
 */
@Injectable()
export class ClipboardTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(ClipboardTool.name);

  readonly definition: ToolDefinition = {
    name: 'clipboard',
    description:
      'Read from or write to the system clipboard.\n\n' +
      'Actions:\n' +
      '- read: Get current clipboard contents (text)\n' +
      '- write: Set clipboard contents to provided text\n\n' +
      'Use this when the user says "what\'s in my clipboard", "скопируй", "вставь", ' +
      '"copy this", "paste", or asks you to work with clipboard content.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'read = get clipboard contents, write = set clipboard contents.',
        },
        content: {
          type: 'string',
          description: 'Text to write to clipboard (only for write action).',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('clipboard tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();

    try {
      switch (action) {
        case 'read':
          return await this.readClipboard();
        case 'write':
          return await this.writeClipboard(String(args.content ?? ''));
        default:
          return `Error: Unknown action "${action}". Valid actions: read, write.`;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`clipboard ${action} failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  private readClipboard(): Promise<string> {
    const command = this.getReadCommand();
    if (!command) {
      return Promise.resolve('Clipboard read is supported only on macOS and Windows.');
    }

    return new Promise((resolve) => {
      execFile(command.file, command.args, {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) {
          resolve(`Error reading clipboard: ${error.message}`);
          return;
        }

        const content = String(stdout);
        if (!content.trim()) {
          resolve('Clipboard is empty.');
          return;
        }

        if (content.length > MAX_CONTENT_LENGTH) {
          resolve(
            `Clipboard contents (${content.length} chars, truncated):\n\n` +
            content.slice(0, MAX_CONTENT_LENGTH - 100) +
            `\n\n... (${content.length} total chars)`,
          );
          return;
        }

        resolve(`Clipboard contents (${content.length} chars):\n\n${content}`);
      });
    });
  }

  private writeClipboard(content: string): Promise<string> {
    if (!content) {
      return Promise.resolve('Error: No content provided to write to clipboard.');
    }

    if (content.length > MAX_WRITE_LENGTH) {
      return Promise.resolve(
        `Error: Content too large (${content.length} chars, max ${MAX_WRITE_LENGTH}).`,
      );
    }

    const command = this.getWriteCommand();
    if (!command) {
      return Promise.resolve('Clipboard write is supported only on macOS and Windows.');
    }

    return new Promise((resolve) => {
      const child = spawn(command.file, command.args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      });

      let settled = false;
      let stderr = '';
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGKILL');
        resolve(`Error writing to clipboard: timed out after ${TIMEOUT_MS}ms.`);
      }, TIMEOUT_MS);
      timer.unref();

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(`Error writing to clipboard: ${error.message}`);
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          resolve(`Error writing to clipboard: ${stderr.trim() || `process exited with code ${code}`}`);
          return;
        }

        this.logger.log(`Wrote ${content.length} chars to clipboard`);
        resolve(`Successfully copied ${content.length} characters to clipboard.`);
      });

      child.stdin?.write(content);
      child.stdin?.end();
    });
  }

  private getReadCommand(): { file: string; args: string[] } | null {
    if (process.platform === 'darwin') {
      return { file: 'pbpaste', args: [] };
    }

    if (process.platform === 'win32') {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      };
    }

    return null;
  }

  private getWriteCommand(): { file: string; args: string[] } | null {
    if (process.platform === 'darwin') {
      return { file: 'pbcopy', args: [] };
    }

    if (process.platform === 'win32') {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'],
      };
    }

    return null;
  }
}
