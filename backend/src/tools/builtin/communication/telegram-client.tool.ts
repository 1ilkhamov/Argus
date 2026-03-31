import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition, ToolExecutionContext } from '../../core/tool.types';
import { TelegramClientMonitorRuntimeService } from '../../../telegram-client/telegram-client-monitor-runtime.service';
import { TelegramClientService } from '../../../telegram-client/telegram-client.service';
import { TelegramClientWriteService } from '../../../telegram-client/telegram-client-write.service';
import { TelegramClientRepository } from '../../../telegram-client/telegram-client.repository';
import type { TgChatMode } from '../../../telegram-client/telegram-client.types';
import { isTgChatMode } from '../../../telegram-client/telegram-client.types';

@Injectable()
export class TelegramClientTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(TelegramClientTool.name);

  readonly definition: ToolDefinition = {
    name: 'telegram_client',
    description:
      'Interact with Telegram as a user account (not a bot). Read messages, send messages, list dialogs, and manage monitored chats.\n\n' +
      'Actions:\n' +
      '- list_dialogs: List recent Telegram dialogs (chats, groups, channels)\n' +
      '- read_messages: Read recent messages from a specific chat\n' +
      '- send_message: Send a message to a chat (as the connected user)\n' +
      '- list_monitored: List all monitored chats and their modes\n' +
      '- list_runtime: List live runtime state for monitored chats (queue, cooldown, last reply, errors)\n' +
      '- add_monitored: Add a chat to monitoring (auto-reply, read-only, manual, or disabled)\n' +
      '- update_monitored: Update monitoring settings for a chat\n' +
      '- remove_monitored: Remove a chat from monitoring\n' +
      '- status: Get connection status\n\n' +
      'The Telegram client must be connected and authorized first via Settings.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: [
            'list_dialogs', 'read_messages', 'send_message',
            'list_monitored', 'list_runtime', 'add_monitored', 'update_monitored', 'remove_monitored',
            'status',
          ],
        },
        chat_id: {
          type: 'string',
          description: 'Telegram chat ID. Used by read_messages, send_message, add_monitored, update_monitored, remove_monitored.',
        },
        text: {
          type: 'string',
          description: 'Message text to send (for "send_message").',
        },
        reply_to: {
          type: 'number',
          description: 'Message ID to reply to (for "send_message").',
        },
        limit: {
          type: 'number',
          description: 'Max results (for "list_dialogs", "read_messages"). Default: 20.',
        },
        chat_title: {
          type: 'string',
          description: 'Human-readable chat name (for "add_monitored").',
        },
        mode: {
          type: 'string',
          description: 'Monitoring mode (for "add_monitored", "update_monitored"): auto, read_only, manual, disabled.',
          enum: ['auto', 'read_only', 'manual', 'disabled'],
        },
        cooldown: {
          type: 'number',
          description: 'Seconds between auto-replies (for "add_monitored", "update_monitored"). Default: 30.',
        },
        system_note: {
          type: 'string',
          description: 'Extra context for the LLM when processing messages from this chat (for "add_monitored", "update_monitored").',
        },
      },
      required: ['action'],
    },
    safety: 'moderate',
    timeoutMs: 30_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly runtimeService: TelegramClientMonitorRuntimeService,
    private readonly clientService: TelegramClientService,
    private readonly clientWriteService: TelegramClientWriteService,
    private readonly repository: TelegramClientRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('telegram_client tool registered');
  }

  /** Sending actions blocked in tg-client scope (agent must reply via text, not tool) */
  private static readonly WRITE_ACTIONS = new Set(['send_message']);

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const action = String(args.action ?? '');

    // Block write actions from tg-client scope — agent replies via text, not by sending messages
    if (context?.scopeKey?.startsWith('tg-client:') && TelegramClientTool.WRITE_ACTIONS.has(action)) {
      return `Action "${action}" is not allowed from tg-client scope. Your text reply IS the message. Use read actions (list_dialogs, read_messages) to look up information.`;
    }

    try {
      switch (action) {
        case 'status':
          return await this.handleStatus();
        case 'list_dialogs':
          return await this.handleListDialogs(args);
        case 'read_messages':
          return await this.handleReadMessages(args);
        case 'send_message':
          return await this.handleSendMessage(args, context);
        case 'list_monitored':
          return await this.handleListMonitored();
        case 'list_runtime':
          return await this.handleListRuntime();
        case 'add_monitored':
          return await this.handleAddMonitored(args);
        case 'update_monitored':
          return await this.handleUpdateMonitored(args);
        case 'remove_monitored':
          return await this.handleRemoveMonitored(args);
        default:
          return `Unknown action: "${action}". Use one of: list_dialogs, read_messages, send_message, list_monitored, list_runtime, add_monitored, update_monitored, remove_monitored, status.`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`telegram_client ${action} failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────────────

  private async handleStatus(): Promise<string> {
    const status = await this.clientService.getStatus();
    return [
      `Connected: ${status.connected}`,
      `Authorized: ${status.authorized}`,
      status.user ? `User: ${status.user.firstName} (@${status.user.username || 'N/A'}) ID:${status.user.id}` : 'User: not logged in',
      `Auth step: ${status.authStep}`,
      `Monitored chats: ${status.monitoredChats}`,
    ].join('\n');
  }

  private async handleListDialogs(args: Record<string, unknown>): Promise<string> {
    const limit = Math.min(Number(args.limit) || 20, 50);
    const dialogs = await this.clientService.getDialogs(limit);

    if (!dialogs.length) return 'No dialogs found.';

    const lines = dialogs.map((d, i) => {
      const unread = d.unreadCount > 0 ? ` (${d.unreadCount} unread)` : '';
      const date = d.lastMessageDate ? ` | ${d.lastMessageDate.slice(0, 16)}` : '';
      return `${i + 1}. [${d.type}] ${d.title}${unread}${date}\n   ID: ${d.chatId}`;
    });

    return `Dialogs (${dialogs.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleReadMessages(args: Record<string, unknown>): Promise<string> {
    const chatId = String(args.chat_id ?? '').trim();
    if (!chatId) return 'Error: "chat_id" is required.';

    const limit = Math.min(Number(args.limit) || 20, 50);
    const messages = await this.clientService.getMessages(chatId, limit);

    if (!messages.length) return 'No messages found in this chat.';

    const lines = messages.map((m) => {
      const dir = m.isOutgoing ? '→' : '←';
      const date = m.date.slice(0, 16);
      return `${dir} [${date}] ${m.senderName}: ${m.text.slice(0, 200)}${m.text.length > 200 ? '...' : ''}`;
    });

    return `Messages (${messages.length}, newest first):\n\n${lines.join('\n')}`;
  }

  private async handleSendMessage(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const chatId = String(args.chat_id ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!chatId) return 'Error: "chat_id" is required.';
    if (!text) return 'Error: "text" is required.';

    const replyTo = args.reply_to ? Number(args.reply_to) : undefined;
    const msgId = await this.clientWriteService.sendMessage({
      chatId,
      text,
      replyTo,
      actor: context?.conversationId ? 'human' : 'agent',
      origin: 'telegram_client_tool',
      scopeKey: context?.scopeKey,
      conversationId: context?.conversationId,
      correlationId: context?.messageId ?? context?.conversationId,
    });
    return `Message sent successfully (message ID: ${msgId}).`;
  }

  private async handleListMonitored(): Promise<string> {
    const chats = await this.repository.findAll();
    if (!chats.length) return 'No monitored chats configured.';

    const lines = chats.map((c, i) =>
      `${i + 1}. "${c.chatTitle}" (ID: ${c.chatId})\n   Mode: ${c.mode} | Cooldown: ${c.cooldownSeconds}s | Note: ${c.systemNote || '(none)'}`,
    );

    return `Monitored chats (${chats.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleListRuntime(): Promise<string> {
    const states = await this.runtimeService.listStates();
    if (!states.length) return 'No monitor runtime state available.';

    const lines = states.map((state, index) => {
      const parts = [
        `${index + 1}. "${state.chatTitle}" (ID: ${state.chatId})`,
        `   Mode: ${state.mode} | Status: ${state.status}`,
        `   Queue: ${state.queueLength} | Active: ${state.queueActive}`,
        `   Last inbound: ${state.lastInboundAt ?? '—'}${state.lastInboundSenderName ? ` from ${state.lastInboundSenderName}` : ''}`,
        `   Last reply: ${state.lastReplyAt ?? '—'}${state.lastReplyMessageId ? ` (msg ${state.lastReplyMessageId})` : ''}`,
        `   Cooldown until: ${state.cooldownUntil ?? '—'}`,
        `   Last conversation: ${state.lastConversationId ?? '—'}`,
        `   Last processed: ${state.lastProcessedAt ?? '—'}`,
      ];

      if (state.lastErrorMessage) {
        parts.push(`   Error: ${state.lastErrorMessage}`);
      }

      return parts.join('\n');
    });

    return `Monitor runtime (${states.length}):\n\n${lines.join('\n\n')}`;
  }

  private async handleAddMonitored(args: Record<string, unknown>): Promise<string> {
    const chatId = String(args.chat_id ?? '').trim();
    if (!chatId) return 'Error: "chat_id" is required.';

    const existing = await this.repository.findByChatId(chatId);
    if (existing) {
      return `Chat ${chatId} ("${existing.chatTitle}") is already monitored (mode: ${existing.mode}).`;
    }

    const mode = this.parseMode(args.mode, 'auto');

    const chat = await this.repository.create({
      chatId,
      chatTitle: String(args.chat_title ?? chatId),
      mode,
      cooldownSeconds: args.cooldown ? Number(args.cooldown) : undefined,
      systemNote: args.system_note ? String(args.system_note) : undefined,
    });

    return `Chat "${chat.chatTitle}" added to monitoring (mode: ${chat.mode}, cooldown: ${chat.cooldownSeconds}s).`;
  }

  private async handleUpdateMonitored(args: Record<string, unknown>): Promise<string> {
    const chatId = String(args.chat_id ?? '').trim();
    if (!chatId) return 'Error: "chat_id" is required.';

    const existing = await this.repository.findByChatId(chatId);
    if (!existing) return `Error: Chat ${chatId} is not monitored. Use add_monitored first.`;

    const mode = args.mode === undefined ? undefined : this.parseMode(args.mode, 'auto');

    await this.repository.update(existing.id, {
      mode,
      cooldownSeconds: args.cooldown ? Number(args.cooldown) : undefined,
      systemNote: args.system_note !== undefined ? String(args.system_note) : undefined,
      chatTitle: args.chat_title ? String(args.chat_title) : undefined,
    });

    return `Monitoring settings updated for "${existing.chatTitle}".`;
  }

  private async handleRemoveMonitored(args: Record<string, unknown>): Promise<string> {
    const chatId = String(args.chat_id ?? '').trim();
    if (!chatId) return 'Error: "chat_id" is required.';

    const existing = await this.repository.findByChatId(chatId);
    if (!existing) return `Chat ${chatId} is not monitored.`;

    await this.repository.delete(existing.id);
    return `Chat "${existing.chatTitle}" removed from monitoring.`;
  }

  private parseMode(value: unknown, fallback: TgChatMode): TgChatMode {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (!isTgChatMode(value)) {
      throw new Error(`Invalid monitoring mode: "${String(value)}".`);
    }

    return value;
  }
}
