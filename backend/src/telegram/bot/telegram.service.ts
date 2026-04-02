import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';

import { SettingsService } from '../../settings/settings.service';
import { TelegramUpdateHandler } from './telegram.update-handler';
import type { TelegramConfig } from '../telegram.types';

export interface TelegramStatus {
  enabled: boolean;
  tokenConfigured: boolean;
  tokenSource: 'settings' | 'env' | 'none';
  running: boolean;
  username: string | null;
  mode: 'polling' | 'webhook' | null;
}

/**
 * Manages the Telegram bot lifecycle: initialization, polling/webhook, and graceful shutdown.
 * Supports dynamic restart when settings change via the UI.
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private botUsername: string | null = null;
  private botMode: 'polling' | 'webhook' | null = null;
  private tokenConfigured = false;
  private tokenSource: 'settings' | 'env' | 'none' = 'none';
  private readonly config: TelegramConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly updateHandler: TelegramUpdateHandler,
  ) {
    this.config = this.configService.get<TelegramConfig>('telegram')!;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.tokenConfigured = false;
      this.tokenSource = 'none';
      this.logger.log('Telegram bot disabled via TELEGRAM_ENABLED=false');
      return;
    }

    const botToken = await this.resolveToken();

    if (!botToken) {
      this.logger.log('Telegram bot is disabled (no token configured)');
      return;
    }

    // Reload allowed users from DB (may differ from .env)
    const allowedUsersRaw = await this.settingsService.getValue('telegram.allowed_users');
    if (allowedUsersRaw) {
      this.updateHandler.reloadAllowedUsers(
        allowedUsersRaw.split(',').map(Number).filter(Number.isFinite),
      );
    }

    await this.startBot(botToken);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopBot();
  }

  /**
   * Get the bot instance (for use by other services like VoiceHandler).
   */
  getBot(): Telegraf | null {
    return this.bot;
  }

  /**
   * Current bot status for the API.
   */
  getStatus(): TelegramStatus {
    return {
      enabled: this.config.enabled,
      tokenConfigured: this.tokenConfigured,
      tokenSource: this.tokenSource,
      running: this.bot !== null,
      username: this.botUsername,
      mode: this.botMode,
    };
  }

  /**
   * Stop the bot without restarting.
   * Called when the user explicitly disconnects via the UI.
   */
  async stop(): Promise<TelegramStatus> {
    this.logger.log('Stopping Telegram bot (user-initiated)...');
    await this.stopBot();
    return this.getStatus();
  }

  /**
   * Restart the bot with fresh settings from DB/env.
   * Called when the user updates Telegram settings via the UI.
   */
  async restart(): Promise<TelegramStatus> {
    this.logger.log('Restarting Telegram bot with new settings...');

    await this.stopBot();

    if (!this.config.enabled) {
      this.tokenConfigured = false;
      this.tokenSource = 'none';
      this.logger.log('Telegram bot remains disabled via TELEGRAM_ENABLED=false');
      return this.getStatus();
    }

    const botToken = await this.resolveToken();
    if (!botToken) {
      this.logger.log('No bot token configured — bot stopped');
      return this.getStatus();
    }

    // Reload allowed users into auth service
    const allowedUsersRaw = await this.settingsService.getValue('telegram.allowed_users');
    if (allowedUsersRaw) {
      this.updateHandler.reloadAllowedUsers(
        allowedUsersRaw.split(',').map(Number).filter(Number.isFinite),
      );
    }

    await this.startBot(botToken);
    return this.getStatus();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async resolveToken(): Promise<string> {
    const dbToken = await this.settingsService.getValue('telegram.bot_token');
    const normalizedDbToken = dbToken?.trim() ?? '';
    if (normalizedDbToken) {
      this.tokenConfigured = true;
      this.tokenSource = 'settings';
      return normalizedDbToken;
    }

    const normalizedEnvToken = this.config.botToken.trim();
    if (normalizedEnvToken) {
      this.tokenConfigured = true;
      this.tokenSource = 'env';
      return normalizedEnvToken;
    }

    this.tokenConfigured = false;
    this.tokenSource = 'none';
    return '';
  }

  private async startBot(token: string): Promise<void> {
    try {
      this.bot = new Telegraf(token, { handlerTimeout: 300_000 });

      // Register handlers
      this.updateHandler.registerHandlers(this.bot);

      // Error handler
      this.bot.catch((err) => {
        this.logger.error(`Telegraf error: ${err instanceof Error ? err.message : String(err)}`);
      });

      if (this.config.webhookUrl) {
        await this.startWebhook();
      } else {
        await this.startPolling();
      }
    } catch (err) {
      this.logger.error(`Failed to start Telegram bot: ${err instanceof Error ? err.message : String(err)}`);
      this.bot = null;
      this.botUsername = null;
      this.botMode = null;
    }
  }

  private async stopBot(): Promise<void> {
    if (this.bot) {
      this.logger.log('Stopping Telegram bot...');
      this.bot.stop('restart');
      this.bot = null;
      this.botUsername = null;
      this.botMode = null;
    }
  }

  private async startPolling(retryCount = 0): Promise<void> {
    if (!this.bot) return;

    try {
      // Drop pending updates to avoid processing old messages on restart
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });

      // Launch polling (non-blocking)
      this.bot.launch({ dropPendingUpdates: true }).catch((err) => {
        this.logger.error(`Polling error: ${err instanceof Error ? err.message : String(err)}`);
      });

      const botInfo = await this.bot.telegram.getMe();
      this.botUsername = botInfo.username ?? null;
      this.botMode = 'polling';
      this.logger.log(`Telegram bot started (polling): @${botInfo.username}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const is409 = message.includes('409') || message.includes('Conflict');

      if (is409 && retryCount < 3) {
        const delay = 2000 * (retryCount + 1);
        this.logger.warn(`Polling conflict (409), retrying in ${delay}ms (attempt ${retryCount + 1}/3)`);
        await new Promise((r) => setTimeout(r, delay));
        await this.startPolling(retryCount + 1);
      } else {
        throw err;
      }
    }
  }

  private async startWebhook(): Promise<void> {
    if (!this.bot) return;

    await this.bot.telegram.setWebhook(this.config.webhookUrl, {
      secret_token: this.config.webhookSecret || undefined,
    });

    const botInfo = await this.bot.telegram.getMe();
    this.botUsername = botInfo.username ?? null;
    this.botMode = 'webhook';
    this.logger.log(`Telegram bot started (webhook): @${botInfo.username} → ${this.config.webhookUrl}`);
  }
}
