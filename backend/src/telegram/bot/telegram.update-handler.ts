import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Telegraf } from 'telegraf';
import type { Message, Update } from 'telegraf/types';

import { ChatService } from '../../chat/chat.service';
import { MemoryStoreService } from '../../memory/core/memory-store.service';
import { ToolRegistryService } from '../../tools/core/registry/tool-registry.service';
import { TelegramClientRepository } from '../../telegram-client/telegram-client.repository';
import { TelegramClientMessagesRepository } from '../../telegram-client/telegram-client-messages.repository';
import { TelegramAuthService } from '../auth/telegram.auth.service';
import { TelegramMessageSender } from './telegram.message-sender';
import { TelegramVoiceHandler } from '../voice/telegram.voice-handler';
import { PendingNotifyService } from '../../tools/core/pending-notify.service';
import { TelegramClientService } from '../../telegram-client/telegram-client.service';
import type { ConversationMap, TelegramConfig, TelegramUserContext } from '../telegram.types';

const BOT_COMMANDS = [
  { command: 'menu', description: '📋 Меню / Menu' },
  { command: 'new', description: '🔄 Новый чат / New chat' },
  { command: 'status', description: '📊 Статус / Status' },
  { command: 'memory', description: '🧠 Память / Memory' },
  { command: 'tools', description: '🔧 Инструменты / Tools' },
  { command: 'help', description: '❓ Помощь / Help' },
];

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🔄 Новый чат', callback_data: 'cmd:new' },
      { text: '📊 Статус', callback_data: 'cmd:status' },
    ],
    [
      { text: '🧠 Память', callback_data: 'cmd:memory' },
      { text: '🔧 Инструменты', callback_data: 'cmd:tools' },
    ],
    [
      { text: '❓ Помощь', callback_data: 'cmd:help' },
    ],
  ],
};

/**
 * Core handler for incoming Telegram updates.
 * Routes text/voice messages to ChatService and sends responses back.
 */
@Injectable()
export class TelegramUpdateHandler {
  private readonly logger = new Logger(TelegramUpdateHandler.name);
  private readonly conversations: ConversationMap = new Map();
  private readonly progressiveEdit: boolean;
  private readonly editIntervalMs: number;
  private readonly startedAt = Date.now();

  constructor(
    private readonly configService: ConfigService,
    private readonly chatService: ChatService,
    private readonly memoryStore: MemoryStoreService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly authService: TelegramAuthService,
    private readonly messageSender: TelegramMessageSender,
    private readonly voiceHandler: TelegramVoiceHandler,
    private readonly clientRepository: TelegramClientRepository,
    private readonly clientMessagesRepository: TelegramClientMessagesRepository,
    private readonly pendingNotify: PendingNotifyService,
    private readonly clientService: TelegramClientService,
  ) {
    const config = this.configService.get<TelegramConfig>('telegram')!;
    this.progressiveEdit = config.progressiveEdit;
    this.editIntervalMs = config.editIntervalMs;
  }

  /**
   * Reload allowed users list (called by TelegramService on restart).
   */
  reloadAllowedUsers(userIds: number[]): void {
    this.authService.reloadAllowedUsers(userIds);
  }

