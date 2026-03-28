import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';

import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

import { AdminApiKeyGuard } from '../../common/guards/admin-api-key.guard';
import { AuthenticatedUserGuard } from '../../common/guards/authenticated-user.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import type { MemoryEntry, MemoryHorizon, MemoryKind } from '../core/memory-entry.types';
import { MEMORY_KINDS } from '../core/memory-entry.types';
import { AutoCaptureService } from '../capture/pipeline/auto-capture.service';
import { MemoryStoreService } from '../core/memory-store.service';
import { KnowledgeGraphService } from '../knowledge-graph/knowledge-graph.service';
import { MemoryLifecycleV2Service } from '../lifecycle/memory-lifecycle-v2.service';

// ─── DTOs ────────────────────────────────────────────────────────────────────

interface MemoryEntryDto {
  id: string;
  kind: MemoryKind;
  category?: string;
  content: string;
  summary?: string;
  tags: string[];
  source: string;
  horizon: MemoryHorizon;
  importance: number;
  accessCount: number;
  pinned: boolean;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

class CreateMemoryDto {
  @IsIn(MEMORY_KINDS as readonly string[])
  kind!: MemoryKind;

  @IsString()
  @MinLength(3)
  content!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  importance?: number;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

class UpdateMemoryDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  content?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  importance?: number;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsIn(['working', 'short_term', 'long_term'])
  horizon?: MemoryHorizon;
}

interface MemoryListResponse {
  entries: MemoryEntryDto[];
  total: number;
}

interface KgNodeDto {
  id: string;
  type: string;
  name: string;
  properties: Record<string, string>;
}

interface KgNeighborhoodDto {
  center?: KgNodeDto;
  neighbors: KgNodeDto[];
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    relation: string;
    weight: number;
  }>;
}

// ─── Controller ──────────────────────────────────────────────────────────────

@UseGuards(AuthenticatedUserGuard, RateLimitGuard)
@Controller('memory/v2')
export class MemoryV2Controller {
  private readonly logger = new Logger(MemoryV2Controller.name);

  constructor(
    private readonly store: MemoryStoreService,
    private readonly kgService: KnowledgeGraphService,
    private readonly lifecycleService: MemoryLifecycleV2Service,
    private readonly autoCaptureService: AutoCaptureService,
  ) {}

  // ─── Memory Entries ─────────────────────────────────────────────────────

  @Get('entries')
  async listEntries(
    @Req() req: Request,
    @Query('kind') kind?: string,
    @Query('horizon') horizon?: string,
    @Query('pinned') pinned?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('orderBy') orderBy?: string,
    @Query('scopeKey') queryScopeKey?: string,
  ): Promise<MemoryListResponse> {
    const { scopeKey: callerScope, role } = req.identity!;
    const scopeKey = (role === 'admin' && queryScopeKey) ? queryScopeKey : callerScope;
    const query = {
      scopeKey,
      ...(kind ? { kinds: [kind as MemoryKind] } : {}),
      ...(horizon ? { horizons: [horizon as MemoryHorizon] } : {}),
      ...(pinned !== undefined ? { pinned: pinned === 'true' } : {}),
      excludeSuperseded: true,
      limit: Math.min(Number(limit) || 50, 200),
      offset: Number(offset) || 0,
      orderBy: (orderBy as 'importance' | 'createdAt' | 'updatedAt') || 'updatedAt',
      orderDirection: 'desc' as const,
    };

    const [entries, total] = await Promise.all([
      this.store.query(query),
      this.store.count(query),
    ]);

    return {
      entries: entries.map(toDto),
      total,
    };
  }

  @Get('entries/:id')
  async getEntry(@Param('id') id: string, @Req() req: Request): Promise<MemoryEntryDto> {
    const entry = await this.store.getById(id);
    if (!entry) throw new NotFoundException(`Memory entry ${id} not found`);
    // Scope check: non-admin users can only see their own entries
    const { scopeKey, role } = req.identity!;
    if (role !== 'admin' && entry.scopeKey !== scopeKey) {
      throw new NotFoundException(`Memory entry ${id} not found`);
    }
    return toDto(entry);
  }

  @Post('entries')
  async createEntry(@Body() dto: CreateMemoryDto, @Req() req: Request): Promise<MemoryEntryDto> {
    const { scopeKey } = req.identity!;
    const entry = await this.store.create({
      kind: dto.kind,
      content: dto.content.trim(),
      source: 'user_explicit',
      scopeKey,
      category: dto.category,
      tags: dto.tags,
      importance: dto.importance !== undefined ? Math.max(0, Math.min(1, dto.importance)) : undefined,
      pinned: dto.pinned,
    });

    return toDto(entry);
  }

  @Patch('entries/:id')
  async updateEntry(@Param('id') id: string, @Body() dto: UpdateMemoryDto, @Req() req: Request): Promise<MemoryEntryDto> {
    const updates: Record<string, unknown> = {};
    if (dto.content !== undefined) updates.content = dto.content;
    if (dto.tags !== undefined) updates.tags = dto.tags;
    if (dto.importance !== undefined) updates.importance = Math.max(0, Math.min(1, dto.importance));
    if (dto.pinned !== undefined) updates.pinned = dto.pinned;
    if (dto.horizon !== undefined) updates.horizon = dto.horizon;

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No updates provided');
    }

