import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition, ToolExecutionContext } from '../../core/tool.types';
import { PendingNotifyService } from '../../core/pending-notify.service';
import { SettingsService } from '../../../settings/settings.service';

/**
 * Notification tool — sends notifications to the user via:
 * 1. macOS native notifications (osascript)
 * 2. Telegram bot (optional, requires bot token + chat ID)
 *
 * Used standalone or as delivery channel for cron jobs.
 */
@Injectable()
export class NotifyTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(NotifyTool.name);
  /** Fallback values from .env (used if Settings API has no override) */
  private readonly envTelegramBotToken: string;
  private readonly envTelegramChatId: string;

  private static readonly MAX_TITLE_LENGTH = 120;
  private static readonly MAX_MESSAGE_LENGTH = 4_000;

  readonly definition: ToolDefinition = {
    name: 'notify',
    description:
      'Send a notification to the user. Supports macOS desktop notifications and Telegram messages. Use this to alert, remind, or deliver information to the user proactively.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The notification message text.',
        },
        title: {
          type: 'string',
          description: 'Optional notification title. Defaults to "Argus".',
        },
        channel: {
          type: 'string',
          description: 'Delivery channel: "desktop" (macOS notification), "telegram", or "all". Defaults to "all" (sends to all configured channels).',
          enum: ['desktop', 'telegram', 'all'],
        },
      },
      required: ['message'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly pendingNotify: PendingNotifyService,
  ) {
    this.envTelegramBotToken = this.configService.get<string>('tools.notify.telegramBotToken', '');
    this.envTelegramChatId = this.configService.get<string>('tools.notify.telegramChatId', '');
  }

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('notify tool registered');
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const message = this.normalizeMessage(String(args.message ?? '').trim());
    const title = this.normalizeTitle(String(args.title ?? 'Argus').trim());
    const channel = String(args.channel ?? 'all').trim();

    if (!message) return 'Error: "message" is required.';

    // Detect tg-client scope → extract source chat info for reply routing
    const sourceChat = this.resolveSourceChat(context);

    const results: string[] = [];

    if (channel === 'desktop' || channel === 'all') {
      const desktopResult = await this.sendDesktop(title, message);
      results.push(desktopResult);
    }

    if (channel === 'telegram' || channel === 'all') {
      const { botToken, chatId } = await this.resolveTelegramCredentials();
      if (botToken && chatId) {
        const telegramResult = await this.sendTelegramWithReply(
          title, message, botToken, chatId, sourceChat,
        );
        results.push(telegramResult);
      } else if (channel === 'telegram') {
        results.push('Telegram: not configured (set TOOLS_NOTIFY_TELEGRAM_BOT_TOKEN and TOOLS_NOTIFY_TELEGRAM_CHAT_ID in .env or via Settings API)');
      }
    }

    return results.join('\n');
  }

  // ─── Public method for cron scheduler ─────────────────────────────────────

  async sendNotification(title: string, message: string): Promise<void> {
    await this.sendDesktop(title, message);
    const { botToken, chatId } = await this.resolveTelegramCredentials();
    if (botToken && chatId) {
      await this.sendTelegram(title, message, botToken, chatId);
    }
  }

  // ─── Desktop (macOS) ─────────────────────────────────────────────────────

  private sendDesktop(title: string, message: string): Promise<string> {
    return new Promise((resolve) => {
      const command = this.getDesktopCommand(title, message);
      if (!command) {
        resolve(`Desktop: unsupported on ${process.platform}`);
        return;
      }

      execFile(command.file, command.args, { timeout: 5000, windowsHide: true }, (error) => {
        if (error) {
          this.logger.warn(`Desktop notification failed: ${error.message}`);
          resolve('Desktop: failed — ' + error.message);
        } else {
          resolve('Desktop: sent');
        }
      });
    });
  }

  // ─── Telegram ─────────────────────────────────────────────────────────────

  /**
   * Resolve source chat info from ToolExecutionContext.meta.
   * Set by tg-client listener: meta.sourceChatId, meta.sourceChatTitle
   */
  private resolveSourceChat(
    context?: ToolExecutionContext,
  ): { chatId: string; chatTitle: string } | null {
    const chatId = context?.meta?.sourceChatId;
    if (!chatId) return null;
    return { chatId, chatTitle: context?.meta?.sourceChatTitle || chatId };
  }

  /**
   * Send Telegram notification. If sourceChat is provided (tg-client scope),
   * adds a "📩 Ответить" inline button and saves a pending request.
   */
  private async sendTelegramWithReply(
    title: string,
    message: string,
    botToken: string,
    chatId: string,
    sourceChat: { chatId: string; chatTitle: string } | null,
  ): Promise<string> {
    try {
      const text = sourceChat
        ? `📨 ${sourceChat.chatTitle}\n\n${message}`
        : `${title}\n${message}`;
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
      };

      // Add reply button if from tg-client
      if (sourceChat) {
        body.reply_markup = {
          inline_keyboard: [
            [{ text: `📩 Ответить в "${sourceChat.chatTitle}"`, callback_data: `notify_reply:${sourceChat.chatId}` }],
          ],
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      const json = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };

      if (!response.ok || !json.ok) {
        this.logger.warn(`Telegram send failed: ${response.status} ${json.description ?? ''}`);
        return `Telegram: failed (${response.status})`;
      }

      // Save pending request so bot can route the reply
      if (sourceChat && json.result?.message_id) {
        this.pendingNotify.setPending(json.result.message_id, {
          chatId: sourceChat.chatId,
          chatTitle: sourceChat.chatTitle,
          question: message,
          createdAt: Date.now(),
        });
      }

      return 'Telegram: sent';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Telegram send error: ${msg}`);
      return `Telegram: failed — ${msg}`;
    }
  }

  /** Legacy method kept for sendNotification (cron) */
  private async sendTelegram(title: string, message: string, botToken: string, chatId: string): Promise<string> {
    return this.sendTelegramWithReply(title, message, botToken, chatId, null);
  }

  /**
   * Resolve Telegram credentials dynamically:
   * 1. Check SettingsService (DB, set via Settings API / UI)
   * 2. Fall back to .env values
   * 3. If chat_id still empty, use first allowed Telegram user as fallback
   *    (for single-user setups where the owner IS the notification recipient)
   */
  private async resolveTelegramCredentials(): Promise<{ botToken: string; chatId: string }> {
    const botToken =
      (await this.settingsService.getValue('telegram.bot_token')) || this.envTelegramBotToken;
    let chatId =
      (await this.settingsService.getValue('tools.notify.telegram_chat_id')) || this.envTelegramChatId;

    // Fallback: use first telegram.allowed_users as chat_id
    if (!chatId) {
      const allowedUsersRaw =
        (await this.settingsService.getValue('telegram.allowed_users')) ||
        this.configService.get<string>('telegram.allowedUsers', '');
      const allowedUsers = Array.isArray(allowedUsersRaw)
        ? allowedUsersRaw
        : String(allowedUsersRaw).split(',').map((s) => s.trim()).filter(Boolean);
      if (allowedUsers.length > 0) {
        chatId = String(allowedUsers[0]);
      }
    }

    return { botToken, chatId };
  }

  private normalizeTitle(title: string): string {
    const value = title || 'Argus';
    return value.length <= NotifyTool.MAX_TITLE_LENGTH
      ? value
      : value.slice(0, NotifyTool.MAX_TITLE_LENGTH - 1) + '…';
  }

  private normalizeMessage(message: string): string {
    return message.length <= NotifyTool.MAX_MESSAGE_LENGTH
      ? message
      : message.slice(0, NotifyTool.MAX_MESSAGE_LENGTH - 1) + '…';
  }

  private getDesktopCommand(title: string, message: string): { file: string; args: string[] } | null {
    if (process.platform === 'darwin') {
      return {
        file: 'osascript',
        args: ['-e', `display notification ${this.toAppleScriptString(message)} with title ${this.toAppleScriptString(title)}`],
      };
    }

    if (process.platform === 'win32') {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', this.buildWindowsNotificationScript(title, message)],
      };
    }

    return null;
  }

  private toAppleScriptString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  private buildWindowsNotificationScript(title: string, message: string): string {
    const escapedTitle = title.replace(/'/g, "''");
    const escapedMessage = message.replace(/'/g, "''");

    return [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -AssemblyName System.Drawing;',
      '$notify = New-Object System.Windows.Forms.NotifyIcon;',
      '$notify.Icon = [System.Drawing.SystemIcons]::Information;',
      `$notify.BalloonTipTitle = '${escapedTitle}';`,
      `$notify.BalloonTipText = '${escapedMessage}';`,
      '$notify.Visible = $true;',
      '$notify.ShowBalloonTip(5000);',
      'Start-Sleep -Milliseconds 5500;',
      '$notify.Dispose();',
    ].join(' ');
  }
}
