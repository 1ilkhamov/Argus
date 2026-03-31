import { Module } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { CronController } from './cron.controller';
import { CronJobRepository } from './cron-job.repository';
import { CronJobRunRepository } from './cron-run.repository';
import { CronSchedulerService } from './cron-scheduler.service';

@Module({
  controllers: [CronController],
  providers: [
    CronJobRepository,
    CronJobRunRepository,
    CronSchedulerService,
    AdminApiKeyGuard,
    RateLimitGuard,
    RateLimitService,
  ],
  exports: [CronJobRepository, CronJobRunRepository, CronSchedulerService],
})
export class CronModule {}