    // Scope check: ensure entry belongs to caller
    const existing = await this.store.getById(id);
    const { scopeKey, role } = req.identity!;
    if (!existing || (role !== 'admin' && existing.scopeKey !== scopeKey)) {
      throw new NotFoundException(`Memory entry ${id} not found`);
    }

    const entry = await this.store.update(id, updates);
    if (!entry) throw new NotFoundException(`Memory entry ${id} not found`);
    return toDto(entry);
  }

  @Delete('entries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEntry(@Param('id') id: string, @Req() req: Request): Promise<void> {
    // Scope check: ensure entry belongs to caller
    const existing = await this.store.getById(id);
    const { scopeKey, role } = req.identity!;
    if (!existing || (role !== 'admin' && existing.scopeKey !== scopeKey)) {
      throw new NotFoundException(`Memory entry ${id} not found`);
    }
    const deleted = await this.store.delete(id);
    if (!deleted) throw new NotFoundException(`Memory entry ${id} not found`);
  }

  @Post('entries/:id/pin')
  async pinEntry(@Param('id') id: string, @Body() body: { pinned: boolean }, @Req() req: Request): Promise<MemoryEntryDto> {
    // Scope check: ensure entry belongs to caller
    const existing = await this.store.getById(id);
    const { scopeKey, role } = req.identity!;
    if (!existing || (role !== 'admin' && existing.scopeKey !== scopeKey)) {
      throw new NotFoundException(`Memory entry ${id} not found`);
    }
    const entry = await this.store.update(id, { pinned: body.pinned });
    if (!entry) throw new NotFoundException(`Memory entry ${id} not found`);
    return toDto(entry);
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  @Get('stats')
  async getStats(@Req() req: Request, @Query('scopeKey') queryScopeKey?: string): Promise<Record<string, number>> {
    const { scopeKey: callerScope, role } = req.identity!;
    const scopeKey = (role === 'admin' && queryScopeKey) ? queryScopeKey : callerScope;
    const base = { scopeKey, excludeSuperseded: true };
    const [total, facts, episodes, actions, learnings, skills, preferences, pinned, longTerm, shortTerm, working] =
      await Promise.all([
        this.store.count(base),
        this.store.count({ ...base, kinds: ['fact'] }),
        this.store.count({ ...base, kinds: ['episode'] }),
        this.store.count({ ...base, kinds: ['action'] }),
        this.store.count({ ...base, kinds: ['learning'] }),
        this.store.count({ ...base, kinds: ['skill'] }),
        this.store.count({ ...base, kinds: ['preference'] }),
        this.store.count({ ...base, pinned: true }),
        this.store.count({ ...base, horizons: ['long_term'] }),
        this.store.count({ ...base, horizons: ['short_term'] }),
        this.store.count({ ...base, horizons: ['working'] }),
      ]);

    return { total, facts, episodes, actions, learnings, skills, preferences, pinned, longTerm, shortTerm, working };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  @Post('lifecycle/run')
  @UseGuards(AdminApiKeyGuard)
  async runLifecycle(): Promise<{ decayed: number; promoted: number; consolidated: number; pruned: number }> {
    return this.lifecycleService.runFullCycle();
  }

  @Post('embeddings/backfill')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminApiKeyGuard)
  async backfillEmbeddings(): Promise<{ embedded: number; skipped: number }> {
    return this.autoCaptureService.backfillEmbeddings();
  }

  // ─── Knowledge Graph ────────────────────────────────────────────────────

  @Get('graph/nodes')
  async searchNodes(
    @Query('type') type?: string,
    @Query('name') name?: string,
    @Query('limit') limit?: string,
  ): Promise<KgNodeDto[]> {
    const nodes = await this.kgService.searchNodes({
      type,
      namePattern: name,
      limit: Math.min(Number(limit) || 50, 200),
    });

    return nodes.map(toNodeDto);
  }

  @Get('graph/nodes/:id/neighborhood')
  async getNodeNeighborhood(
    @Param('id') id: string,
    @Query('depth') depth?: string,
  ): Promise<KgNeighborhoodDto> {
    const result = await this.kgService.getNeighborhood(id, Number(depth) || 1, 30);

    return {
      center: result.center ? toNodeDto(result.center) : undefined,
      neighbors: result.neighbors.map(toNodeDto),
      edges: result.edges.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        relation: e.relation,
        weight: e.weight,
      })),
    };
  }
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function toDto(entry: MemoryEntry): MemoryEntryDto {
  return {
    id: entry.id,
    kind: entry.kind,
    category: entry.category,
    content: entry.content,
    summary: entry.summary,
    tags: entry.tags,
    source: entry.source,
    horizon: entry.horizon,
    importance: entry.importance,
    accessCount: entry.accessCount,
    pinned: entry.pinned,
    supersededBy: entry.supersededBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toNodeDto(node: { id: string; type: string; name: string; properties: Record<string, string> }): KgNodeDto {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    properties: node.properties,
  };
}
