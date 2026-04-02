import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { deriveScopeKey } from '../../common/auth/scope-key';
import type { TelegramConfig, TelegramUserContext } from '../telegram.types';

export interface TelegramAuthRuntimeState {
  enabled: boolean;
  allowlistConfigured: boolean;
  allowedUsersCount: number;
}

@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);
  private readonly enabled: boolean;
  private allowedUsers: Set<number>;

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.get<TelegramConfig>('telegram')!;
    this.enabled = config.enabled;
    this.allowedUsers = new Set(config.allowedUsers);

    if (!this.enabled) {
      this.logger.log('Telegram inbound auth disabled via TELEGRAM_ENABLED=false');
    } else if (this.allowedUsers.size === 0) {
      this.logger.warn('TELEGRAM_ALLOWED_USERS is empty — all Telegram users will be rejected');
    } else {
      this.logger.log(`Allowed Telegram users: ${[...this.allowedUsers].join(', ')}`);
    }
  }

  isAllowed(userId: number): boolean {
    return this.enabled && this.allowedUsers.size > 0 && this.allowedUsers.has(userId);
  }

  getRuntimeState(): TelegramAuthRuntimeState {
    return {
      enabled: this.enabled,
      allowlistConfigured: this.allowedUsers.size > 0,
      allowedUsersCount: this.allowedUsers.size,
    };
  }

  reloadAllowedUsers(userIds: number[]): void {
    this.allowedUsers = new Set(userIds);
    this.logger.log(`Reloaded allowed Telegram users: ${userIds.join(', ') || '(none)'}`);
  }

  buildUserContext(userId: number, chatId: number, firstName?: string, username?: string): TelegramUserContext {
    return {
      userId,
      chatId,
      scopeKey: deriveScopeKey(String(userId), 'telegram'),
      firstName,
      username,
    };
  }
}
