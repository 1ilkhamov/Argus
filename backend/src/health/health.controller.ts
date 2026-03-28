import { Controller, Get, UseGuards } from '@nestjs/common';

import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { HealthService, type HealthCheckPayload, type PublicHealthCheckPayload } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<PublicHealthCheckPayload> {
    return this.healthService.check();
  }

  @UseGuards(ApiKeyGuard, RateLimitGuard)
  @Get('runtime')
  async checkRuntime(): Promise<HealthCheckPayload> {
    return this.healthService.checkRuntime();
  }
}
