import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { CRON_JOB_NOTIFICATION_POLICIES, CRON_SCHEDULE_TYPES, type CronJob } from './cron-job.types';
import type { CronJobRun } from './cron-run.types';
import { CronSchedulerService } from './cron-scheduler.service';

class CreateCronJobDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  task!: string;

  @IsIn(CRON_SCHEDULE_TYPES)
  scheduleType!: CronJob['scheduleType'];

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  schedule!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRuns?: number;

  @IsOptional()
  @IsIn(CRON_JOB_NOTIFICATION_POLICIES)
  notificationPolicy?: CronJob['notificationPolicy'];
}

class UpdateCronJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  task?: string;

  @IsOptional()
  @IsIn(CRON_SCHEDULE_TYPES)
  scheduleType?: CronJob['scheduleType'];

  @IsOptional()
  @IsString()
  @MaxLength(256)
  schedule?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRuns?: number;

  @IsOptional()
  @IsIn(CRON_JOB_NOTIFICATION_POLICIES)
  notificationPolicy?: CronJob['notificationPolicy'];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('cron')
export class CronController {
  constructor(private readonly scheduler: CronSchedulerService) {}

  @Get('jobs')
  async listJobs(): Promise<CronJob[]> {
    return this.scheduler.listJobs();
  }

  @Get('jobs/:id')
  async getJob(@Param('id', ParseUUIDPipe) id: string): Promise<CronJob> {
    const job = await this.scheduler.getJob(id);
    if (!job) {
      throw new NotFoundException(`Cron job ${id} not found`);
    }
    return job;
  }

  @Post('jobs')
  async createJob(@Body() body: CreateCronJobDto): Promise<CronJob> {
    const name = body.name.trim();
    const task = body.task.trim();
    const schedule = body.schedule.trim();
    if (!name) throw new BadRequestException('name is required.');
    if (!task) throw new BadRequestException('task is required.');
    if (!schedule) throw new BadRequestException('schedule is required.');

    return this.scheduler.createJob({
      name,
      task,
      scheduleType: body.scheduleType,
      schedule,
      maxRuns: body.maxRuns,
      notificationPolicy: body.notificationPolicy,
    });
  }

  @Patch('jobs/:id')
  async updateJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCronJobDto,
  ): Promise<CronJob> {
    const updates: UpdateCronJobDto = {
      ...body,
      name: body.name?.trim(),
      task: body.task?.trim(),
      schedule: body.schedule?.trim(),
    };

    if (updates.name !== undefined && !updates.name) throw new BadRequestException('name cannot be empty.');
    if (updates.task !== undefined && !updates.task) throw new BadRequestException('task cannot be empty.');
    if (updates.schedule !== undefined && !updates.schedule) throw new BadRequestException('schedule cannot be empty.');
    if (Object.values(updates).every((value) => value === undefined)) {
      throw new BadRequestException('At least one field must be provided.');
    }

    const job = await this.scheduler.updateJob(id, updates);
    if (!job) {
      throw new NotFoundException(`Cron job ${id} not found`);
    }
    return job;
  }

  @Delete('jobs/:id')
  async deleteJob(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.scheduler.deleteJob(id);
    if (!deleted) {
      throw new NotFoundException(`Cron job ${id} not found`);
    }
    return { deleted: true };
  }

  @Post('jobs/:id/pause')
  async pauseJob(@Param('id', ParseUUIDPipe) id: string): Promise<CronJob> {
    const job = await this.scheduler.pauseJob(id);
    if (!job) {
      throw new NotFoundException(`Cron job ${id} not found`);
    }
    return job;
  }

  @Post('jobs/:id/resume')
  async resumeJob(@Param('id', ParseUUIDPipe) id: string): Promise<CronJob> {
    const job = await this.scheduler.resumeJob(id);
    if (!job) {
      throw new NotFoundException(`Cron job ${id} not found`);
    }
    return job;
  }

  @Get('runs')
  async listRuns(
    @Query('jobId') jobId?: string,
    @Query('limit') limit?: string,
  ): Promise<CronJobRun[]> {
    return this.scheduler.listRecentRuns({
      jobId: jobId?.trim() || undefined,
      limit: this.parseLimit(limit),
    });
  }

  private parseLimit(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 20;
    }
    return Math.min(Math.floor(parsed), 200);
  }
}
