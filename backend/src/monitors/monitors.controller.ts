import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { TelegramWatchdogService } from './telegram-watchdog.service';
import type {
  CreateTelegramWatchRuleParams,
  TelegramWatchAlertRecord,
  TelegramWatchEvaluationResult,
  TelegramWatchRule,
  TelegramWatchState,
  UpdateTelegramWatchRuleParams,
} from './monitor.types';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('monitors')
export class MonitorsController {
  constructor(private readonly watchdogService: TelegramWatchdogService) {}

  @Get('rules')
  async listRules(): Promise<TelegramWatchRule[]> {
    return this.watchdogService.listRules();
  }

  @Post('rules')
  async createRule(@Body() body: CreateTelegramWatchRuleParams): Promise<TelegramWatchRule> {
    if (!body.monitoredChatId?.trim()) {
      throw new Error('monitoredChatId is required.');
    }

    return this.watchdogService.createRule({
      monitoredChatId: body.monitoredChatId.trim(),
      name: body.name,
      thresholdSeconds: body.thresholdSeconds,
      enabled: body.enabled,
    });
  }

  @Patch('rules/:id')
  async updateRule(
    @Param('id') id: string,
    @Body() body: UpdateTelegramWatchRuleParams,
  ): Promise<TelegramWatchRule> {
    if (!id.trim()) {
      throw new Error('id is required.');
    }

    return this.watchdogService.updateRule(id, {
      monitoredChatId: body.monitoredChatId?.trim(),
      name: body.name,
      thresholdSeconds: body.thresholdSeconds,
      enabled: body.enabled,
    });
  }

  @Delete('rules/:id')
  async deleteRule(@Param('id') id: string): Promise<{ deleted: boolean }> {
    if (!id.trim()) {
      throw new Error('id is required.');
    }

    return { deleted: await this.watchdogService.deleteRule(id) };
  }

  @Post('rules/:id/run')
  async runRule(@Param('id') id: string): Promise<TelegramWatchEvaluationResult> {
    if (!id.trim()) {
      throw new Error('id is required.');
    }

    return this.watchdogService.runRule(id);
  }

  @Get('states')
  async listStates(): Promise<TelegramWatchState[]> {
    return this.watchdogService.listStates();
  }

  @Get('evaluations')
  async listEvaluations(
    @Query('ruleId') ruleId?: string,
    @Query('limit') limit?: string,
  ): Promise<TelegramWatchEvaluationResult[]> {
    return this.watchdogService.listEvaluations(ruleId?.trim() || undefined, this.parseLimit(limit));
  }

  @Get('alerts')
  async listAlerts(
    @Query('ruleId') ruleId?: string,
    @Query('limit') limit?: string,
  ): Promise<TelegramWatchAlertRecord[]> {
    return this.watchdogService.listAlertHistory(ruleId?.trim() || undefined, this.parseLimit(limit));
  }

  private parseLimit(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 50;
    }
    return Math.min(Math.floor(parsed), 200);
  }
}
