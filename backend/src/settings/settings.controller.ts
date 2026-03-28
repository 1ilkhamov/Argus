import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { SettingsService, type SettingDto } from './settings.service';

class UpdateSettingBody {
  @IsString()
  value!: string;
}

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getAll(): Promise<SettingDto[]> {
    return this.settingsService.getAllDtos();
  }

  @Get(':key')
  async get(@Param('key') key: string): Promise<SettingDto> {
    return this.settingsService.getDto(key);
  }

  @Put(':key')
  async set(
    @Param('key') key: string,
    @Body() body: UpdateSettingBody,
  ): Promise<SettingDto> {
    return this.settingsService.set(key, body.value);
  }

  @Delete(':key')
  async delete(@Param('key') key: string): Promise<{ deleted: boolean }> {
    const deleted = await this.settingsService.delete(key);
    return { deleted };
  }
}
