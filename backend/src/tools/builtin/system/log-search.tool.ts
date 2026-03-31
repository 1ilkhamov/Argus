import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { LogSearchService, LOG_ENTRY_LEVELS, LOG_FILE_KINDS, type LogEntryLevel, type LogFileKind } from '../../../logs/log-search.service';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

@Injectable()
export class LogSearchTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(LogSearchTool.name);

  readonly definition: ToolDefinition = {
    name: 'log_search',
    description:
      'Search backend operational logs written by the Argus file logger. Supports filtering by text, level, context, structured event name, and log file kind. Use this for runtime diagnostics and incident investigation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: ['search', 'list_files'],
        },
        query: {
          type: 'string',
          description: 'Free-text substring search across raw log content.',
        },
        level: {
          type: 'string',
          description: 'Optional exact log level filter.',
          enum: [...LOG_ENTRY_LEVELS],
        },
        context: {
          type: 'string',
          description: 'Optional context/class filter, e.g. HTTP or TelegramWatchdogService.',
        },
        event: {
          type: 'string',
          description: 'Optional structured event name filter for JSON log payloads.',
        },
        file_kind: {
          type: 'string',
          description: 'Which log file set to search.',
          enum: [...LOG_FILE_KINDS],
        },
        date: {
          type: 'string',
          description: 'Optional date selector in YYYY-MM-DD format.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching entries to return. Default: 20, max: 100.',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
    timeoutMs: 15_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly logSearchService: LogSearchService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('log_search tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();

    try {
      switch (action) {
        case 'list_files':
          return this.handleListFiles(args);
        case 'search':
          return this.handleSearch(args);
        default:
          return 'Unknown action. Use search or list_files.';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`log_search ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  private handleListFiles(args: Record<string, unknown>): string {
    const fileKind = this.parseFileKind(args.file_kind);
    const files = this.logSearchService.listFiles(fileKind);
    if (!files.length) {
      return 'No backend log files found.';
    }

    return `Backend log files (${files.length}):\n\n${files.map((file) => `- ${file}`).join('\n')}`;
  }

  private handleSearch(args: Record<string, unknown>): string {
    const result = this.logSearchService.search({
      query: args.query ? String(args.query).trim() : undefined,
      level: this.parseLevel(args.level),
      context: args.context ? String(args.context).trim() : undefined,
      event: args.event ? String(args.event).trim() : undefined,
      fileKind: this.parseFileKind(args.file_kind),
      date: args.date ? String(args.date).trim() : undefined,
      limit: this.parseLimit(args.limit),
    });

    if (!result.entries.length) {
      return `No log entries found. Files scanned: ${result.filesScanned.join(', ') || 'none'}.`;
    }

    const lines = result.entries.map((entry, index) => [
      `${index + 1}. [${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.context ? `[${entry.context}] ` : ''}${entry.file}`,
      `   event=${entry.event ?? 'n/a'}`,
      `   message=${entry.message}`,
    ].join('\n'));

    return [
      `Log search results (${result.entries.length}):`,
      `Files scanned: ${result.filesScanned.join(', ') || 'none'}`,
      '',
      lines.join('\n\n'),
    ].join('\n');
  }

  private parseLevel(value: unknown): LogEntryLevel | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const normalized = String(value).trim().toLowerCase() as LogEntryLevel;
    if (!LOG_ENTRY_LEVELS.includes(normalized)) {
      throw new Error(`Invalid level: ${String(value)}`);
    }

    return normalized;
  }

  private parseFileKind(value: unknown): LogFileKind {
    if (value === undefined || value === null || value === '') {
      return 'any';
    }

    const normalized = String(value).trim().toLowerCase() as LogFileKind;
    if (!LOG_FILE_KINDS.includes(normalized)) {
      throw new Error(`Invalid file_kind: ${String(value)}`);
    }

    return normalized;
  }

  private parseLimit(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 20;
    }
    return Math.min(Math.floor(parsed), 100);
  }
}
