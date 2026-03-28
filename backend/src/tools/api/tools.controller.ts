import { Controller, Get, UseGuards } from '@nestjs/common';

import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { ToolRegistryService } from '../core/registry/tool-registry.service';

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
