import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { TelegramClientModule } from '../telegram-client/telegram-client.module';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { MemoryModule } from '../memory/memory.module';
import { SettingsModule } from '../settings/settings.module';
import { TelegramRuntimeModule } from '../telegram-runtime/telegram-runtime.module';
import { ToolsModule } from '../tools/tools.module';
import { TelegramAuthService } from './auth/telegram.auth.service';
import { TelegramController } from './api/telegram.controller';
import { TelegramMessageSender } from './bot/telegram.message-sender';
import { TelegramVoiceHandler } from './voice/telegram.voice-handler';
import { TelegramUpdateHandler } from './bot/telegram.update-handler';
import { TelegramService } from './bot/telegram.service';

@Module({
  imports: [ChatModule, MemoryModule, SettingsModule, TelegramRuntimeModule, ToolsModule, TelegramClientModule],
  controllers: [TelegramController],
  providers: [
    TelegramAuthService,
    TelegramMessageSender,
    TelegramVoiceHandler,
    TelegramUpdateHandler,
    TelegramService,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
