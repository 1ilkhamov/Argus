import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { LogSearchService, LOG_ENTRY_LEVELS, LOG_FILE_KINDS, type LogEntryLevel, type LogFileKind, type LogSearchResult } from './log-search.service';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('logs')
export class LogsController {
  constructor(private readonly logSearchService: LogSearchService) {}

  @Get('files')
  listFiles(@Query('fileKind') fileKind?: string): { files: string[] } {
    return { files: this.logSearchService.listFiles(this.parseFileKind(fileKind)) };
  }

  @Get('search')
  search(
    @Query('query') query?: string,
    @Query('level') level?: string,
    @Query('context') context?: string,
    @Query('event') event?: string,
    @Query('fileKind') fileKind?: string,
    @Query('date') date?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('correlationId') correlationId?: string,
    @Query('chatId') chatId?: string,
    @Query('jobId') jobId?: string,
    @Query('ruleId') ruleId?: string,
    @Query('limit') limit?: string,
  ): LogSearchResult {
    return this.logSearchService.search({
      query: query?.trim() || undefined,
      level: this.parseLevel(level),
      context: context?.trim() || undefined,
      event: event?.trim() || undefined,
      fileKind: this.parseFileKind(fileKind),
      date: date?.trim() || undefined,
      before: this.parseTimestamp(before, 'before'),
      after: this.parseTimestamp(after, 'after'),
      correlationId: correlationId?.trim() || undefined,
      chatId: chatId?.trim() || undefined,
      jobId: jobId?.trim() || undefined,
      ruleId: ruleId?.trim() || undefined,
      limit: this.parseLimit(limit),
    });
  }

  private parseLevel(value?: string): LogEntryLevel | undefined {
    if (!value?.trim()) {
      return undefined;
    }

    const normalized = value.trim().toLowerCase() as LogEntryLevel;
    if (!LOG_ENTRY_LEVELS.includes(normalized)) {
      throw new Error(`Invalid level: ${value}`);
    }

    return normalized;
  }

  private parseFileKind(value?: string): LogFileKind {
    if (!value?.trim()) {
      return 'any';
    }

    const normalized = value.trim().toLowerCase() as LogFileKind;
    if (!LOG_FILE_KINDS.includes(normalized)) {
      throw new Error(`Invalid fileKind: ${value}`);
    }

    return normalized;
  }

  private parseTimestamp(value: string | undefined, field: 'before' | 'after'): string | undefined {
    if (!value?.trim()) {
      return undefined;
    }

    const parsed = new Date(value.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO timestamp.`);
    }

    return parsed.toISOString();
  }

  private parseLimit(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 20;
    }
    return Math.min(Math.floor(parsed), 200);
  }
}
