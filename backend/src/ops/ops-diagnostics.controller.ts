import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AdminApiKeyGuard } from '../common/guards/admin-api-key.guard';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { OpsDiagnosticsPayload, OpsDiagnosticsService } from './ops-diagnostics.service';

@UseGuards(AdminApiKeyGuard, RateLimitGuard)
@Controller('ops')
export class OpsDiagnosticsController {
  constructor(private readonly opsDiagnosticsService: OpsDiagnosticsService) {}

  @Get('diagnostics')
  async getDiagnostics(@Query('scopeKey') scopeKey?: string): Promise<OpsDiagnosticsPayload> {
    return this.opsDiagnosticsService.getDiagnostics(scopeKey?.trim() || undefined);
  }
}
