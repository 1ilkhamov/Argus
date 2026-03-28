import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { AuthenticatedUserGuard } from '../common/guards/authenticated-user.guard';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { StorageModule } from '../storage/storage.module';
import { ToolsModule } from '../tools/tools.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ContextTrimService } from './context-trim.service';
import { TurnResponseValidatorService } from './validation/turn-validator.service';

@Module({
  imports: [LlmModule, AgentModule, MemoryModule, StorageModule, ToolsModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ContextTrimService,
    TurnResponseValidatorService,
    AdminApiKeyGuard,
    AuthenticatedUserGuard,
    ApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [ChatService, StorageModule],
})
export class ChatModule {}
