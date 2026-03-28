import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { ProcessManagerService, type ProcessInfo } from './process-manager.service';

@Injectable()
export class ProcessTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(ProcessTool.name);
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'process',
    description:
      'Manage long-running background processes. Unlike system_run (which blocks until completion), ' +
      'this tool starts processes in the background and lets you monitor, interact with, and stop them.\n\n' +
      'Actions:\n' +
      '- start: Launch a background process. Returns a process ID for later reference.\n' +
      '- poll: Get new stdout/stderr output since last poll.\n' +
      '- send: Send text to stdin of a running process (for interactive REPLs, prompts).\n' +
      '- kill: Terminate a process by ID.\n' +
      '- list: Show all managed processes and their status.\n\n' +
      'Examples: start a dev server, run a long build, interact with python REPL, monitor logs.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'poll', 'send', 'kill', 'list'],
          description: 'Action to perform.',
        },
        command: {
          type: 'string',
          description: '(start) Shell command to run in background.',
        },
        working_directory: {
          type: 'string',
          description: '(start) Working directory. Defaults to workspace root.',
        },
        id: {
          type: 'string',
          description: '(poll, send, kill) Process ID returned by start.',
        },
        input: {
          type: 'string',
          description: '(send) Text to write to process stdin.',
        },
        signal: {
          type: 'string',
          enum: ['SIGTERM', 'SIGKILL'],
          description: '(kill) Signal to send. Default: SIGTERM.',
        },
      },
      required: ['action'],
    },
    safety: 'dangerous',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
    private readonly processManager: ProcessManagerService,
  ) {
    this.enabled = this.configService.get<boolean>('tools.systemRun.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('process tool is disabled (follows system_run config)');
      return;
    }
    this.registry.register(this);
    this.logger.log('process tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();

    try {
      switch (action) {
        case 'start':
          return this.handleStart(args);
        case 'poll':
          return this.handlePoll(args);
        case 'send':
          return this.handleSend(args);
        case 'kill':
          return this.handleKill(args);
        case 'list':
          return this.handleList();
        default:
          return `Error: Unknown action "${action}". Use: start, poll, send, kill, list.`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private handleStart(args: Record<string, unknown>): string {
    const command = String(args.command ?? '').trim();
    if (!command) {
      return 'Error: "command" is required for start action.';
    }

    const cwd = args.working_directory ? String(args.working_directory).trim() : undefined;
    const info = this.processManager.start(command, cwd);

    return [
      `✅ Process started`,
      `ID: ${info.id}`,
      `PID: ${info.pid}`,
      `Command: ${info.command}`,
      `Directory: ${info.cwd}`,
      '',
      'Use action=poll with this ID to check output.',
      'Use action=kill with this ID to stop it.',
    ].join('\n');
  }

  private handlePoll(args: Record<string, unknown>): string {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for poll action.';
    }

    const { info, stdout, stderr } = this.processManager.poll(id);
    const lines: string[] = [
      `Process ${info.id} (pid=${info.pid}): ${info.status}${info.exitCode !== null ? ` (exit code: ${info.exitCode})` : ''}`,
    ];

    if (stdout) {
      lines.push('', '--- stdout (new) ---', stdout);
    }

    if (stderr) {
      lines.push('', '--- stderr (new) ---', stderr);
    }

    if (!stdout && !stderr) {
      lines.push('', '(no new output since last poll)');
    }

    return lines.join('\n');
  }

  private handleSend(args: Record<string, unknown>): string {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for send action.';
    }

    const input = String(args.input ?? '');
    if (!input) {
      return 'Error: "input" is required for send action.';
    }

    this.processManager.send(id, input);
    return `Sent to process ${id}: "${input.length > 100 ? input.slice(0, 100) + '...' : input}"`;
  }

  private handleKill(args: Record<string, unknown>): string {
    const id = String(args.id ?? '').trim();
    if (!id) {
      return 'Error: "id" is required for kill action.';
    }

    const signal = (String(args.signal ?? 'SIGTERM').trim() as 'SIGTERM' | 'SIGKILL');
    const info = this.processManager.kill(id, signal);

    return `Sent ${signal} to process ${info.id} (pid=${info.pid}). Status: ${info.status}`;
  }

  private handleList(): string {
    const all = this.processManager.list();
    if (all.length === 0) {
      return 'No background processes. Use action=start to launch one.';
    }

    const lines = [`${all.length} managed process(es):\n`];
    for (const p of all) {
      lines.push(this.formatProcessInfo(p));
    }
    return lines.join('\n');
  }

  private formatProcessInfo(p: ProcessInfo): string {
    const status = p.status === 'running'
      ? '🟢 running'
      : `⚫ exited (code ${p.exitCode})`;
    return `[${p.id}] ${status} | pid=${p.pid} | "${p.command}" | dir=${p.cwd} | started=${p.startedAt}`;
  }
}
