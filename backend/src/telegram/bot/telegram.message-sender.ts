import { Injectable, Logger } from '@nestjs/common';
import type { Telegraf } from 'telegraf';

import { TelegramOutboundService } from '../../telegram-runtime/telegram-outbound.service';
import type { TelegramOutboundActor, TelegramOutboundOrigin } from '../../telegram-runtime/telegram-runtime.types';

export interface TelegramBotReplyMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramBotSendOptions {
  actor?: TelegramOutboundActor;
  origin?: TelegramOutboundOrigin;
  scopeKey?: string;
  conversationId?: string;
  correlationId?: string;
  audit?: boolean;
  replyMarkup?: TelegramBotReplyMarkup;
}

/**
 * Handles sending messages back to Telegram, including:
 * - Standard Markdown → Telegram HTML conversion
 * - Message splitting for >4096 char responses
 * - Progressive message editing (optional)
 * - "typing" chat action
 */
@Injectable()
export class TelegramMessageSender {
  private readonly logger = new Logger(TelegramMessageSender.name);

  private static readonly MAX_MESSAGE_LENGTH = 4096;

  constructor(
    private readonly outboundService: TelegramOutboundService,
  ) {}

  /**
   * Send "typing..." indicator to the chat.
   */
  async sendTypingAction(bot: Telegraf, chatId: number): Promise<void> {
    try {
      await bot.telegram.sendChatAction(chatId, 'typing');
    } catch (err) {
      this.logger.debug(`Failed to send typing action to ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Send a standard Markdown text (from LLM). Converts to HTML for Telegram.
   */
  async sendText(
    bot: Telegraf,
    chatId: number,
    text: string,
    options?: TelegramBotSendOptions,
  ): Promise<number | undefined> {
    const html = this.markdownToHtml(text);
    return this.sendHtml(bot, chatId, html, options);
  }

  /**
   * Send pre-formatted HTML directly to Telegram.
   */
  async sendHtml(
    bot: Telegraf,
    chatId: number,
    html: string,
    options?: TelegramBotSendOptions,
  ): Promise<number | undefined> {
    const chunks = this.splitMessage(html);
    let lastMessageId: number | undefined;

    for (const chunk of chunks) {
      try {
        lastMessageId = await this.executeBotOutbound(chatId, chunk, options, async () => {
          try {
            const sent = await bot.telegram.sendMessage(chatId, chunk, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              reply_markup: options?.replyMarkup,
            });
            return sent.message_id;
          } catch {
            const plain = chunk.replace(/<[^>]+>/g, '');
            const sent = await bot.telegram.sendMessage(chatId, plain, this.buildPlainTextOptions(options));
            return sent.message_id;
          }
        });
      } catch {
        this.logger.error(`Failed to send message to ${chatId}`);
      }
    }

    return lastMessageId;
  }

  /**
   * Send an initial placeholder message for progressive editing.
   * Returns the message ID for subsequent edits.
   */
  async sendPlaceholder(
    bot: Telegraf,
    chatId: number,
    text = '⏳',
    options?: TelegramBotSendOptions,
  ): Promise<number | undefined> {
    try {
      return await this.executeBotOutbound(chatId, text, options, async () => {
        const sent = await bot.telegram.sendMessage(chatId, text, this.buildPlainTextOptions(options));
        return sent.message_id;
      });
    } catch (err) {
      this.logger.error(`Failed to send placeholder to ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Edit an existing message. Converts standard Markdown to HTML.
   */
  async editMessage(
    bot: Telegraf,
    chatId: number,
    messageId: number,
    text: string,
    options?: TelegramBotSendOptions,
  ): Promise<boolean> {
    const html = this.markdownToHtml(text);
    const truncated = html.length > TelegramMessageSender.MAX_MESSAGE_LENGTH
      ? html.slice(0, TelegramMessageSender.MAX_MESSAGE_LENGTH - 3) + '...'
      : html;

    try {
      await this.executeBotOutbound(chatId, truncated, options, async () => {
        await bot.telegram.editMessageText(chatId, messageId, undefined, truncated, {
          parse_mode: 'HTML',
        });
      });
      return true;
    } catch {
      const plain = truncated.replace(/<[^>]+>/g, '');
      try {
        await this.executeBotOutbound(chatId, plain, options, async () => {
          await bot.telegram.editMessageText(chatId, messageId, undefined, plain);
        });
        return true;
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        if (msg.includes('message is not modified')) {
          return true;
        }
        this.logger.debug(`Failed to edit message ${messageId} in ${chatId}: ${msg}`);
        return false;
      }
    }
  }

  /**
   * Send an error message to the user.
   */
  async sendError(
    bot: Telegraf,
    chatId: number,
    error: string,
    options?: TelegramBotSendOptions,
  ): Promise<void> {
    try {
      await this.executeBotOutbound(chatId, `⚠️ ${error}`, options, async () => {
        await bot.telegram.sendMessage(chatId, `⚠️ ${error}`, this.buildPlainTextOptions(options));
      });
    } catch (err) {
      this.logger.error(`Failed to send error to ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Escape HTML special characters.
   */
  escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Legacy alias — kept for command handler compatibility.
   * @deprecated Use escapeHtml instead.
   */
  escapeMarkdownV2(text: string): string {
    return this.escapeHtml(text);
  }

  /**
   * Convert standard Markdown (from LLM) to Telegram-compatible HTML.
   *
   * Handles: code blocks, inline code, bold, italic, strikethrough, links, lists.
   */
  markdownToHtml(md: string): string {
    // 1. Extract fenced code blocks → placeholders
    const codeBlocks: string[] = [];
    let result = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const idx = codeBlocks.length;
      const escaped = this.escapeHtml(code.replace(/\n$/, ''));
      const langAttr = lang ? ` class="language-${this.escapeHtml(lang)}"` : '';
      codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
      return `@@CB${idx}@@`;
    });

    // 2. Extract inline code → placeholders
    const inlineCodes: string[] = [];
    result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${this.escapeHtml(code)}</code>`);
      return `@@IC${idx}@@`;
    });

    // 3. Escape HTML in remaining text
    result = this.escapeHtml(result);

    // 4. Bold: **text** or __text__
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__(.+?)__/g, '<b>$1</b>');

    // 5. Italic: *text* or _text_ (not inside words with underscores)
    result = result.replace(/(?<!\w)\*([^\s*].*?[^\s*]|[^\s*])\*(?!\w)/g, '<i>$1</i>');
    result = result.replace(/(?<!\w)_([^\s_].*?[^\s_]|[^\s_])_(?!\w)/g, '<i>$1</i>');

    // 6. Strikethrough: ~~text~~
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // 7. Links: [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 8. Headings: ### text → bold text
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // 9. Horizontal rules: --- or *** → line
    result = result.replace(/^[-*]{3,}$/gm, '───────────');

    // 10. Restore placeholders
    result = result.replace(/@@CB(\d+)@@/g, (_m, idx) => codeBlocks[Number(idx)] ?? '');
    result = result.replace(/@@IC(\d+)@@/g, (_m, idx) => inlineCodes[Number(idx)] ?? '');

    return result.trim();
  }

  /**
   * Split a long message into chunks that fit Telegram's 4096-char limit.
   * Tries to split on paragraph boundaries first, then newlines.
   */
  private splitMessage(text: string): string[] {
    const maxLen = TelegramMessageSender.MAX_MESSAGE_LENGTH;

    if (text.length <= maxLen) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Try to split on double newline (paragraph boundary)
      let splitIdx = remaining.lastIndexOf('\n\n', maxLen);

      // Fallback to single newline
      if (splitIdx <= 0) {
        splitIdx = remaining.lastIndexOf('\n', maxLen);
      }

      // Fallback to space
      if (splitIdx <= 0) {
        splitIdx = remaining.lastIndexOf(' ', maxLen);
      }

      // Hard split as last resort
      if (splitIdx <= 0) {
        splitIdx = maxLen;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    return chunks;
  }

  private buildPlainTextOptions(options?: TelegramBotSendOptions): { reply_markup?: TelegramBotReplyMarkup } | undefined {
    if (!options?.replyMarkup) {
      return undefined;
    }

    return { reply_markup: options.replyMarkup };
  }

  private async executeBotOutbound<T>(
    chatId: number,
    payloadPreview: string,
    options: TelegramBotSendOptions | undefined,
    perform: () => Promise<T>,
  ): Promise<T> {
    if (options?.audit === false) {
      return perform();
    }

    return this.outboundService.executeSend(
      {
        channel: 'telegram_bot',
        action: 'send_message',
        actor: options?.actor ?? 'system',
        origin: options?.origin ?? 'telegram_message_sender',
        chatId: String(chatId),
        scopeKey: options?.scopeKey,
        conversationId: options?.conversationId,
        correlationId: options?.correlationId,
        payloadPreview,
      },
      perform,
    );
  }
}
