import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { LlmModule } from '../llm/llm.module';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { SettingsModule } from '../settings/settings.module';
import { ToolsModule } from '../tools/tools.module';
import { TelegramClientController } from './api/telegram-client.controller';
import { TelegramClientChatProfilerService } from './telegram-client-chat-profiler.service';
import { TelegramClientListener } from './telegram-client.listener';
import { TelegramClientRepository } from './telegram-client.repository';
import { TelegramClientMessagesRepository } from './telegram-client-messages.repository';
import { TelegramClientService } from './telegram-client.service';
import { TelegramClientTool } from '../tools/builtin/communication/telegram-client.tool';

@Module({
  imports: [ChatModule, LlmModule, SettingsModule, ToolsModule],
  controllers: [TelegramClientController],
  providers: [
    TelegramClientRepository,
    TelegramClientMessagesRepository,
    TelegramClientChatProfilerService,
    TelegramClientService,
    TelegramClientListener,
    TelegramClientTool,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [TelegramClientService, TelegramClientRepository, TelegramClientMessagesRepository],
})
export class TelegramClientModule {}
