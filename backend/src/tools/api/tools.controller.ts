import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { ToolRegistryService } from '../core/registry/tool-registry.service';
import { PendingNotifyService } from '../core/pending-notify.service';
import type { PendingNotifySnapshot } from '../core/pending-notify.types';

interface ToolInfoDto {
  name: string;
  description: string;
  safety: string;
  timeoutMs?: number;
  parameters: string[];
}

@UseGuards(ApiKeyGuard, RateLimitGuard)
@Controller('tools')
export class ToolsController {
  constructor(private readonly registry: ToolRegistryService) {}

  @Get()
  listTools(): ToolInfoDto[] {
    return this.registry.getDefinitions().map((d) => ({
      name: d.name,
      description: d.description,
      safety: d.safety,
      timeoutMs: d.timeoutMs,
      parameters: Object.keys(d.parameters.properties),
    }));
  }
}

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('notify-routing')
export class NotifyRoutingController {
  constructor(private readonly pendingNotify: PendingNotifyService) {}

  @Get()
  getSnapshot(@Query('limit') limit?: string): PendingNotifySnapshot {
    return this.pendingNotify.getSnapshot(this.parseLimit(limit));
  }

  private parseLimit(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 20;
    }
    return Math.min(Math.floor(parsed), 200);
  }
}
