import { Module } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { SettingsModule } from '../settings/settings.module';
import { TelegramClientMessagesRepository } from '../telegram-client/telegram-client-messages.repository';
import { TelegramClientRepository } from '../telegram-client/telegram-client.repository';
import { TelegramRuntimeModule } from '../telegram-runtime/telegram-runtime.module';
import { PendingNotifyRepository } from '../tools/core/pending-notify.repository';
import { PendingNotifyService } from '../tools/core/pending-notify.service';
import { MonitorRepository } from './monitor.repository';
import { MonitorsController } from './monitors.controller';
import { TelegramWatchdogService } from './telegram-watchdog.service';

@Module({
  imports: [SettingsModule, TelegramRuntimeModule],
  controllers: [MonitorsController],
  providers: [
    MonitorRepository,
    TelegramWatchdogService,
    TelegramClientRepository,
    TelegramClientMessagesRepository,
    PendingNotifyRepository,
    PendingNotifyService,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [MonitorRepository, TelegramWatchdogService],
})
export class MonitorsModule {}
