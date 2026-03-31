import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { TelegramOutboundAuditRepository } from '../../../telegram-runtime/telegram-outbound-audit.repository';
import {
  TELEGRAM_OUTBOUND_ACTORS,
  TELEGRAM_OUTBOUND_CHANNELS,
  TELEGRAM_OUTBOUND_ORIGINS,
  TELEGRAM_OUTBOUND_RESULTS,
  TELEGRAM_POLICY_DECISIONS,
} from '../../../telegram-runtime/telegram-runtime.types';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

@Injectable()
export class EventAuditTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(EventAuditTool.name);

  readonly definition: ToolDefinition = {
    name: 'event_audit',
    description: 'Inspect outbound Telegram audit events and policy decisions. Use this to understand who attempted an action, what happened, and why it was allowed, blocked, or failed.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Optional channel filter.',
          enum: [...TELEGRAM_OUTBOUND_CHANNELS],
        },
        actor: {
          type: 'string',
          description: 'Optional actor filter.',
          enum: [...TELEGRAM_OUTBOUND_ACTORS],
        },
        origin: {
          type: 'string',
          description: 'Optional origin filter.',
          enum: [...TELEGRAM_OUTBOUND_ORIGINS],
        },
        result: {
          type: 'string',
          description: 'Optional delivery result filter.',
          enum: [...TELEGRAM_OUTBOUND_RESULTS],
        },
        policy_decision: {
          type: 'string',
          description: 'Optional policy decision filter.',
          enum: [...TELEGRAM_POLICY_DECISIONS],
        },
        chat_id: {
          type: 'string',
          description: 'Optional target chat ID filter.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of audit events to return. Default: 20, max: 50.',
        },
      },
    },
    safety: 'safe',
    timeoutMs: 15_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly auditRepository: TelegramOutboundAuditRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('event_audit tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    const events = await this.auditRepository.search({
      channel: this.parseOptionalEnum(args.channel, TELEGRAM_OUTBOUND_CHANNELS),
      actor: this.parseOptionalEnum(args.actor, TELEGRAM_OUTBOUND_ACTORS),
      origin: this.parseOptionalEnum(args.origin, TELEGRAM_OUTBOUND_ORIGINS),
      result: this.parseOptionalEnum(args.result, TELEGRAM_OUTBOUND_RESULTS),
      policyDecision: this.parseOptionalEnum(args.policy_decision, TELEGRAM_POLICY_DECISIONS),
      targetChatId: args.chat_id ? String(args.chat_id).trim() : undefined,
      limit,
    });

    if (!events.length) {
      return 'No outbound audit events found for the requested filters.';
    }

    const lines = events.map((event, index) => {
      const target = event.targetChatTitle
        ? `${event.targetChatTitle} (${event.targetChatId ?? 'n/a'})`
        : (event.targetChatId ?? 'n/a');
      const correlation = event.correlationId ? ` | correlation=${event.correlationId}` : '';
      const error = event.errorMessage ? ` | error=${event.errorMessage}` : '';
      return [
        `${index + 1}. [${event.createdAt}] ${event.result.toUpperCase()} ${event.channel}/${event.action}`,
        `   actor=${event.actor} | origin=${event.origin} | target=${target}`,
        `   policy=${event.policyDecision}/${event.policyReasonCode}${correlation}${error}`,
      ].join('\n');
    });

    return `Outbound audit events (${events.length}):\n\n${lines.join('\n\n')}`;
  }

  private parseOptionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const normalized = String(value).trim() as T;
    if (!allowed.includes(normalized)) {
      throw new Error(`Invalid value: "${normalized}".`);
    }

    return normalized;
  }
}
