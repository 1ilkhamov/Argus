import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';

import { KnowledgeGraphRepository } from './knowledge-graph.repository';
import type {
  CreateKnowledgeEdgeParams,
  CreateKnowledgeNodeParams,
  GraphSearchParams,
  GraphTraversalParams,
  KnowledgeEdge,
  KnowledgeNode,
} from '../knowledge-graph.types';

interface NodeRow {
  id: string;
  type: string;
  name: string;
  properties_json: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  properties_json: string | null;
  created_at: string;
}

@Injectable()
export class SqliteKnowledgeGraphRepository extends KnowledgeGraphRepository implements OnModuleInit {
  private readonly logger = new Logger(SqliteKnowledgeGraphRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  onModuleInit(): void {
    const storageDriver = this.configService.get<string>('storage.driver', 'sqlite');
    if (storageDriver !== 'sqlite') {
      return;
    }

    this.getDatabase();
  }

  isAvailable(): boolean {
    return this.database !== undefined;
  }

  // ─── Nodes ──────────────────────────────────────────────────────────────

  async createNode(params: CreateKnowledgeNodeParams): Promise<KnowledgeNode> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO knowledge_nodes (id, type, name, properties_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, params.type, params.name, params.properties ? JSON.stringify(params.properties) : null, now, now);

    return { id, type: params.type, name: params.name, properties: params.properties ?? {}, createdAt: now, updatedAt: now };
  }

  async getNodeById(id: string): Promise<KnowledgeNode | undefined> {
    const db = this.getDatabase();
    const row = db.prepare(`SELECT * FROM knowledge_nodes WHERE id = ?`).get(id) as NodeRow | undefined;
    return row ? this.rowToNode(row) : undefined;
  }

  async findNodeByName(type: string, name: string): Promise<KnowledgeNode | undefined> {
    const db = this.getDatabase();
    const row = db.prepare(
      `SELECT * FROM knowledge_nodes WHERE type = ? AND name = ? LIMIT 1`,
    ).get(type, name) as NodeRow | undefined;
    return row ? this.rowToNode(row) : undefined;
  }

  async searchNodes(params: GraphSearchParams): Promise<KnowledgeNode[]> {
    const db = this.getDatabase();
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];

    if (params.type) {
      conditions.push(`type = ?`);
      values.push(params.type);
    }

    if (params.namePattern) {
      conditions.push(`name LIKE ?`);
      values.push(`%${params.namePattern.toLowerCase()}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 50;

    const rows = db.prepare(
      `SELECT * FROM knowledge_nodes ${where} ORDER BY updated_at DESC LIMIT ${limit}`,
    ).all(...values) as unknown as NodeRow[];
    return rows.map((row) => this.rowToNode(row));
  }

  async updateNode(id: string, properties: Record<string, string>): Promise<void> {
    const db = this.getDatabase();
    db.prepare(
      `UPDATE knowledge_nodes SET properties_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(properties), new Date().toISOString(), id);
  }

  async deleteNode(id: string): Promise<void> {
    const db = this.getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`DELETE FROM knowledge_edges WHERE source_id = ? OR target_id = ?`).run(id, id);
      db.prepare(`DELETE FROM knowledge_nodes WHERE id = ?`).run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // ─── Edges ──────────────────────────────────────────────────────────────

  async createEdge(params: CreateKnowledgeEdgeParams): Promise<KnowledgeEdge> {
    const db = this.getDatabase();
    const now = new Date().toISOString();
    const id = randomUUID();

    // Upsert: try insert, on conflict update weight
    db.prepare(
      `INSERT INTO knowledge_edges (id, source_id, target_id, relation, weight, properties_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, target_id, relation) DO UPDATE SET
         weight = excluded.weight,
         properties_json = excluded.properties_json`,
    ).run(
      id,
      params.sourceId,
      params.targetId,
      params.relation,
      params.weight ?? 1.0,
      params.properties ? JSON.stringify(params.properties) : null,
      now,
    );

    return {
      id,
      sourceId: params.sourceId,
      targetId: params.targetId,
      relation: params.relation,
      weight: params.weight ?? 1.0,
      properties: params.properties,
      createdAt: now,
    };
  }

