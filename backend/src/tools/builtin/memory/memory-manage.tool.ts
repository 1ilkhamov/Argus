import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { MEMORY_KINDS, type MemoryKind } from '../../../memory/core/memory-entry.types';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition, ToolExecutionContext } from '../../core/tool.types';
import { MemoryToolsService } from '../../../memory/tools/memory-tools.service';

@Injectable()
export class MemoryManageTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(MemoryManageTool.name);

  readonly definition: ToolDefinition = {
    name: 'memory_manage',
    description:
      'Store, update, or forget entries in the long-term memory system. Use "store" to explicitly save a fact, preference, or note the user asks you to remember. Use "forget" to remove a memory the user wants deleted. Use "update" to correct or refine an existing memory. To search memory, use the knowledge_search tool instead.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: "store", "forget", or "update".',
          enum: ['store', 'forget', 'update'],
        },
        content: {
          type: 'string',
          description: 'Content to store (for "store" action) or new content (for "update" action).',
        },
        kind: {
          type: 'string',
          description: 'Memory kind for "store" action. Valid kinds: fact, episode, action, learning, skill, preference, identity.',
          enum: [...MEMORY_KINDS],
        },
        id: {
          type: 'string',
          description: 'Memory entry ID (for "forget" or "update" actions). Get IDs from knowledge_search results.',
        },
        tags: {
          type: 'array',
          description: 'Optional tags for "store" action (e.g. ["work", "preference"]).',
          items: { type: 'string' },
        },
        importance: {
          type: 'number',
          description: 'Importance score 0.0–1.0 for "store" action. Higher = more likely to be recalled. Default: auto.',
        },
        pinned: {
          type: 'boolean',
          description: 'If true, memory will never decay or be garbage-collected.',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly memoryTools: MemoryToolsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('memory_manage tool registered');
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const action = String(args.action ?? '');
    const scopeKey = context?.scopeKey;

    switch (action) {
      case 'store':
        return this.handleStore(args, scopeKey);
      case 'forget':
        return this.handleForget(args);
      case 'update':
        return this.handleUpdate(args);
      case 'search':
        return 'The "search" action has been removed from memory_manage. Use the knowledge_search tool instead.';
      default:
        return `Unknown action: "${action}". Use "store", "forget", or "update".`;
    }
  }

  // ─── Action handlers ─────────────────────────────────────────────────────────

  private async handleStore(args: Record<string, unknown>, scopeKey?: string): Promise<string> {
    const content = String(args.content ?? '').trim();
    const rawKind = String(args.kind ?? 'fact').trim();
    const kind = this.parseKind(rawKind);

    if (!content) return 'Error: "content" is required for store action.';
    if (!kind) return `Error: invalid kind "${rawKind}". Valid kinds: ${MEMORY_KINDS.join(', ')}.`;

    const result = await this.memoryTools.store({
      content,
      kind,
      tags: args.tags as string[] | undefined,
      importance: args.importance as number | undefined,
      pinned: args.pinned as boolean | undefined,
      scopeKey,
    });

    if (!result.success) return `Error: ${result.error}`;

    const entry = result.data!;
    return `Memory stored successfully.\nID: ${entry.id}\nKind: ${entry.kind}\nContent: ${entry.content}\nImportance: ${entry.importance}\nPinned: ${entry.pinned}`;
  }

  private async handleForget(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for forget action. Use "search" first to find the memory ID.';

    const result = await this.memoryTools.forget({ id });

    if (!result.success) return `Error: ${result.error}`;
    return `Memory ${id} forgotten successfully.`;
  }

  private async handleUpdate(args: Record<string, unknown>): Promise<string> {
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: "id" is required for update action. Use "search" first to find the memory ID.';

    const result = await this.memoryTools.update({
      id,
      content: args.content as string | undefined,
      tags: args.tags as string[] | undefined,
      importance: args.importance as number | undefined,
      pinned: args.pinned as boolean | undefined,
    });

    if (!result.success) return `Error: ${result.error}`;

    const entry = result.data!;
    return `Memory ${id} updated.\nContent: ${entry.content}\nImportance: ${entry.importance}\nPinned: ${entry.pinned}`;
  }

  private parseKind(value: unknown): MemoryKind | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const normalized = String(value).trim();
    return isMemoryKind(normalized) ? normalized : undefined;
  }
}

function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}
