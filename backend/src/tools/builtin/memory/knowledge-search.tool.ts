import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { AutoRecallService, type RecallOptions } from '../../../memory/recall/auto-recall.service';
import { MEMORY_KINDS, type MemoryKind, type RecalledMemory } from '../../../memory/core/memory-entry.types';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition, ToolExecutionContext } from '../../core/tool.types';

/** Maximum results to return */
const MAX_RESULTS = 20;
/** Default number of results */
const DEFAULT_LIMIT = 10;
/** Maximum query length */
const MAX_QUERY_LENGTH = 500;
/** Maximum snippet length for content display */
const MAX_CONTENT_DISPLAY = 300;

@Injectable()
export class KnowledgeSearchTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(KnowledgeSearchTool.name);

  readonly definition: ToolDefinition = {
    name: 'knowledge_search',
    description:
      'Search through your long-term memory and knowledge base using hybrid retrieval (semantic similarity, keyword matching, and knowledge graph expansion). ' +
      'Use this to recall facts, past episodes, user preferences, learnings, or any previously stored information. ' +
      'Returns ranked results with confidence scores and match sources. ' +
      'This is a READ-ONLY search — use memory_manage for storing, updating, or deleting memories.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query. Be specific for better results (e.g. "user\'s preferred programming language" instead of "preferences").',
        },
        kinds: {
          type: 'array',
          description:
            'Filter by memory kinds. Valid kinds: fact, episode, action, learning, skill, preference, identity. ' +
            'Omit to search all kinds.',
          items: {
            type: 'string',
            enum: [...MEMORY_KINDS],
          },
        },
        tags: {
          type: 'array',
          description: 'Filter results to entries that have ALL of these tags.',
          items: { type: 'string' },
        },
        min_importance: {
          type: 'number',
          description: 'Minimum importance threshold (0.0–1.0). Only return memories at or above this importance level.',
        },
        include_graph: {
          type: 'boolean',
          description: 'Whether to include knowledge graph expansion in search (default: true). Disable for faster, simpler search.',
        },
        limit: {
          type: 'number',
          description: `Maximum results to return (1–${MAX_RESULTS}, default ${DEFAULT_LIMIT}).`,
        },
      },
      required: ['query'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly autoRecall: AutoRecallService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('knowledge_search tool registered');
  }

  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return 'Error: "query" is required. Provide a natural language search query.';
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return `Error: Query too long (${query.length} chars, max ${MAX_QUERY_LENGTH}).`;
    }

    // Parse and validate filters
    const kinds = this.parseKinds(args.kinds);
    if (args.kinds !== undefined && kinds === null) {
      return `Error: Invalid kind(s). Valid kinds: ${MEMORY_KINDS.join(', ')}.`;
    }

    const tags = Array.isArray(args.tags)
      ? (args.tags as unknown[]).map(String).filter((t) => t.length > 0)
      : undefined;

    const minImportance = typeof args.min_importance === 'number'
      ? Math.max(0, Math.min(1, args.min_importance))
      : undefined;

    const includeGraph = args.include_graph !== false;

    const limit = Math.min(
      Math.max(Number(args.limit) || DEFAULT_LIMIT, 1),
      MAX_RESULTS,
    );

    // Build recall options
    const recallOptions: RecallOptions = {
      limit,
      kinds: kinds ?? undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
      includeGraph,
      scopeKey: context?.scopeKey,
    };

    try {
      let results = await this.autoRecall.recall(query, recallOptions);

      // Post-filter by min_importance (recall doesn't support this natively)
      if (minImportance !== undefined) {
        results = results.filter((r) => r.entry.importance >= minImportance);
      }

      if (results.length === 0) {
        return this.formatEmpty(query, kinds, tags);
      }

      return this.formatResults(query, results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`knowledge_search failed for "${query.slice(0, 60)}": ${message}`);
      return `Error searching knowledge base: ${message}`;
    }
  }

  // ─── Formatting ─────────────────────────────────────────────────────────────

  private formatResults(query: string, results: RecalledMemory[]): string {
    const lines: string[] = [
      `Found ${results.length} result(s) for: "${query}"`,
      '',
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const e = r.entry;

      // Header: index, kind, confidence, match source
      lines.push(
        `[${i + 1}] ${e.kind.toUpperCase()} — confidence: ${r.confidence}, source: ${r.matchSource}, score: ${r.score.toFixed(3)}`,
      );

      // Content (truncated)
      const content = e.summary || e.content;
      lines.push(`    ${truncate(content, MAX_CONTENT_DISPLAY)}`);

      // Metadata line
      const meta: string[] = [];
      meta.push(`importance: ${e.importance.toFixed(2)}`);
      meta.push(`horizon: ${e.horizon}`);
      if (e.pinned) meta.push('📌 pinned');
      if (e.category) meta.push(`category: ${e.category}`);
      if (e.tags.length > 0) meta.push(`tags: [${e.tags.join(', ')}]`);
      meta.push(`id: ${e.id}`);
      lines.push(`    ${meta.join(' | ')}`);

      // Dates
      const created = e.createdAt.split('T')[0];
      const accessed = e.lastAccessedAt ? e.lastAccessedAt.split('T')[0] : 'never';
      lines.push(`    created: ${created} | last accessed: ${accessed} | accesses: ${e.accessCount}`);

      // Contradiction warning
      if (r.contradicts && r.contradicts.length > 0) {
        lines.push(`    ⚠ May contradict: ${r.contradicts.join(', ')}`);
      }

      lines.push('');
    }

    return lines.join('\n').trim();
  }

  private formatEmpty(query: string, kinds: MemoryKind[] | null, tags: string[] | undefined): string {
    const parts = [`No memories found for: "${query}"`];
    const filters: string[] = [];
    if (kinds) filters.push(`kinds: ${kinds.join(', ')}`);
    if (tags && tags.length > 0) filters.push(`tags: ${tags.join(', ')}`);
    if (filters.length > 0) {
      parts.push(`Filters applied: ${filters.join('; ')}`);
    }
    parts.push('Try broadening your query or removing filters.');
    return parts.join('\n');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseKinds(value: unknown): MemoryKind[] | null {
    if (value === undefined || value === null) return null;

    if (!Array.isArray(value)) {
      const single = String(value).trim();
      return isMemoryKind(single) ? [single] : null;
    }

    const kinds: MemoryKind[] = [];
    for (const item of value) {
      const k = String(item).trim();
      if (!isMemoryKind(k)) return null;
      kinds.push(k);
    }

    return kinds.length > 0 ? kinds : null;
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\n/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}
