import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { TelegramClientRepository } from '../../../telegram-client/telegram-client.repository';
import { isTgChatMode } from '../../../telegram-client/telegram-client.types';
import { TelegramOutboundService } from '../../../telegram-runtime/telegram-outbound.service';
import {
  TELEGRAM_OUTBOUND_ACTIONS,
  TELEGRAM_OUTBOUND_ACTORS,
  TELEGRAM_OUTBOUND_CHANNELS,
  TELEGRAM_OUTBOUND_ORIGINS,
} from '../../../telegram-runtime/telegram-runtime.types';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

@Injectable()
export class PolicySimulateTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(PolicySimulateTool.name);

  readonly definition: ToolDefinition = {
    name: 'policy_simulate',
    description: 'Simulate whether a Telegram outbound action would be allowed or denied by the runtime policy without actually sending anything.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Outbound channel to simulate. Defaults to telegram_client.',
          enum: [...TELEGRAM_OUTBOUND_CHANNELS],
        },
        action: {
          type: 'string',
          description: 'Outbound action to simulate. Defaults to send_message.',
          enum: [...TELEGRAM_OUTBOUND_ACTIONS],
        },
        actor: {
          type: 'string',
          description: 'Actor performing the action. Defaults to agent.',
          enum: [...TELEGRAM_OUTBOUND_ACTORS],
        },
        origin: {
          type: 'string',
          description: 'Origin to associate with the simulated action. Defaults to system.',
          enum: [...TELEGRAM_OUTBOUND_ORIGINS],
        },
        chat_id: {
          type: 'string',
          description: 'Optional target chat ID. If this matches a monitored chat, its configured mode will be used automatically unless mode is explicitly provided.',
        },
        chat_title: {
          type: 'string',
          description: 'Optional target chat title for display.',
        },
        mode: {
          type: 'string',
          description: 'Optional explicit monitored mode override.',
          enum: ['auto', 'read_only', 'manual', 'disabled'],
        },
      },
    },
    safety: 'safe',
    timeoutMs: 10_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly outboundService: TelegramOutboundService,
    private readonly repository: TelegramClientRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('policy_simulate tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const chatId = args.chat_id ? String(args.chat_id).trim() : undefined;
    const monitoredChat = chatId ? await this.repository.findByChatId(chatId) : undefined;
    const mode = this.resolveMode(args.mode, monitoredChat?.mode);
    const channel = this.parseEnum(args.channel, TELEGRAM_OUTBOUND_CHANNELS, 'telegram_client');
    const action = this.parseEnum(args.action, TELEGRAM_OUTBOUND_ACTIONS, 'send_message');
    const actor = this.parseEnum(args.actor, TELEGRAM_OUTBOUND_ACTORS, 'agent');
    const origin = this.parseEnum(args.origin, TELEGRAM_OUTBOUND_ORIGINS, 'system');
    const chatTitle = args.chat_title ? String(args.chat_title).trim() : monitoredChat?.chatTitle ?? null;

    const evaluation = this.outboundService.evaluate({
      channel,
      action,
      actor,
      origin,
      chatId: chatId ?? null,
      chatTitle,
      monitoredChatId: monitoredChat?.id ?? null,
      monitoredMode: mode ?? null,
    });

    return [
      'Telegram policy simulation:',
      `decision: ${evaluation.decision}`,
      `reason_code: ${evaluation.reasonCode}`,
      `message: ${evaluation.message}`,
      `channel: ${channel}`,
      `action: ${action}`,
      `actor: ${actor}`,
      `origin: ${origin}`,
      `chat_id: ${chatId ?? 'n/a'}`,
      `chat_title: ${chatTitle ?? 'n/a'}`,
      `resolved_mode: ${mode ?? 'unmanaged'}`,
      `monitored_chat_id: ${monitoredChat?.id ?? 'n/a'}`,
    ].join('\n');
  }

  private parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    const normalized = String(value).trim() as T;
    if (!allowed.includes(normalized)) {
      throw new Error(`Invalid value: "${normalized}".`);
    }

    return normalized;
  }

  private resolveMode(value: unknown, fallback?: string): 'auto' | 'read_only' | 'manual' | 'disabled' | undefined {
    if (value === undefined || value === null || value === '') {
      if (fallback && isTgChatMode(fallback)) {
        return fallback;
      }
      return undefined;
    }

    const normalized = String(value).trim();
    if (!isTgChatMode(normalized)) {
      throw new Error(`Invalid mode: "${normalized}".`);
    }

    return normalized;
  }
}
