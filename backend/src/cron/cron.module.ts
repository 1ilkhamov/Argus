import { Module } from '@nestjs/common';

import { CronJobRepository } from './cron-job.repository';
import { CronSchedulerService } from './cron-scheduler.service';

@Module({
  providers: [CronJobRepository, CronSchedulerService],
  exports: [CronJobRepository, CronSchedulerService],
})
export class CronModule {}
