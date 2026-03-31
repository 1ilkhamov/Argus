import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LOG_DIR } from '../common/logger/file-logger.service';

export const LOG_ENTRY_LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
export type LogEntryLevel = (typeof LOG_ENTRY_LEVELS)[number];

export const LOG_FILE_KINDS = ['any', 'app', 'error'] as const;
export type LogFileKind = (typeof LOG_FILE_KINDS)[number];

export interface LogSearchParams {
  query?: string;
  level?: LogEntryLevel;
  context?: string;
  event?: string;
  fileKind?: LogFileKind;
  date?: string;
  before?: string;
  after?: string;
  correlationId?: string;
  chatId?: string;
  jobId?: string;
  ruleId?: string;
  limit?: number;
}

export interface ParsedLogEntry {
  file: string;
  timestamp: string;
  level: LogEntryLevel;
  context: string | null;
  message: string;
  event: string | null;
  payload: Record<string, unknown> | null;
  raw: string;
}

export interface LogSearchResult {
  filesScanned: string[];
  entries: ParsedLogEntry[];
}

const LOG_ENTRY_START = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+([A-Z]+)\s+(?:\[([^\]]+)\]\s+)?(.*)$/;
const LOG_FILE_NAME = /^(app|error)-\d{4}-\d{2}-\d{2}\.log$/;

@Injectable()
export class LogSearchService {
  listFiles(fileKind: LogFileKind = 'any'): string[] {
    if (!existsSync(LOG_DIR)) {
      return [];
    }

    return readdirSync(LOG_DIR)
      .filter((file) => LOG_FILE_NAME.test(file))
      .filter((file) => fileKind === 'any' || file.startsWith(`${fileKind}-`))
      .sort()
      .reverse();
  }

