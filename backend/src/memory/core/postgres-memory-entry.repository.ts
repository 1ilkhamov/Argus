import { Injectable, Logger } from '@nestjs/common';

import { PostgresConnectionService } from '../../storage/postgres-connection.service';
import { MemoryEntryRepository } from './memory-entry.repository';
import type {
  MemoryEntry,
  MemoryHorizon,
  MemoryKind,
  MemoryProvenance,
  MemoryQuery,
  MemorySource,
} from './memory-entry.types';

// ─── Row type from Postgres ─────────────────────────────────────────────────

interface MemoryEntryRow {
  id: string;
  scope_key: string;
  kind: MemoryKind;
  category: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: MemorySource;
  provenance_json: string | null;
  horizon: MemoryHorizon;
  importance: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  pinned: boolean;
  superseded_by: string | null;
  consolidated_from_json: string | null;
  embedding_id: string | null;
}

@Injectable()
export class PostgresMemoryEntryRepository extends MemoryEntryRepository {
  private readonly logger = new Logger(PostgresMemoryEntryRepository.name);

  constructor(private readonly connectionService: PostgresConnectionService) {
    super();
  }

  // ─── Save ───────────────────────────────────────────────────────────────

  async save(entry: MemoryEntry): Promise<void> {
    const pool = await this.connectionService.getPool();
    await pool.query(
      `INSERT INTO memory_entries (
        id, scope_key, kind, category, content, summary, tags_json,
        source, provenance_json, horizon, importance, decay_rate,
        access_count, last_accessed_at, created_at, updated_at,
        pinned, superseded_by, consolidated_from_json, embedding_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (id) DO UPDATE SET
        scope_key = EXCLUDED.scope_key,
        kind = EXCLUDED.kind,
        category = EXCLUDED.category,
        content = EXCLUDED.content,
        summary = EXCLUDED.summary,
        tags_json = EXCLUDED.tags_json,
        source = EXCLUDED.source,
        provenance_json = EXCLUDED.provenance_json,
        horizon = EXCLUDED.horizon,
        importance = EXCLUDED.importance,
        decay_rate = EXCLUDED.decay_rate,
        access_count = EXCLUDED.access_count,
        last_accessed_at = EXCLUDED.last_accessed_at,
        updated_at = EXCLUDED.updated_at,
        pinned = EXCLUDED.pinned,
        superseded_by = EXCLUDED.superseded_by,
        consolidated_from_json = EXCLUDED.consolidated_from_json,
        embedding_id = EXCLUDED.embedding_id`,
      this.entryToParams(entry),
    );
  }

