import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { deriveScopeKey } from '../../common/auth/scope-key';
import type { TelegramConfig, TelegramUserContext } from '../telegram.types';

@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);
  private allowedUsers: Set<number>;

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.get<TelegramConfig>('telegram')!;
    this.allowedUsers = new Set(config.allowedUsers);

    if (this.allowedUsers.size === 0) {
      this.logger.warn('TELEGRAM_ALLOWED_USERS is empty — all Telegram users will be rejected');
    } else {
      this.logger.log(`Allowed Telegram users: ${[...this.allowedUsers].join(', ')}`);
    }
  }

  isAllowed(userId: number): boolean {
    return this.allowedUsers.size === 0 ? false : this.allowedUsers.has(userId);
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
