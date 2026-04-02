import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { ChatModule } from '../chat/chat.module';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { CronModule } from '../cron/cron.module';
import { HealthModule } from '../health/health.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { TelegramClientModule } from '../telegram-client/telegram-client.module';
import { TelegramModule } from '../telegram/telegram.module';
import { TelegramRuntimeModule } from '../telegram-runtime/telegram-runtime.module';
import { ToolsModule } from '../tools/tools.module';
import { BootstrapDiagnosticsService } from './bootstrap-diagnostics.service';
import { OpsDiagnosticsController } from './ops-diagnostics.controller';
import { OpsDiagnosticsService } from './ops-diagnostics.service';
import { OpsEventsController } from './ops-events.controller';
import { OpsEventsService } from './ops-events.service';

@Module({
  imports: [CronModule, MonitorsModule, TelegramClientModule, TelegramModule, TelegramRuntimeModule, ToolsModule, HealthModule, ChatModule, AgentModule, MemoryModule, LlmModule],
  controllers: [OpsEventsController, OpsDiagnosticsController],
  providers: [BootstrapDiagnosticsService, OpsEventsService, OpsDiagnosticsService, AdminApiKeyGuard, RateLimitGuard, RateLimitService],
  exports: [BootstrapDiagnosticsService, OpsEventsService, OpsDiagnosticsService],
})
export class OpsModule {}