  registerHandlers(bot: Telegraf): void {
    // Register commands in Telegram's menu
    bot.telegram.setMyCommands(BOT_COMMANDS).catch((err) => {
      this.logger.warn(`Failed to set bot commands: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Commands
    bot.command('start', (ctx) => this.handleStart(bot, ctx));
    bot.command('menu', (ctx) => this.handleMenu(bot, ctx));
    bot.command('new', (ctx) => this.handleNewConversation(bot, ctx));
    bot.command('status', (ctx) => this.handleStatus(bot, ctx));
    bot.command('memory', (ctx) => this.handleMemory(bot, ctx));
    bot.command('tools', (ctx) => this.handleTools(bot, ctx));
    bot.command('help', (ctx) => this.handleHelp(bot, ctx));

    // Callback queries (inline keyboard buttons)
    bot.on('callback_query', (ctx) => this.handleCallback(bot, ctx));

    // Voice and audio messages
    bot.on('voice', (ctx) => this.handleVoice(bot, ctx));
    bot.on('audio', (ctx) => this.handleAudio(bot, ctx));

    // Text messages (must be last to not intercept commands)
    bot.on('text', (ctx) => this.handleText(bot, ctx));
  }

  // ─── Command handlers ────────────────────────────────────────────────────

  private async handleStart(bot: Telegraf, ctx: { message: Update.New & Update.NonChannel & Message.TextMessage; chat: { id: number }; from?: { id: number; first_name?: string; username?: string } }): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (!userId || !this.authService.isAllowed(userId)) {
      await this.messageSender.sendHtml(bot, chatId, '⛔ Access denied. Contact the administrator.');
      return;
    }

    const esc = this.messageSender.escapeHtml.bind(this.messageSender);
    const name = esc(ctx.from?.first_name || 'there');
    const html = `Привет, ${name}. Я <b>Argus</b> — твой AI-ассистент.\n\nОтправь сообщение текстом или голосом.\nНажми кнопку ниже или введи /menu.`;

    await bot.telegram.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      reply_markup: MENU_KEYBOARD,
    }).catch(() => {
      bot.telegram.sendMessage(chatId, `Привет, ${name}. Я Argus — твой AI-ассистент.\n\nОтправь сообщение или нажми /menu`, { reply_markup: MENU_KEYBOARD });
    });
  }

  private async handleMenu(bot: Telegraf, ctx: { chat: { id: number }; from?: { id: number } }): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.authService.isAllowed(userId)) return;

    await bot.telegram.sendMessage(ctx.chat.id, '<b>Argus</b> — выбери действие:', {
      parse_mode: 'HTML',
      reply_markup: MENU_KEYBOARD,
    }).catch(() => {
      bot.telegram.sendMessage(ctx.chat.id, 'Argus — выбери действие:', { reply_markup: MENU_KEYBOARD });
    });
  }

  private async handleHelp(bot: Telegraf, ctx: { chat: { id: number }; from?: { id: number } }): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.authService.isAllowed(userId)) return;

    const html = [
      '<b>Команды</b>',
      '',
      '<code>/menu</code>    Меню с кнопками',
      '<code>/new</code>     Начать новый чат',
      '<code>/status</code>  Статус системы',
      '<code>/memory</code>  Статистика памяти',
      '<code>/tools</code>   Доступные инструменты',
      '<code>/help</code>    Эта справка',
      '',
      'Просто напиши текст или отправь голосовое.',
    ].join('\n');

    await this.messageSender.sendHtml(bot, ctx.chat.id, html);
  }

  private async handleNewConversation(bot: Telegraf, ctx: { chat: { id: number }; from?: { id: number } }): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (!userId || !this.authService.isAllowed(userId)) return;

    this.conversations.delete(chatId);
    await this.messageSender.sendHtml(bot, chatId, 'Контекст очищен. Новый диалог начат.');

    this.logger.debug(`New conversation for Telegram user ${userId} (chat ${chatId})`);
  }

  private async handleStatus(bot: Telegraf, ctx: { chat: { id: number }; from?: { id: number } }): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.authService.isAllowed(userId)) return;

    const uptimeMs = Date.now() - this.startedAt;
    const h = Math.floor(uptimeMs / 3600000);
    const m = Math.floor((uptimeMs % 3600000) / 60000);
    const uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;

    const model = this.configService.get<string>('llm.model', 'unknown');
    const provider = this.configService.get<string>('llm.provider', 'unknown');
    const toolCount = this.toolRegistry.getDefinitions().length;
    const memCount = await this.memoryStore.count({ excludeSuperseded: true });

    const esc = this.messageSender.escapeHtml.bind(this.messageSender);
    const html = [
      '<b>Система</b>',
      '',
      '<pre>',
      `Модель      ${esc(model)}`,
      `Провайдер   ${esc(provider)}`,
      `Инструменты ${toolCount}`,
      `Память      ${memCount} записей`,
      `Аптайм      ${esc(uptime)}`,
      '</pre>',
    ].join('\n');

    await this.messageSender.sendHtml(bot, ctx.chat.id, html);
  }

  private async handleMemory(bot: Telegraf, ctx: { chat: { id: number }; from?: { id: number } }): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.authService.isAllowed(userId)) return;

    const base = { excludeSuperseded: true };
    const total = await this.memoryStore.count(base);
    const facts = await this.memoryStore.count({ ...base, kinds: ['fact'] });
    const episodes = await this.memoryStore.count({ ...base, kinds: ['episode'] });
    const skills = await this.memoryStore.count({ ...base, kinds: ['skill'] });
    const preferences = await this.memoryStore.count({ ...base, kinds: ['preference'] });

    const pad = (n: number) => String(n).padStart(4);
    const html = [
      '<b>Память</b>',
      '',
      '<pre>',
      `Всего          ${pad(total)}`,
      `─────────────────────`,
      `Факты          ${pad(facts)}`,
      `Эпизоды        ${pad(episodes)}`,
      `Навыки         ${pad(skills)}`,
      `Предпочтения   ${pad(preferences)}`,
      '</pre>',
    ].join('\n');

    await this.messageSender.sendHtml(bot, ctx.chat.id, html);
  }

  private async handleTools(bot: Telegraf, ctx: { chat: { id: number }; from?: { id: number } }): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.authService.isAllowed(userId)) return;

    const tools = this.toolRegistry.getDefinitions();
    const safetyTag: Record<string, string> = { safe: '●', moderate: '◐', dangerous: '○' };

    // Group by category
    const groups = new Map<string, typeof tools>();
    for (const t of tools) {
      const cat = t.category || 'общее';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(t);
    }

    const esc = this.messageSender.escapeHtml.bind(this.messageSender);
    const maxName = Math.max(...tools.map((t) => t.name.length));
    const lines: string[] = [`<b>Инструменты</b> (${tools.length})`, ''];

    for (const [cat, catTools] of groups) {
      lines.push(`<code>${esc(cat.toUpperCase())}</code>`);
      for (const t of catTools) {
        const icon = safetyTag[t.safety] ?? '·';
        const name = t.name.padEnd(maxName);
        lines.push(`  ${icon} <code>${esc(name)}</code>`);
      }
      lines.push('');
    }

    lines.push('<code>●</code> безопасный  <code>◐</code> умеренный  <code>○</code> опасный');

    await this.messageSender.sendHtml(bot, ctx.chat.id, lines.join('\n'));
  }

  // ─── Callback query handler (inline keyboard) ───────────────────────────

  private async handleCallback(bot: Telegraf, ctx: { callbackQuery?: { id: string; data?: string }; chat?: { id: number }; from?: { id: number } }): Promise<void> {
    const query = ctx.callbackQuery;
    if (!query?.data || !ctx.chat || !ctx.from) return;

    const userId = ctx.from.id;
    if (!this.authService.isAllowed(userId)) {
      await bot.telegram.answerCbQuery(query.id, '⛔ Доступ запрещён');
      return;
    }

    // Acknowledge the button press
    await bot.telegram.answerCbQuery(query.id).catch(() => {});

    const chatId = ctx.chat.id;

    // Handle notify reply buttons: "notify_reply:{targetChatId}"
    if (query.data.startsWith('notify_reply:')) {
      await this.handleNotifyReply(bot, chatId, query.data);
      return;
    }

    const cmd = query.data.replace('cmd:', '');

    switch (cmd) {
      case 'new':
        await this.handleNewConversation(bot, { chat: { id: chatId }, from: { id: userId } });
        break;
      case 'status':
        await this.handleStatus(bot, { chat: { id: chatId }, from: { id: userId } });
        break;
      case 'memory':
        await this.handleMemory(bot, { chat: { id: chatId }, from: { id: userId } });
        break;
      case 'tools':
        await this.handleTools(bot, { chat: { id: chatId }, from: { id: userId } });
        break;
      case 'help':
        await this.handleHelp(bot, { chat: { id: chatId }, from: { id: userId } });
        break;
      default:
        break;
    }
  }

  /**
   * Handle "Ответить" button press from a notify message.
   * Stores awaiting reply state so the next text message is routed to the target chat.
   */
  private async handleNotifyReply(bot: Telegraf, botChatId: number, callbackData: string): Promise<void> {
    const targetChatId = callbackData.slice('notify_reply:'.length);
    if (!targetChatId) return;

    // Look up chat title from repository
    let chatTitle = targetChatId;
    try {
      const chat = await this.clientRepository.findByChatId(targetChatId);
      if (chat) chatTitle = chat.chatTitle;
    } catch (error) {
      this.logger.debug(
        `Failed to resolve chat title for ${targetChatId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Store awaiting reply
    this.pendingNotify.setAwaitingReply(botChatId, {
      chatId: targetChatId,
      chatTitle,
      question: '',
      createdAt: Date.now(),
    });

    await this.messageSender.sendHtml(
      bot,
      botChatId,
      `✏️ Напиши ответ для <b>${this.messageSender.escapeHtml(chatTitle)}</b>:`,
    );
  }

  private async handleText(bot: Telegraf, ctx: { message: Update.New & Update.NonChannel & Message.TextMessage; chat: { id: number }; from?: { id: number; first_name?: string; username?: string } }): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (!userId || !this.authService.isAllowed(userId)) {
      await this.messageSender.sendError(bot, chatId, 'Access denied.');
      return;
    }

    const text = ctx.message.text?.trim();
    if (!text) return;

    // Check if this is a reply to a pending notify → route directly to target chat
    const pendingReply = this.pendingNotify.consumeAwaitingReply(chatId);
    if (pendingReply) {
      await this.routeReplyToChat(bot, chatId, text, pendingReply.chatId, pendingReply.chatTitle);
      return;
    }

    const userCtx = this.authService.buildUserContext(userId, chatId, ctx.from?.first_name, ctx.from?.username);
    await this.processMessage(bot, userCtx, text);
  }

  private async handleVoice(bot: Telegraf, ctx: { message: Update.New & Update.NonChannel & Message.VoiceMessage; chat: { id: number }; from?: { id: number; first_name?: string; username?: string } }): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (!userId || !this.authService.isAllowed(userId)) {
      await this.messageSender.sendError(bot, chatId, 'Access denied.');
      return;
    }

    const fileId = ctx.message.voice.file_id;
    await this.processVoiceMessage(bot, userId, chatId, fileId, ctx.from?.first_name, ctx.from?.username);
  }

  private async handleAudio(bot: Telegraf, ctx: { message: Update.New & Update.NonChannel & Message.AudioMessage; chat: { id: number }; from?: { id: number; first_name?: string; username?: string } }): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (!userId || !this.authService.isAllowed(userId)) {
      await this.messageSender.sendError(bot, chatId, 'Access denied.');
      return;
    }

    const fileId = ctx.message.audio.file_id;
    await this.processVoiceMessage(bot, userId, chatId, fileId, ctx.from?.first_name, ctx.from?.username);
  }

  private async processVoiceMessage(
    bot: Telegraf,
    userId: number,
    chatId: number,
    fileId: string,
    firstName?: string,
    username?: string,
  ): Promise<void> {
    await this.messageSender.sendTypingAction(bot, chatId);

    const transcribedText = await this.voiceHandler.transcribe(bot, fileId);

    if (!transcribedText) {
      await this.messageSender.sendError(bot, chatId, 'Could not transcribe the voice message. Please try again or send text.');
      return;
    }

    this.logger.debug(`Transcribed voice from user ${userId}: "${transcribedText.slice(0, 80)}"`);

    const userCtx = this.authService.buildUserContext(userId, chatId, firstName, username);
    await this.processMessage(bot, userCtx, transcribedText);
  }

  /**
   * Core message processing: send to ChatService and deliver response.
   */
  private async processMessage(bot: Telegraf, userCtx: TelegramUserContext, content: string): Promise<void> {
    const { chatId, scopeKey } = userCtx;
    const conversationId = this.conversations.get(chatId);

    await this.messageSender.sendTypingAction(bot, chatId);

    try {
      if (this.progressiveEdit) {
        await this.processMessageProgressive(bot, chatId, conversationId, content, scopeKey);
      } else {
        await this.processMessageSimple(bot, chatId, conversationId, content, scopeKey);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error processing message for chat ${chatId}: ${message}`);
      await this.messageSender.sendError(bot, chatId, 'Something went wrong. Please try again.');
    }
  }

  /**
   * Simple mode: wait for full response, then send.
   * Keeps "typing..." indicator alive every 4 s while waiting.
   */
  private async processMessageSimple(
    bot: Telegraf,
    chatId: number,
    conversationId: string | undefined,
    content: string,
    scopeKey: string,
  ): Promise<void> {
    const typingInterval = setInterval(() => {
      this.messageSender.sendTypingAction(bot, chatId);
    }, 4000);

    try {
      const extraSystemInstruction = await this.buildClientChatContext();
      const { conversation, assistantMessage } = await this.chatService.sendMessage(
        conversationId,
        content,
        { scopeKey, extraSystemInstruction: extraSystemInstruction || undefined },
      );

      this.conversations.set(chatId, conversation.id);
      await this.messageSender.sendText(bot, chatId, assistantMessage.content);
    } finally {
      clearInterval(typingInterval);
    }
  }

  /**
   * Progressive mode: stream response and periodically edit the message.
   */
  private async processMessageProgressive(
    bot: Telegraf,
    chatId: number,
    conversationId: string | undefined,
    content: string,
    scopeKey: string,
  ): Promise<void> {
    const placeholderId = await this.messageSender.sendPlaceholder(bot, chatId);
    if (!placeholderId) {
      // Fallback to simple mode
      return this.processMessageSimple(bot, chatId, conversationId, content, scopeKey);
    }

    let fullContent = '';
    let lastEditContent = '';
    let lastEditTime = 0;
    let newConversationId = conversationId;

    // Keep sending typing action periodically
    const typingInterval = setInterval(() => {
      this.messageSender.sendTypingAction(bot, chatId);
    }, 4000);

    try {
      const extraSystemInstruction = await this.buildClientChatContext();
      for await (const { chunk, conversationId: convId } of this.chatService.streamMessage(
        conversationId,
        content,
        { scopeKey, extraSystemInstruction: extraSystemInstruction || undefined },
      )) {
        newConversationId = convId;
        fullContent += chunk.content;

        const now = Date.now();
        if (!chunk.done && fullContent.length > 0 && now - lastEditTime >= this.editIntervalMs && fullContent !== lastEditContent) {
          await this.messageSender.editMessage(bot, chatId, placeholderId, fullContent + ' ▍');
          lastEditContent = fullContent;
          lastEditTime = now;
        }
      }
    } finally {
      clearInterval(typingInterval);
    }

    if (newConversationId) {
      this.conversations.set(chatId, newConversationId);
    }

    // Final edit with complete content
    if (fullContent) {
      const edited = await this.messageSender.editMessage(bot, chatId, placeholderId, fullContent);
      if (!edited) {
        // If edit failed (e.g., content too long), send as new messages
        await this.messageSender.sendText(bot, chatId, fullContent);
      }
    } else {
      await this.messageSender.editMessage(bot, chatId, placeholderId, '(empty response)');
    }
  }

  // ─── Direct reply routing (notify → reply → target chat) ────────────────

  /**
   * Route the owner's reply text directly to a tg-client chat.
   * No LLM involved — the text is sent as-is via the Telegram client account.
   */
  private async routeReplyToChat(
    bot: Telegraf,
    botChatId: number,
    text: string,
    targetChatId: string,
    targetChatTitle: string,
  ): Promise<void> {
    try {
      await this.clientService.sendMessage(targetChatId, text);
      await this.messageSender.sendHtml(
        bot,
        botChatId,
        `✅ Отправлено в <b>${this.messageSender.escapeHtml(targetChatTitle)}</b>`,
      );
      this.logger.debug(`Routed reply to ${targetChatTitle} (${targetChatId}): "${text.slice(0, 80)}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to route reply to ${targetChatId}: ${msg}`);
      await this.messageSender.sendError(bot, botChatId, `Не удалось отправить: ${msg}`);
    }
  }

  // ─── Client chat context for bot ────────────────────────────────────────

  /**
   * Build context about active Telegram Client chats so the bot can act on them.
   * This bridges the gap: when user replies to a notify, the bot knows the context.
   */
  private async buildClientChatContext(): Promise<string | null> {
    try {
      const chats = await this.clientRepository.findActive();
      if (!chats.length) return null;

      const sections: string[] = [
        `\n== ACTIVE TELEGRAM CLIENT CHATS (for context only) ==`,
        `The owner has these Telegram chats monitored. This is background context so you understand references to people and conversations.`,
        `If the owner asks to send a message to a specific chat, use the "telegram_client" tool with action "send_message" and the exact chat ID.`,
        `Do NOT send messages to chats unless the owner explicitly asks you to.`,
      ];

      for (const chat of chats.slice(0, 5)) {
        const recent = await this.clientMessagesRepository.getRecent(chat.chatId, 10);
        sections.push(`\nChat: "${chat.chatTitle}" (ID: ${chat.chatId}, type: ${chat.chatType}, mode: ${chat.mode})`);

        if (recent.length > 0) {
          sections.push(`Recent messages:`);
          for (const msg of recent) {
            const dir = msg.isOutgoing ? '→ Owner' : `← ${msg.senderName || 'Unknown'}`;
            const time = msg.timestamp.slice(11, 16);
            sections.push(`  [${time}] ${dir}: ${msg.text.slice(0, 120)}`);
          }
        }
      }

      return sections.join('\n');
    } catch (err) {
      this.logger.warn(`Failed to build client chat context: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
