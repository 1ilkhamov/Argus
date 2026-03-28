import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ChatModule } from '../chat/chat.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [LlmModule, ChatModule, AgentModule, MemoryModule, EmbeddingModule],
  controllers: [HealthController],
  providers: [HealthService, ApiKeyGuard, RateLimitGuard, RateLimitService],
})
export class HealthModule {}
