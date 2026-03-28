import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PostgresConnectionService } from '../../../storage/postgres-connection.service';
import { KnowledgeGraphRepository } from './knowledge-graph.repository';
import type {
  CreateKnowledgeEdgeParams,
  CreateKnowledgeNodeParams,
  GraphSearchParams,
  GraphTraversalParams,
  KnowledgeEdge,
  KnowledgeNode,
} from '../knowledge-graph.types';

// ─── Row types ──────────────────────────────────────────────────────────────

interface NodeRow {
  id: string;
  type: string;
  name: string;
  properties_json: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  properties_json: string | null;
  created_at: Date | string;
}

@Injectable()
export class PostgresKnowledgeGraphRepository extends KnowledgeGraphRepository {
  private readonly logger = new Logger(PostgresKnowledgeGraphRepository.name);

  constructor(private readonly connectionService: PostgresConnectionService) {
    super();
  }

  // ─── Nodes ──────────────────────────────────────────────────────────────

  async createNode(params: CreateKnowledgeNodeParams): Promise<KnowledgeNode> {
    const pool = await this.connectionService.getPool();
    const now = new Date().toISOString();
    const id = randomUUID();

    await pool.query(
      `INSERT INTO knowledge_nodes (id, type, name, properties_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, params.type, params.name, params.properties ? JSON.stringify(params.properties) : null, now, now],
    );

    return { id, type: params.type, name: params.name, properties: params.properties ?? {}, createdAt: now, updatedAt: now };
  }

  async getNodeById(id: string): Promise<KnowledgeNode | undefined> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<NodeRow>(`SELECT * FROM knowledge_nodes WHERE id = $1`, [id]);
    return result.rows[0] ? this.rowToNode(result.rows[0]) : undefined;
  }

  async findNodeByName(type: string, name: string): Promise<KnowledgeNode | undefined> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<NodeRow>(
      `SELECT * FROM knowledge_nodes WHERE type = $1 AND name = $2 LIMIT 1`,
      [type, name],
    );
    return result.rows[0] ? this.rowToNode(result.rows[0]) : undefined;
  }

  async searchNodes(params: GraphSearchParams): Promise<KnowledgeNode[]> {
    const pool = await this.connectionService.getPool();
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.type) {
      conditions.push(`type = $${idx}`);
      values.push(params.type);
      idx++;
    }

    if (params.namePattern) {
      conditions.push(`name ILIKE $${idx}`);
      values.push(`%${params.namePattern}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ? `LIMIT ${params.limit}` : 'LIMIT 50';

    const result = await pool.query<NodeRow>(
      `SELECT * FROM knowledge_nodes ${where} ORDER BY updated_at DESC ${limit}`,
      values,
    );
    return result.rows.map((row) => this.rowToNode(row));
  }

  async updateNode(id: string, properties: Record<string, string>): Promise<void> {
    const pool = await this.connectionService.getPool();
    await pool.query(
      `UPDATE knowledge_nodes SET properties_json = $2, updated_at = $3 WHERE id = $1`,
      [id, JSON.stringify(properties), new Date().toISOString()],
    );
  }

  async deleteNode(id: string): Promise<void> {
    const pool = await this.connectionService.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM knowledge_edges WHERE source_id = $1 OR target_id = $1`, [id]);
      await client.query(`DELETE FROM knowledge_nodes WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ─── Edges ──────────────────────────────────────────────────────────────

  async createEdge(params: CreateKnowledgeEdgeParams): Promise<KnowledgeEdge> {
    const pool = await this.connectionService.getPool();
    const now = new Date().toISOString();
    const id = randomUUID();

    const result = await pool.query<{ id: string; created_at: Date | string }>(
      `INSERT INTO knowledge_edges (id, source_id, target_id, relation, weight, properties_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_id, target_id, relation) DO UPDATE SET
         weight = EXCLUDED.weight,
         properties_json = EXCLUDED.properties_json
       RETURNING id, created_at`,
      [
        id,
        params.sourceId,
        params.targetId,
        params.relation,
        params.weight ?? 1.0,
        params.properties ? JSON.stringify(params.properties) : null,
        now,
      ],
    );

    const row = result.rows[0]!;
    return {
      id: row.id,
      sourceId: params.sourceId,
      targetId: params.targetId,
      relation: params.relation,
      weight: params.weight ?? 1.0,
      properties: params.properties,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async getEdgesFrom(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]> {
    const pool = await this.connectionService.getPool();
    let sql = `SELECT * FROM knowledge_edges WHERE source_id = $1`;
    const params: unknown[] = [nodeId];

    if (relations && relations.length > 0) {
      sql += ` AND relation = ANY($2::text[])`;
      params.push(relations);
    }

    const result = await pool.query<EdgeRow>(sql, params);
    return result.rows.map((row) => this.rowToEdge(row));
  }

  async getEdgesTo(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]> {
    const pool = await this.connectionService.getPool();
    let sql = `SELECT * FROM knowledge_edges WHERE target_id = $1`;
    const params: unknown[] = [nodeId];

    if (relations && relations.length > 0) {
      sql += ` AND relation = ANY($2::text[])`;
      params.push(relations);
    }

    const result = await pool.query<EdgeRow>(sql, params);
    return result.rows.map((row) => this.rowToEdge(row));
  }

  async deleteEdge(id: string): Promise<void> {
    const pool = await this.connectionService.getPool();
    await pool.query(`DELETE FROM knowledge_edges WHERE id = $1`, [id]);
  }

  // ─── Traversal ──────────────────────────────────────────────────────────

  async traverse(params: GraphTraversalParams): Promise<KnowledgeNode[]> {
    const pool = await this.connectionService.getPool();
    const maxDepth = params.maxDepth ?? 2;
    const limit = params.limit ?? 20;

    // Recursive CTE for BFS traversal
    let relationFilter = '';
    const queryParams: unknown[] = [params.startNodeId, maxDepth, limit];

    if (params.relations && params.relations.length > 0) {
      relationFilter = `AND e.relation = ANY($4::text[])`;
      queryParams.push(params.relations);
    }

    const result = await pool.query<NodeRow>(
      `WITH RECURSIVE graph AS (
        SELECT n.id, n.type, n.name, n.properties_json, n.created_at, n.updated_at, 0 AS depth
        FROM knowledge_nodes n
        WHERE n.id = $1

        UNION

        SELECT n2.id, n2.type, n2.name, n2.properties_json, n2.created_at, n2.updated_at, g.depth + 1
        FROM graph g
        JOIN knowledge_edges e ON (e.source_id = g.id OR e.target_id = g.id) ${relationFilter}
        JOIN knowledge_nodes n2 ON n2.id = CASE WHEN e.source_id = g.id THEN e.target_id ELSE e.source_id END
        WHERE g.depth < $2
          AND n2.id != $1
      )
      SELECT DISTINCT ON (id) id, type, name, properties_json, created_at, updated_at
      FROM graph
      WHERE id != $1
      LIMIT $3`,
      queryParams,
    );

    return result.rows.map((row) => this.rowToNode(row));
  }

  // ─── Mapping ────────────────────────────────────────────────────────────

  private rowToNode(row: NodeRow): KnowledgeNode {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      properties: row.properties_json ? (JSON.parse(row.properties_json) as Record<string, string>) : {},
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private rowToEdge(row: EdgeRow): KnowledgeEdge {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      relation: row.relation,
      weight: Number(row.weight),
      properties: row.properties_json ? (JSON.parse(row.properties_json) as Record<string, string>) : undefined,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}
