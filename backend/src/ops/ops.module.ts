import { Module } from '@nestjs/common';

import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { CronModule } from '../cron/cron.module';
import { MonitorsModule } from '../monitors/monitors.module';
import { TelegramRuntimeModule } from '../telegram-runtime/telegram-runtime.module';
import { ToolsModule } from '../tools/tools.module';
import { OpsEventsController } from './ops-events.controller';
import { OpsEventsService } from './ops-events.service';

@Module({
  imports: [CronModule, MonitorsModule, TelegramRuntimeModule, ToolsModule],
  controllers: [OpsEventsController],
  providers: [OpsEventsService, AdminApiKeyGuard, RateLimitGuard, RateLimitService],
  exports: [OpsEventsService],
})
export class OpsModule {}