  async saveBatch(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const pool = await this.connectionService.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        await client.query(
          `INSERT INTO memory_entries (
            id, scope_key, kind, category, content, summary, tags_json,
            source, provenance_json, horizon, importance, decay_rate,
            access_count, last_accessed_at, created_at, updated_at,
            pinned, superseded_by, consolidated_from_json, embedding_id
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (id) DO UPDATE SET
            scope_key = EXCLUDED.scope_key,
            kind = EXCLUDED.kind,
            category = EXCLUDED.category,
            content = EXCLUDED.content,
            summary = EXCLUDED.summary,
            tags_json = EXCLUDED.tags_json,
            source = EXCLUDED.source,
            provenance_json = EXCLUDED.provenance_json,
            horizon = EXCLUDED.horizon,
            importance = EXCLUDED.importance,
            decay_rate = EXCLUDED.decay_rate,
            access_count = EXCLUDED.access_count,
            last_accessed_at = EXCLUDED.last_accessed_at,
            updated_at = EXCLUDED.updated_at,
            pinned = EXCLUDED.pinned,
            superseded_by = EXCLUDED.superseded_by,
            consolidated_from_json = EXCLUDED.consolidated_from_json,
            embedding_id = EXCLUDED.embedding_id`,
          this.entryToParams(entry),
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  async findById(id: string): Promise<MemoryEntry | undefined> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<MemoryEntryRow>(
      `SELECT * FROM memory_entries WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? this.rowToEntry(result.rows[0]) : undefined;
  }

  async findByIds(ids: string[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    const pool = await this.connectionService.getPool();
    const result = await pool.query<MemoryEntryRow>(
      `SELECT * FROM memory_entries WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rows.map((row) => this.rowToEntry(row));
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const { sql, params } = this.buildQuerySql(query, false);
    const pool = await this.connectionService.getPool();
    const result = await pool.query<MemoryEntryRow>(sql, params);
    return result.rows.map((row) => this.rowToEntry(row));
  }

  async count(query: MemoryQuery): Promise<number> {
    const { sql, params } = this.buildQuerySql(query, true);
    const pool = await this.connectionService.getPool();
    const result = await pool.query<{ count: string }>(sql, params);
    return Number.parseInt(result.rows[0]?.count ?? '0', 10);
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query(`DELETE FROM memory_entries WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteBatch(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const pool = await this.connectionService.getPool();
    const result = await pool.query(
      `DELETE FROM memory_entries WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rowCount ?? 0;
  }

  // ─── Access tracking ────────────────────────────────────────────────────

  async incrementAccessCount(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const pool = await this.connectionService.getPool();
    await pool.query(
      `UPDATE memory_entries
       SET access_count = access_count + 1,
           last_accessed_at = $2
       WHERE id = ANY($1::text[])`,
      [ids, new Date().toISOString()],
    );
  }

  // ─── Query builder ─────────────────────────────────────────────────────

  private buildQuerySql(
    query: MemoryQuery,
    countOnly: boolean,
  ): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (query.scopeKey !== undefined) {
      conditions.push(`scope_key = $${paramIdx}`);
      params.push(query.scopeKey);
      paramIdx++;
    }

    if (query.kinds && query.kinds.length > 0) {
      conditions.push(`kind = ANY($${paramIdx}::text[])`);
      params.push(query.kinds);
      paramIdx++;
    }

    if (query.horizons && query.horizons.length > 0) {
      conditions.push(`horizon = ANY($${paramIdx}::text[])`);
      params.push(query.horizons);
      paramIdx++;
    }

    if (query.sources && query.sources.length > 0) {
      conditions.push(`source = ANY($${paramIdx}::text[])`);
      params.push(query.sources);
      paramIdx++;
    }

    if (query.category !== undefined) {
      conditions.push(`category = $${paramIdx}`);
      params.push(query.category);
      paramIdx++;
    }

    if (query.minImportance !== undefined) {
      conditions.push(`importance >= $${paramIdx}`);
      params.push(query.minImportance);
      paramIdx++;
    }

    if (query.pinned !== undefined) {
      conditions.push(`pinned = $${paramIdx}`);
      params.push(query.pinned);
      paramIdx++;
    }

    if (query.excludeSuperseded) {
      conditions.push(`superseded_by IS NULL`);
    }

    // Tag filtering uses JSON containment
    if (query.tags && query.tags.length > 0) {
      // All tags must be present
      for (const tag of query.tags) {
        conditions.push(`tags_json::jsonb ? $${paramIdx}`);
        params.push(tag);
        paramIdx++;
      }
    }

    if (query.tagsAny && query.tagsAny.length > 0) {
      // Any of the tags must be present
      conditions.push(`tags_json::jsonb ?| $${paramIdx}::text[]`);
      params.push(query.tagsAny);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (countOnly) {
      return { sql: `SELECT COUNT(*) AS count FROM memory_entries ${where}`, params };
    }

    const orderCol = this.resolveOrderColumn(query.orderBy);
    const orderDir = query.orderDirection === 'asc' ? 'ASC' : 'DESC';
    const order = `ORDER BY ${orderCol} ${orderDir}`;

    const limit = query.limit ? `LIMIT ${query.limit}` : '';
    const offset = query.offset ? `OFFSET ${query.offset}` : '';

    return {
      sql: `SELECT * FROM memory_entries ${where} ${order} ${limit} ${offset}`,
      params,
    };
  }

  private resolveOrderColumn(orderBy?: MemoryQuery['orderBy']): string {
    switch (orderBy) {
      case 'importance':
        return 'importance';
      case 'createdAt':
        return 'created_at';
      case 'accessCount':
        return 'access_count';
      case 'updatedAt':
      default:
        return 'updated_at';
    }
  }

  // ─── Mapping ────────────────────────────────────────────────────────────

  private rowToEntry(row: MemoryEntryRow): MemoryEntry {
    return {
      id: row.id,
      scopeKey: row.scope_key ?? 'local:default',
      kind: row.kind,
      category: row.category ?? undefined,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: this.parseJsonArray(row.tags_json),
      source: row.source,
      provenance: this.parseJson<MemoryProvenance>(row.provenance_json),
      horizon: row.horizon,
      importance: Number(row.importance),
      decayRate: Number(row.decay_rate),
      accessCount: Number(row.access_count),
      lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at).toISOString() : undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      pinned: row.pinned,
      supersededBy: row.superseded_by ?? undefined,
      consolidatedFrom: this.parseJsonArray(row.consolidated_from_json) as string[] | undefined,
      embeddingId: row.embedding_id ?? undefined,
    };
  }

  private entryToParams(entry: MemoryEntry): unknown[] {
    return [
      entry.id,                                         // $1
      entry.scopeKey ?? 'local:default',                // $2
      entry.kind,                                       // $3
      entry.category ?? null,                           // $4
      entry.content,                                    // $5
      entry.summary ?? null,                            // $6
      JSON.stringify(entry.tags),                       // $7
      entry.source,                                     // $8
      entry.provenance ? JSON.stringify(entry.provenance) : null, // $9
      entry.horizon,                                    // $10
      entry.importance,                                 // $11
      entry.decayRate,                                  // $12
      entry.accessCount,                                // $13
      entry.lastAccessedAt ?? null,                     // $14
      entry.createdAt,                                  // $15
      entry.updatedAt,                                  // $16
      entry.pinned,                                     // $17
      entry.supersededBy ?? null,                       // $18
      entry.consolidatedFrom ? JSON.stringify(entry.consolidatedFrom) : null, // $19
      entry.embeddingId ?? null,                        // $20
    ];
  }

  private parseJson<T>(value: string | null | undefined): T | undefined {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  private parseJsonArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
