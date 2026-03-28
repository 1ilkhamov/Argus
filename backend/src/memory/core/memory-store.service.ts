import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type {
  CreateMemoryEntryParams,
  MemoryEntry,
  MemoryQuery,
  UpdateMemoryEntryParams,
} from './memory-entry.types';
import {
  DEFAULT_DECAY_RATE,
  DEFAULT_HORIZON,
  DEFAULT_IMPORTANCE,
} from './memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from './memory-entry.repository';

@Injectable()
export class MemoryStoreService {
  private readonly logger = new Logger(MemoryStoreService.name);

  constructor(
    @Inject(MEMORY_ENTRY_REPOSITORY)
    private readonly repo: MemoryEntryRepository,
  ) {}

  // ─── Create ─────────────────────────────────────────────────────────────

  async create(params: CreateMemoryEntryParams): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const horizon = params.horizon ?? DEFAULT_HORIZON[params.kind];
    const entry: MemoryEntry = {
      id: randomUUID(),
      scopeKey: params.scopeKey ?? 'local:default',
      kind: params.kind,
      category: params.category,
      content: params.content,
      summary: params.summary,
      tags: params.tags ?? [],
      source: params.source,
      provenance: params.provenance,
      horizon,
      importance: params.importance ?? DEFAULT_IMPORTANCE[params.kind],
      decayRate: DEFAULT_DECAY_RATE[horizon],
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      pinned: params.pinned ?? false,
      consolidatedFrom: params.consolidatedFrom,
    };

    await this.repo.save(entry);
    this.logger.debug(`Created memory [${entry.kind}] id=${entry.id}: ${entry.content.slice(0, 80)}`);
    return entry;
  }

  async createBatch(paramsList: CreateMemoryEntryParams[]): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const now = new Date().toISOString();

    for (const params of paramsList) {
      const horizon = params.horizon ?? DEFAULT_HORIZON[params.kind];
      entries.push({
        id: randomUUID(),
        scopeKey: params.scopeKey ?? 'local:default',
        kind: params.kind,
        category: params.category,
        content: params.content,
        summary: params.summary,
        tags: params.tags ?? [],
        source: params.source,
        provenance: params.provenance,
        horizon,
        importance: params.importance ?? DEFAULT_IMPORTANCE[params.kind],
        decayRate: DEFAULT_DECAY_RATE[horizon],
        accessCount: 0,
        createdAt: now,
        updatedAt: now,
        pinned: params.pinned ?? false,
      });
    }

    await this.repo.saveBatch(entries);
    this.logger.debug(`Created ${entries.length} memory entries in batch`);
    return entries;
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  async getById(id: string): Promise<MemoryEntry | undefined> {
    return this.repo.findById(id);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.repo.query(query);
  }

  async getAll(): Promise<MemoryEntry[]> {
    return this.repo.query({});
  }

  async count(query?: MemoryQuery): Promise<number> {
    return this.repo.count(query ?? {});
  }

  // ─── Update ─────────────────────────────────────────────────────────────

  async update(id: string, params: UpdateMemoryEntryParams): Promise<MemoryEntry | undefined> {
    const existing = await this.repo.findById(id);
    if (!existing) return undefined;

    const updated: MemoryEntry = {
      ...existing,
      content: params.content ?? existing.content,
      summary: params.summary ?? existing.summary,
      tags: params.tags ?? existing.tags,
      importance: params.importance ?? existing.importance,
      horizon: params.horizon ?? existing.horizon,
      pinned: params.pinned ?? existing.pinned,
      supersededBy: params.supersededBy ?? existing.supersededBy,
      embeddingId: params.embeddingId ?? existing.embeddingId,
      updatedAt: new Date().toISOString(),
    };

    // If horizon changed, update decayRate
    if (params.horizon && params.horizon !== existing.horizon) {
      updated.decayRate = DEFAULT_DECAY_RATE[params.horizon];
    }

    await this.repo.save(updated);
    this.logger.debug(`Updated memory id=${id}`);
    return updated;
  }

  // ─── Access tracking ────────────────────────────────────────────────────

  async recordAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.repo.incrementAccessCount(ids);
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }

  async deleteBatch(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.repo.deleteBatch(ids);
  }

  async deleteByQuery(query: MemoryQuery): Promise<number> {
    const entries = await this.repo.query(query);
    if (entries.length === 0) return 0;
    return this.repo.deleteBatch(entries.map((e) => e.id));
  }

  // ─── Supersede ──────────────────────────────────────────────────────────

  async supersede(oldId: string, newEntry: CreateMemoryEntryParams): Promise<MemoryEntry | undefined> {
    const old = await this.repo.findById(oldId);
    if (!old) return undefined;

    const created = await this.create(newEntry);
    await this.update(oldId, { supersededBy: created.id });
    this.logger.debug(`Superseded memory ${oldId} → ${created.id}`);
    return created;
  }

  // ─── Working memory management ──────────────────────────────────────────

  async clearWorkingMemory(): Promise<number> {
    return this.deleteByQuery({ horizons: ['working'] });
  }
}