  async getEdgesFrom(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]> {
    const db = this.getDatabase();

    if (relations && relations.length > 0) {
      const placeholders = relations.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM knowledge_edges WHERE source_id = ? AND relation IN (${placeholders})`,
      ).all(nodeId, ...relations) as unknown as EdgeRow[];
      return rows.map((row) => this.rowToEdge(row));
    }

    const rows = db.prepare(
      `SELECT * FROM knowledge_edges WHERE source_id = ?`,
    ).all(nodeId) as unknown as EdgeRow[];
    return rows.map((row) => this.rowToEdge(row));
  }

  async getEdgesTo(nodeId: string, relations?: string[]): Promise<KnowledgeEdge[]> {
    const db = this.getDatabase();

    if (relations && relations.length > 0) {
      const placeholders = relations.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM knowledge_edges WHERE target_id = ? AND relation IN (${placeholders})`,
      ).all(nodeId, ...relations) as unknown as EdgeRow[];
      return rows.map((row) => this.rowToEdge(row));
    }

    const rows = db.prepare(
      `SELECT * FROM knowledge_edges WHERE target_id = ?`,
    ).all(nodeId) as unknown as EdgeRow[];
    return rows.map((row) => this.rowToEdge(row));
  }

  async deleteEdge(id: string): Promise<void> {
    const db = this.getDatabase();
    db.prepare(`DELETE FROM knowledge_edges WHERE id = ?`).run(id);
  }

  // ─── Traversal ──────────────────────────────────────────────────────────

  async traverse(params: GraphTraversalParams): Promise<KnowledgeNode[]> {
    const db = this.getDatabase();
    const maxDepth = params.maxDepth ?? 2;
    const limit = params.limit ?? 20;

    // BFS traversal (SQLite doesn't support recursive CTEs well in node:sqlite,
    // so we do iterative BFS in JS)
    const visited = new Set<string>([params.startNodeId]);
    let frontier = [params.startNodeId];
    const result: KnowledgeNode[] = [];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        let edgeRows: EdgeRow[];

        if (params.relations && params.relations.length > 0) {
          const relPlaceholders = params.relations.map(() => '?').join(',');
          edgeRows = db.prepare(
            `SELECT * FROM knowledge_edges
             WHERE (source_id = ? OR target_id = ?) AND relation IN (${relPlaceholders})`,
          ).all(nodeId, nodeId, ...params.relations) as unknown as EdgeRow[];
        } else {
          edgeRows = db.prepare(
            `SELECT * FROM knowledge_edges WHERE source_id = ? OR target_id = ?`,
          ).all(nodeId, nodeId) as unknown as EdgeRow[];
        }

        for (const edge of edgeRows) {
          const neighborId = edge.source_id === nodeId ? edge.target_id : edge.source_id;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push(neighborId);

            const neighborNode = await this.getNodeById(neighborId);
            if (neighborNode) {
              result.push(neighborNode);
              if (result.length >= limit) break;
            }
          }
        }
        if (result.length >= limit) break;
      }

      frontier = nextFrontier;
      if (result.length >= limit) break;
    }

    return result;
  }

  // ─── Mapping ────────────────────────────────────────────────────────────

  private rowToNode(row: NodeRow): KnowledgeNode {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      properties: row.properties_json ? (JSON.parse(row.properties_json) as Record<string, string>) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
      createdAt: row.created_at,
    };
  }

  // ─── Database initialization ──────────────────────────────────────────

  private getDatabase(): DatabaseSync {
    if (this.database) {
      return this.database;
    }

    const dbPath = this.getDbFilePath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const database = new DatabaseSync(dbPath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');

    database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        properties_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    database.exec('CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON knowledge_nodes (type)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_kg_nodes_name ON knowledge_nodes (name)');
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_nodes_type_name ON knowledge_nodes (type, name)');

    database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        properties_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (source_id, target_id, relation)
      )
    `);

    database.exec('CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON knowledge_edges (source_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON knowledge_edges (target_id)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_kg_edges_relation ON knowledge_edges (relation)');

    this.database = database;
    this.logger.log('SQLite knowledge graph tables initialized');
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
