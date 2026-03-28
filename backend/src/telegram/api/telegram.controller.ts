import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { TelegramService, type TelegramStatus } from '../bot/telegram.service';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Get('status')
  getStatus(): TelegramStatus {
    return this.telegramService.getStatus();
  }

  @Post('restart')
  async restart(): Promise<TelegramStatus> {
    return this.telegramService.restart();
  }

  @Post('stop')
  async stop(): Promise<TelegramStatus> {
    return this.telegramService.stop();
  }
}
