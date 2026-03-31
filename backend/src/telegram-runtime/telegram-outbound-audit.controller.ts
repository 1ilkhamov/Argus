import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { TelegramOutboundAuditRepository } from './telegram-outbound-audit.repository';
import {
  TELEGRAM_OUTBOUND_ACTORS,
  TELEGRAM_OUTBOUND_CHANNELS,
  TELEGRAM_OUTBOUND_ORIGINS,
  TELEGRAM_OUTBOUND_RESULTS,
  TELEGRAM_POLICY_DECISIONS,
  type TelegramOutboundAuditEvent,
} from './telegram-runtime.types';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('telegram-outbound-audit')
export class TelegramOutboundAuditController {
  constructor(private readonly auditRepository: TelegramOutboundAuditRepository) {}

  @Get()
  async listEvents(
    @Query('channel') channel?: string,
    @Query('actor') actor?: string,
    @Query('origin') origin?: string,
    @Query('result') result?: string,
    @Query('policyDecision') policyDecision?: string,
    @Query('chatId') chatId?: string,
    @Query('correlationId') correlationId?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<TelegramOutboundAuditEvent[]> {
    return this.auditRepository.search({
      channel: this.parseOptionalEnum(channel, TELEGRAM_OUTBOUND_CHANNELS),
      actor: this.parseOptionalEnum(actor, TELEGRAM_OUTBOUND_ACTORS),
      origin: this.parseOptionalEnum(origin, TELEGRAM_OUTBOUND_ORIGINS),
      result: this.parseOptionalEnum(result, TELEGRAM_OUTBOUND_RESULTS),
      policyDecision: this.parseOptionalEnum(policyDecision, TELEGRAM_POLICY_DECISIONS),
      targetChatId: chatId?.trim() || undefined,
      correlationId: correlationId?.trim() || undefined,
      before: this.parseTimestamp(before, 'before'),
      after: this.parseTimestamp(after, 'after'),
      limit: this.parseLimit(limit),
    });
  }

  private parseOptionalEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
    if (!value?.trim()) {
      return undefined;
    }

    const normalized = value.trim() as T;
    if (!allowed.includes(normalized)) {
      throw new Error(`Invalid value: "${value}".`);
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
