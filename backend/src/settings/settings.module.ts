import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimitService } from '../common/services/rate-limit.service';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SettingsController],
  providers: [SettingsRepository, SettingsService, AdminApiKeyGuard, RateLimitGuard, RateLimitService],
  exports: [SettingsService],
})
export class SettingsModule {}
