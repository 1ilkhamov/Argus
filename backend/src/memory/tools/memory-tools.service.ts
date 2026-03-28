import { Injectable, Logger } from '@nestjs/common';

import { MemoryStoreService } from '../core/memory-store.service';
import type {
  MemoryEntry,
  MemoryKind,
} from '../core/memory-entry.types';
import { MEMORY_KINDS } from '../core/memory-entry.types';
// ─── Tool argument types ───────────────────────────────────────────────────

export interface MemoryStoreArgs {
  content: string;
  kind: MemoryKind;
  category?: string;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  scopeKey?: string;
}

export interface MemoryForgetArgs {
  id: string;
}

export interface MemoryUpdateArgs {
  id: string;
  content?: string;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
}

// ─── Tool result types ─────────────────────────────────────────────────────

export interface MemoryToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class MemoryToolsService {
  private readonly logger = new Logger(MemoryToolsService.name);

  constructor(
    private readonly memoryStore: MemoryStoreService,
  ) {}

  /** Store a new memory entry explicitly. */
  async store(args: MemoryStoreArgs): Promise<MemoryToolResult<MemoryEntry>> {
    try {
      if (!args.content || args.content.trim().length < 3) {
        return { success: false, error: 'Content must be at least 3 characters' };
      }
      if (!MEMORY_KINDS.includes(args.kind)) {
        return { success: false, error: `Invalid kind: ${args.kind}. Valid: ${MEMORY_KINDS.join(', ')}` };
      }

      const entry = await this.memoryStore.create({
        kind: args.kind,
        content: args.content.trim(),
        source: 'user_explicit',
        category: args.category,
        tags: args.tags ?? [],
        importance: args.importance,
        pinned: args.pinned,
        scopeKey: args.scopeKey,
      });

      this.logger.debug(`memory_store: created ${entry.id} [${entry.kind}] "${entry.content.slice(0, 60)}"`);
      return { success: true, data: entry };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`memory_store failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** Forget (soft-delete) a memory entry by id. */
  async forget(args: MemoryForgetArgs): Promise<MemoryToolResult<{ deleted: boolean }>> {
    try {
      if (!args.id) {
        return { success: false, error: 'Memory id is required' };
      }

      const existing = await this.memoryStore.getById(args.id);
      if (!existing) {
        return { success: false, error: `Memory ${args.id} not found` };
      }

      if (existing.pinned) {
        return { success: false, error: `Memory ${args.id} is pinned and cannot be forgotten` };
      }

      await this.memoryStore.update(args.id, { supersededBy: 'forgotten' });

      this.logger.debug(`memory_forget: ${args.id} marked as forgotten`);
      return { success: true, data: { deleted: true } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`memory_forget failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** Update an existing memory entry. */
  async update(args: MemoryUpdateArgs): Promise<MemoryToolResult<MemoryEntry>> {
    try {
      if (!args.id) {
        return { success: false, error: 'Memory id is required' };
      }

      const existing = await this.memoryStore.getById(args.id);
      if (!existing) {
        return { success: false, error: `Memory ${args.id} not found` };
      }

      const updates: Record<string, unknown> = {};
      if (args.content !== undefined) updates.content = args.content.trim();
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.importance !== undefined) updates.importance = Math.max(0, Math.min(1, args.importance));
      if (args.pinned !== undefined) updates.pinned = args.pinned;

      if (Object.keys(updates).length === 0) {
        return { success: false, error: 'No updates provided' };
      }

      await this.memoryStore.update(args.id, updates);
      const updated = await this.memoryStore.getById(args.id);

      this.logger.debug(`memory_update: ${args.id} updated (${Object.keys(updates).join(', ')})`);
      return { success: true, data: updated ?? existing };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`memory_update failed: ${msg}`);
      return { success: false, error: msg };
    }
  }
}
