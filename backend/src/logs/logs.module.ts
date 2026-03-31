import { Module } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { LogSearchService } from './log-search.service';
import { LogsController } from './logs.controller';

@Module({
  controllers: [LogsController],
  providers: [
    LogSearchService,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [LogSearchService],
})
export class LogsModule {}
