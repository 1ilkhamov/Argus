import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmbeddingService } from '../../embedding/embedding.service';
import { PostgresConnectionService } from '../../storage/postgres-connection.service';
import type { MemoryEntry, RecalledMemory } from '../core/memory-entry.types';
import { MEMORY_ENTRY_REPOSITORY, type MemoryEntryRepository } from '../core/memory-entry.repository';
import { MemoryStoreService } from '../core/memory-store.service';
import { QdrantVectorService } from '../qdrant/qdrant-vector.service';
import type { QdrantFilter } from '../qdrant/qdrant-vector.types';
import { KNOWLEDGE_GRAPH_REPOSITORY, type KnowledgeGraphRepository } from '../knowledge-graph/repositories/knowledge-graph.repository';
import {
  type MergeOptions,
  type RankedCandidate,
  type DiversityOptions,
  mergeRecallResults,
  normalizeScores,
  assignConfidence,
  detectContradictions,
  applyDiversityFilter,
} from './recall-merger';

export interface RecallOptions {
  limit?: number;
  minScore?: number;
  kinds?: MemoryEntry['kind'][];
  horizons?: MemoryEntry['horizon'][];
  tags?: string[];
  includeGraph?: boolean;
  scopeKey?: string;
}

const DEFAULT_RECALL_LIMIT = 15;
const DEFAULT_SEMANTIC_LIMIT = 20;
const DEFAULT_KEYWORD_LIMIT = 10;
const DEFAULT_GRAPH_LIMIT = 5;
const DEFAULT_MIN_SEMANTIC_SCORE = 0.25;