  search(params: LogSearchParams = {}): LogSearchResult {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 200));
    const files = this.listFiles(params.fileKind ?? 'any')
      .filter((file) => !params.date || file.includes(params.date));

    const entries: ParsedLogEntry[] = [];

    for (const file of files) {
      const parsed = this.parseFile(file);
      for (let index = parsed.length - 1; index >= 0; index -= 1) {
        const entry = parsed[index];
        if (!entry) {
          continue;
        }
        if (!this.matches(entry, params)) {
          continue;
        }
        entries.push(entry);
        if (entries.length >= limit) {
          return { filesScanned: files, entries };
        }
      }
    }

    return { filesScanned: files, entries };
  }

  private parseFile(file: string): ParsedLogEntry[] {
    const fullPath = join(LOG_DIR, file);
    if (!existsSync(fullPath)) {
      return [];
    }

    const content = readFileSync(fullPath, 'utf8');
    if (!content.trim()) {
      return [];
    }

    const lines = content.split(/\r?\n/);
    const entries: ParsedLogEntry[] = [];
    let current: string[] = [];

    const flush = () => {
      if (!current.length) {
        return;
      }

      const parsed = this.parseBlock(file, current);
      if (parsed) {
        entries.push(parsed);
      }
      current = [];
    };

    for (const line of lines) {
      if (!line) {
        continue;
      }

      if (LOG_ENTRY_START.test(line)) {
        flush();
        current = [line];
        continue;
      }

      if (current.length) {
        current.push(line);
      }
    }

    flush();
    return entries;
  }

  private parseBlock(file: string, lines: string[]): ParsedLogEntry | null {
    if (!lines.length) {
      return null;
    }

    const firstLine = lines[0];
    if (!firstLine) {
      return null;
    }

    const match = firstLine.match(LOG_ENTRY_START);
    if (!match) {
      return null;
    }

    const timestamp = match[1];
    const rawLevel = match[2];
    const context = match[3] ?? null;
    const firstMessage = match[4] ?? '';
    if (!timestamp || !rawLevel) {
      return null;
    }

    const message = lines.length > 1 ? `${firstMessage}\n${lines.slice(1).join('\n')}` : firstMessage;
    const payload = this.tryParsePayload(firstMessage);
    const normalizedLevel = rawLevel.toLowerCase() as LogEntryLevel;

    return {
      file,
      timestamp,
      level: normalizedLevel,
      context,
      message,
      event: typeof payload?.event === 'string' ? payload.event : null,
      payload,
      raw: lines.join('\n'),
    };
  }

  private tryParsePayload(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }

    return null;
  }

  private matches(entry: ParsedLogEntry, params: LogSearchParams): boolean {
    if (params.level && entry.level !== params.level) {
      return false;
    }

    if (params.before || params.after) {
      const entryTimestamp = this.parseEntryTimestamp(entry.timestamp);
      if (entryTimestamp === null) {
        return false;
      }
      if (params.before) {
        const beforeTimestamp = this.parseEntryTimestamp(params.before);
        if (beforeTimestamp !== null && entryTimestamp >= beforeTimestamp) {
          return false;
        }
      }
      if (params.after) {
        const afterTimestamp = this.parseEntryTimestamp(params.after);
        if (afterTimestamp !== null && entryTimestamp <= afterTimestamp) {
          return false;
        }
      }
    }

    if (params.context) {
      const normalizedContext = params.context.trim().toLowerCase();
      const entryContext = (entry.context ?? '').toLowerCase();
      if (!entryContext.includes(normalizedContext)) {
        return false;
      }
    }

    if (params.event && entry.event !== params.event.trim()) {
      return false;
    }

    if (!this.matchesPayloadField(entry.payload, params.correlationId, ['correlationId', 'correlation_id'])) {
      return false;
    }

    if (!this.matchesPayloadField(entry.payload, params.chatId, ['chatId', 'chat_id', 'targetChatId', 'target_chat_id', 'sourceChatId', 'source_chat_id'])) {
      return false;
    }

    if (!this.matchesPayloadField(entry.payload, params.jobId, ['jobId', 'job_id'])) {
      return false;
    }

    if (!this.matchesPayloadField(entry.payload, params.ruleId, ['ruleId', 'rule_id'])) {
      return false;
    }

    if (params.query) {
      const needle = params.query.trim().toLowerCase();
      const haystack = [
        entry.message,
        entry.raw,
        entry.context ?? '',
        entry.event ?? '',
        JSON.stringify(entry.payload ?? {}),
      ].join('\n').toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }

    return true;
  }

  private parseEntryTimestamp(value: string): number | null {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }

  private matchesPayloadField(
    payload: Record<string, unknown> | null,
    filterValue: string | undefined,
    fieldNames: string[],
  ): boolean {
    if (!filterValue?.trim()) {
      return true;
    }
    if (!payload) {
      return false;
    }

    const needle = filterValue.trim().toLowerCase();
    const values = this.collectPayloadFieldValues(payload, new Set(fieldNames.map((field) => field.toLowerCase())));
    return values.some((value) => value.toLowerCase() === needle || value.toLowerCase().includes(needle));
  }

  private collectPayloadFieldValues(payload: Record<string, unknown>, fieldNames: Set<string>): string[] {
    const values: string[] = [];

    for (const [key, value] of Object.entries(payload)) {
      if (fieldNames.has(key.toLowerCase())) {
        this.pushPrimitivePayloadValues(values, value);
      }

      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              values.push(...this.collectPayloadFieldValues(item as Record<string, unknown>, fieldNames));
            }
          }
        } else {
          values.push(...this.collectPayloadFieldValues(value as Record<string, unknown>, fieldNames));
        }
      }
    }

    return values;
  }

  private pushPrimitivePayloadValues(values: string[], candidate: unknown): void {
    if (candidate === null || candidate === undefined) {
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        this.pushPrimitivePayloadValues(values, item);
      }
      return;
    }
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      values.push(String(candidate));
    }
  }
}
