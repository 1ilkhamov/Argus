import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { OpsEventsService } from './ops-events.service';
import { STRUCTURED_OPERATIONAL_EVENT_KINDS, type StructuredOperationalEvent, type StructuredOperationalEventKind } from './ops-events.types';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('ops')
export class OpsEventsController {
  constructor(private readonly opsEventsService: OpsEventsService) {}

  @Get('events')
  async listEvents(
    @Query('kind') kind?: string,
    @Query('correlationId') correlationId?: string,
    @Query('chatId') chatId?: string,
    @Query('jobId') jobId?: string,
    @Query('ruleId') ruleId?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<StructuredOperationalEvent[]> {
    return this.opsEventsService.listEvents({
      kind: this.parseKind(kind),
      correlationId: correlationId?.trim() || undefined,
      chatId: chatId?.trim() || undefined,
      jobId: jobId?.trim() || undefined,
      ruleId: ruleId?.trim() || undefined,
      before: this.parseTimestamp(before, 'before'),
      after: this.parseTimestamp(after, 'after'),
      limit: this.parseLimit(limit),
    });
  }

  private parseKind(raw?: string): StructuredOperationalEventKind | undefined {
    if (!raw) {
      return undefined;
    }
    const value = raw.trim() as StructuredOperationalEventKind;
    if (!STRUCTURED_OPERATIONAL_EVENT_KINDS.includes(value)) {
      throw new BadRequestException(`kind must be one of: ${STRUCTURED_OPERATIONAL_EVENT_KINDS.join(', ')}`);
    }
    return value;
  }

  private parseTimestamp(raw: string | undefined, field: 'before' | 'after'): string | undefined {
    if (!raw) {
      return undefined;
    }
    const trimmed = raw.trim();
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO timestamp.`);
    }
    return parsed.toISOString();
  }

  private parseLimit(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 50;
    }
    return Math.min(Math.floor(parsed), 200);
  }
}