@Injectable()
export class AutoRecallService {
  private readonly logger = new Logger(AutoRecallService.name);
  private readonly postgresAvailable: boolean;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly qdrantService: QdrantVectorService,
    @Inject(KNOWLEDGE_GRAPH_REPOSITORY) private readonly kgRepo: KnowledgeGraphRepository,
    private readonly postgresConnection: PostgresConnectionService,
    @Inject(MEMORY_ENTRY_REPOSITORY) private readonly repo: MemoryEntryRepository,
    private readonly store: MemoryStoreService,
    configService: ConfigService,
  ) {
    this.postgresAvailable = configService.get<string>('storage.driver', 'sqlite') === 'postgres';
  }

  /**
   * Hybrid recall: semantic (Qdrant) + keyword (Postgres FTS) + knowledge graph.
   * Results are merged via RRF with importance/recency boost.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecalledMemory[]> {
    const limit = options.limit ?? DEFAULT_RECALL_LIMIT;

    const [semanticResults, keywordResults, graphResults] = await Promise.all([
      this.semanticSearch(query, options),
      this.keywordSearch(query, options),
      options.includeGraph !== false ? this.graphSearch(query, options) : Promise.resolve([]),
    ]);

    const rankedLists: RankedCandidate[][] = [semanticResults, keywordResults];
    if (graphResults.length > 0) {
      rankedLists.push(graphResults);
    }

    const mergeOpts: MergeOptions = {
      limit,
      minScore: options.minScore,
    };

    // Full recall pipeline: merge → normalize → confidence → diversity → contradictions
    const merged = mergeRecallResults(rankedLists, mergeOpts);
    const normalized = normalizeScores(merged);
    const withConfidence = assignConfidence(normalized);
    const diversityOpts: DiversityOptions = { totalBudget: limit };
    const diverse = applyDiversityFilter(withConfidence, diversityOpts);
    const final = detectContradictions(diverse);

    this.logger.debug(
      `Recall for "${query.slice(0, 60)}": semantic=${semanticResults.length}, keyword=${keywordResults.length}, graph=${graphResults.length} → merged=${normalized.length} → diverse=${final.length}`,
    );

    // Track access for lifecycle promotion
    if (final.length > 0) {
      const ids = final.map((r) => r.entry.id);
      this.store.recordAccess(ids).catch((err) => {
        this.logger.warn(`recordAccess failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    return final;
  }

  // ─── Semantic search via Qdrant ───────────────────────────────────────

  private async semanticSearch(query: string, options: RecallOptions): Promise<RankedCandidate[]> {
    if (!this.qdrantService.isReady() || !this.embeddingService.isAvailable()) {
      return [];
    }

    try {
      const embeddingResult = await this.embeddingService.embedQuery(query);
      if (!embeddingResult) return [];

      const filter = this.buildQdrantFilter(options);
      const results = await this.qdrantService.search(
        embeddingResult.embedding,
        DEFAULT_SEMANTIC_LIMIT,
        filter,
        DEFAULT_MIN_SEMANTIC_SCORE,
      );

      if (results.length === 0) return [];

      // Fetch full entries by IDs from the results
      const entryIds = results.map((r) => r.id);
      const entries = await this.fetchEntriesByIds(entryIds);
      const entryMap = new Map(entries.map((e) => [e.id, e]));

      return results
        .filter((r) => entryMap.has(r.id))
        // Post-filter by scopeKey (Qdrant payload may not have it for legacy points)
        .filter((r) => {
          if (!options.scopeKey) return true;
          const entry = entryMap.get(r.id)!;
          return entry.scopeKey === options.scopeKey;
        })
        .map((r) => ({
          entry: entryMap.get(r.id)!,
          score: r.score,
          source: 'semantic' as const,
        }));
    } catch (error) {
      this.logger.warn(`Semantic search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ─── Keyword search via Postgres FTS ──────────────────────────────────

  private async keywordSearch(query: string, options: RecallOptions): Promise<RankedCandidate[]> {
    if (!this.postgresAvailable) {
      return this.keywordSearchSqlite(query, options);
    }

    try {
      const pool = await this.postgresConnection.getPool();

      // Build tsquery from words
      const words = query
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .filter((w) => w.length >= 2)
        .slice(0, 8);

      if (words.length === 0) return [];

      const tsQuery = words.map((w) => `${w}:*`).join(' | ');

      const conditions: string[] = [`to_tsvector('simple', content) @@ to_tsquery('simple', $1)`];
      const params: unknown[] = [tsQuery];
      let paramIdx = 2;

      if (options.kinds && options.kinds.length > 0) {
        conditions.push(`kind = ANY($${paramIdx}::text[])`);
        params.push(options.kinds);
        paramIdx++;
      }

      if (options.horizons && options.horizons.length > 0) {
        conditions.push(`horizon = ANY($${paramIdx}::text[])`);
        params.push(options.horizons);
        paramIdx++;
      }

      if (options.tags && options.tags.length > 0) {
        conditions.push(`tags_json::text ILIKE ALL(ARRAY[${options.tags.map(() => `$${paramIdx++}`).join(', ')}])`);
        params.push(...options.tags.map((t) => `%${t}%`));
      }

      conditions.push(`superseded_by IS NULL`);

      if (options.scopeKey) {
        conditions.push(`scope_key = $${paramIdx}`);
        params.push(options.scopeKey);
        paramIdx++;
      }

      const sql = `
        SELECT *, ts_rank(to_tsvector('simple', content), to_tsquery('simple', $1)) AS rank
        FROM memory_entries
        WHERE ${conditions.join(' AND ')}
        ORDER BY rank DESC
        LIMIT ${DEFAULT_KEYWORD_LIMIT}
      `;

      const result = await pool.query<Record<string, unknown> & { rank: number }>(sql, params);

      return result.rows.map((row) => ({
        entry: this.rowToEntry(row),
        score: Number(row.rank),
        source: 'keyword' as const,
      }));
    } catch (error) {
      this.logger.warn(`Keyword search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ─── SQLite keyword search fallback ──────────────────────────────

  private async keywordSearchSqlite(query: string, options: RecallOptions): Promise<RankedCandidate[]> {
    try {
      const words = query
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 2)
        .slice(0, 8);

      if (words.length === 0) return [];

      // Fetch candidate entries via repo (excludeSuperseded, filtered by kind/horizon/scope)
      const entries = await this.repo.query({
        excludeSuperseded: true,
        limit: 50,
        ...(options.scopeKey ? { scopeKey: options.scopeKey } : {}),
        ...(options.kinds ? { kinds: options.kinds } : {}),
        ...(options.horizons ? { horizons: options.horizons } : {}),
        ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
      });

      if (entries.length === 0) return [];

      // Score each entry by word overlap with query
      const scored: RankedCandidate[] = [];
      for (const entry of entries) {
        const entryText = `${entry.content} ${entry.tags.join(' ')} ${entry.category ?? ''}`.toLowerCase();
        let hits = 0;
        for (const word of words) {
          if (entryText.includes(word)) hits++;
        }
        if (hits > 0) {
          scored.push({
            entry,
            score: hits / words.length,
            source: 'keyword' as const,
          });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, DEFAULT_KEYWORD_LIMIT);
    } catch (error) {
      this.logger.warn(`SQLite keyword search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ─── Knowledge Graph expansion ────────────────────────────────────────

  private async graphSearch(query: string, options: RecallOptions): Promise<RankedCandidate[]> {

    try {
      // Find nodes matching query words
      const words = query.split(/\s+/).filter((w) => w.length >= 3).slice(0, 5);
      if (words.length === 0) return [];

      const matchedNodes = await this.kgRepo.searchNodes({
        namePattern: words[0],
        limit: 3,
      });

      if (matchedNodes.length === 0) return [];

      // Traverse from matched nodes to find related entries
      const relatedNodes: Array<{ id: string; name: string }> = [];
      for (const node of matchedNodes) {
        relatedNodes.push({ id: node.id, name: node.name });
        const neighbors = await this.kgRepo.traverse({
          startNodeId: node.id,
          maxDepth: 1,
          limit: DEFAULT_GRAPH_LIMIT,
        });
        for (const n of neighbors) {
          relatedNodes.push({ id: n.id, name: n.name });
        }
      }

      // Search memory entries that mention seed + expanded node names
      const nodeNames = [...new Set(relatedNodes.map((n) => n.name))];
      if (nodeNames.length === 0) return [];

      const entries = await this.repo.query({
        tagsAny: nodeNames,
        excludeSuperseded: true,
        limit: DEFAULT_GRAPH_LIMIT,
        ...(options.scopeKey ? { scopeKey: options.scopeKey } : {}),
        ...(options.kinds ? { kinds: options.kinds } : {}),
        ...(options.horizons ? { horizons: options.horizons } : {}),
        ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
      });

      return entries.map((entry, idx) => ({
        entry,
        score: 1 / (idx + 1), // rank-based score
        source: 'graph' as const,
      }));
    } catch (error) {
      this.logger.warn(`Graph search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private buildQdrantFilter(options: RecallOptions): QdrantFilter | undefined {
    const must: Array<{ key: string; match: { value: string | number | boolean } } | { key: string; match: { any: string[] } }> = [];

    if (options.scopeKey) {
      must.push({ key: 'scope_key', match: { value: options.scopeKey } });
    }
    if (options.kinds && options.kinds.length > 0) {
      must.push({ key: 'kind', match: { any: options.kinds } });
    }
    if (options.horizons && options.horizons.length > 0) {
      must.push({ key: 'horizon', match: { any: options.horizons } });
    }
    if (options.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        must.push({ key: 'tags', match: { value: tag } });
      }
    }

    return must.length > 0 ? { must } : undefined;
  }

  private async fetchEntriesByIds(ids: string[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    return this.repo.findByIds(ids);
  }

  private rowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      id: row.id as string,
      scopeKey: (row.scope_key as string) ?? 'local:default',
      kind: row.kind as MemoryEntry['kind'],
      category: (row.category as string) ?? undefined,
      content: row.content as string,
      summary: (row.summary as string) ?? undefined,
      tags: row.tags_json ? (JSON.parse(row.tags_json as string) as string[]) : [],
      source: row.source as MemoryEntry['source'],
      provenance: row.provenance_json ? (JSON.parse(row.provenance_json as string)) : undefined,
      horizon: row.horizon as MemoryEntry['horizon'],
      importance: Number(row.importance),
      decayRate: Number(row.decay_rate),
      accessCount: Number(row.access_count),
      lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at as string).toISOString() : undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      pinned: row.pinned as boolean,
      supersededBy: (row.superseded_by as string) ?? undefined,
      consolidatedFrom: row.consolidated_from_json ? (JSON.parse(row.consolidated_from_json as string) as string[]) : undefined,
      embeddingId: (row.embedding_id as string) ?? undefined,
    };
  }
}
