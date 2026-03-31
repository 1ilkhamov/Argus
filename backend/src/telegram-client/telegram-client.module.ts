import { Module } from '@nestjs/common';

import { ChatModule } from '../chat/chat.module';
import { LlmModule } from '../llm/llm.module';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { SettingsModule } from '../settings/settings.module';
import { TelegramRuntimeModule } from '../telegram-runtime/telegram-runtime.module';
import { ToolsModule } from '../tools/tools.module';
import { TelegramClientController } from './api/telegram-client.controller';
import { TelegramClientChatProfilerService } from './telegram-client-chat-profiler.service';
import { TelegramClientMonitorRuntimeRepository } from './telegram-client-monitor-runtime.repository';
import { TelegramClientMonitorRuntimeService } from './telegram-client-monitor-runtime.service';
import { TelegramClientListener } from './telegram-client.listener';
import { TelegramClientRepository } from './telegram-client.repository';
import { TelegramClientMessagesRepository } from './telegram-client-messages.repository';
import { TelegramClientService } from './telegram-client.service';
import { TelegramClientWriteService } from './telegram-client-write.service';
import { PolicySimulateTool } from '../tools/builtin/communication/policy-simulate.tool';
import { TelegramClientTool } from '../tools/builtin/communication/telegram-client.tool';

@Module({
  imports: [ChatModule, LlmModule, SettingsModule, TelegramRuntimeModule, ToolsModule],
  controllers: [TelegramClientController],
  providers: [
    TelegramClientRepository,
    TelegramClientMessagesRepository,
    TelegramClientChatProfilerService,
    TelegramClientMonitorRuntimeRepository,
    TelegramClientMonitorRuntimeService,
    TelegramClientService,
    TelegramClientWriteService,
    TelegramClientListener,
    PolicySimulateTool,
    TelegramClientTool,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [
    TelegramClientService,
    TelegramClientRepository,
    TelegramClientMessagesRepository,
    TelegramClientWriteService,
    TelegramClientMonitorRuntimeService,
  ],
})
export class TelegramClientModule {}
