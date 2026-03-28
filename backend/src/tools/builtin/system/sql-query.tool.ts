import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { SettingsService } from '../../../settings/settings.service';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum SQL query length */
const MAX_QUERY_LENGTH = 5_000;

/** Maximum rows returned */
const MAX_ROWS = 200;

/** Maximum output length returned to LLM */
const MAX_OUTPUT_LENGTH = 15_000;

/** PostgreSQL query timeout */
const PG_QUERY_TIMEOUT_MS = 30_000;

/** Maximum cached SQLite connections */
const MAX_SQLITE_CACHE = 5;

/** Read-only SQL statement prefixes */
const READONLY_PREFIXES = ['SELECT', 'EXPLAIN', 'PRAGMA', 'WITH'];

/** Dangerous SQL patterns blocked even in write mode */
const BLOCKED_PATTERNS: RegExp[] = [
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bSHUTDOWN\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+SYSTEM\b/i,
  /\bCREATE\s+EXTENSION\b/i,
  /\bLOAD_EXTENSION\b/i,
  /\battach\s+database\b/i,
];

/** Protected file paths */
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)\.(?:ssh|gnupg|aws|kube)(?:\/|$)/i,
  /(?:^|\/)\.(?:bash_history|zsh_history|npmrc|pypirc|netrc)$/i,
  /(?:^|\/)\.env(?:\.(?:local|development|production|staging|test))?$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|\/).+\.(?:pem|key|p12|pfx)$/i,
];

// ─── Tool ────────────────────────────────────────────────────────────────────

@Injectable()
export class SqlQueryTool implements Tool, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqlQueryTool.name);
  private readonly allowedRoots: string[];
  private readonly allowWrite: boolean;
  private readonly enabled: boolean;

  /** LRU cache: path → DatabaseSync */
  private readonly sqliteCache = new Map<string, DatabaseSync>();

  readonly definition: ToolDefinition = {
    name: 'sql_query',
    description:
      'Execute SQL queries against SQLite database files or configured PostgreSQL connections.\n\n' +
      'Supports:\n' +
      '- SQLite: provide a file path to a .db/.sqlite/.sqlite3 file\n' +
      '- PostgreSQL: use "pg:<name>" where <name> is a connection configured in settings ' +
      '(key: tools.sql_query.pg.<name>, value: postgresql://user:pass@host:port/db)\n\n' +
      'Read-only by default (SELECT, EXPLAIN, WITH, PRAGMA). ' +
      'Use for data analysis, inspecting databases, running reports.',
    parameters: {
      type: 'object',
      properties: {
        database: {
          type: 'string',
          description:
            'SQLite file path (absolute or workspace-relative, e.g. "data/app.db") ' +
            'or PostgreSQL named connection (e.g. "pg:analytics").',
        },
        query: {
          type: 'string',
          description: 'SQL query to execute.',
        },
        params: {
          type: 'array',
          description: 'Positional query parameters for prepared statements (optional). E.g. [1, "active"].',
          items: { type: 'string' },
        },
      },
      required: ['database', 'query'],
    },
    safety: 'moderate',
    timeoutMs: PG_QUERY_TIMEOUT_MS,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {
    const workspace = this.configService.get<string>('tools.systemRun.workingDirectory', process.cwd());
    const configuredRoots = this.configService.get<string[]>('tools.fileOps.allowedRoots', []);
    const roots = configuredRoots.length > 0 ? configuredRoots : [workspace];
    this.allowedRoots = [...new Set(roots.filter((r) => r.trim().length > 0).map((r) => path.resolve(r)))];
    this.allowWrite = this.configService.get<boolean>('tools.sqlQuery.allowWrite', false);
    this.enabled = this.configService.get<boolean>('tools.sqlQuery.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('sql_query tool is disabled via config');
      return;
    }
    this.registry.register(this);
    this.logger.log(`sql_query tool registered (readonly=${!this.allowWrite}, roots=${this.allowedRoots.join(', ')})`);
  }

  onModuleDestroy(): void {
    for (const [, db] of this.sqliteCache) {
      try { db.close(); } catch { /* already closed */ }
    }
    this.sqliteCache.clear();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const database = String(args.database ?? '').trim();
    const query = String(args.query ?? '').trim();
    const params = Array.isArray(args.params) ? args.params.map((p) => (p == null ? null : String(p))) : [];

    // ─── Validation ──────────────────────────────────────────────────────
    if (!database) return 'Error: "database" is required.';
    if (!query) return 'Error: "query" is required.';
    if (query.length > MAX_QUERY_LENGTH) {
      return `Error: Query too long (${query.length} chars, max ${MAX_QUERY_LENGTH}).`;
    }

    // Block dangerous patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(query)) {
        return 'Error: Query contains a blocked SQL pattern.';
      }
    }

    // Check readonly
    if (!this.allowWrite) {
      const firstWord = query.replace(/^\s*\(?\s*/, '').split(/\s+/)[0]?.toUpperCase() ?? '';
      if (!READONLY_PREFIXES.includes(firstWord)) {
        return `Error: Only read-only queries are allowed (SELECT, EXPLAIN, WITH, PRAGMA). Got: "${firstWord}".`;
      }
    }

    try {
      if (database.startsWith('pg:')) {
        return await this.executePg(database.slice(3).trim(), query, params);
      }
      return await this.executeSqlite(database, query, params);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`sql_query failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  // ─── SQLite ──────────────────────────────────────────────────────────────

  private async executeSqlite(rawPath: string, query: string, params: (string | null)[]): Promise<string> {
    const filePath = await this.resolveAndValidatePath(rawPath);
    const db = this.getSqliteConnection(filePath);

    const firstWord = query.replace(/^\s*\(?\s*/, '').split(/\s+/)[0]?.toUpperCase() ?? '';
    const isSelect = READONLY_PREFIXES.includes(firstWord);

    let output: string;
    if (isSelect) {
      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      output = this.formatRows(rows, filePath);
    } else {
      const stmt = db.prepare(query);
      const result = stmt.run(...params);
      const changes = (result as unknown as { changes: number }).changes ?? 0;
      output = `Query executed. Rows affected: ${changes}.`;
    }

    return truncate(output, MAX_OUTPUT_LENGTH);
  }

  private getSqliteConnection(filePath: string): DatabaseSync {
    const cached = this.sqliteCache.get(filePath);
    if (cached) return cached;

    // Evict oldest if cache is full
    if (this.sqliteCache.size >= MAX_SQLITE_CACHE) {
      const oldest = this.sqliteCache.keys().next().value;
      if (oldest) {
        try { this.sqliteCache.get(oldest)?.close(); } catch { /* ok */ }
        this.sqliteCache.delete(oldest);
      }
    }

    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    this.sqliteCache.set(filePath, db);
    return db;
  }

  // ─── PostgreSQL ──────────────────────────────────────────────────────────

  private async executePg(connectionName: string, query: string, params: (string | null)[]): Promise<string> {
    if (!connectionName) return 'Error: PostgreSQL connection name is required (e.g. "pg:analytics").';

    const settingsKey = `tools.sql_query.pg.${connectionName}`;
    const connectionString = await this.settingsService.getValue(settingsKey);
    if (!connectionString) {
      return `Error: PostgreSQL connection "${connectionName}" not configured. Set it in Settings with key "${settingsKey}".`;
    }

    // Dynamic import to avoid loading pg when not needed
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: PG_QUERY_TIMEOUT_MS,
    });

    try {
      const result = await pool.query(query, params.length > 0 ? params : undefined);

      if (result.rows && result.rows.length > 0) {
        return this.formatRows(result.rows as Record<string, unknown>[], `pg:${connectionName}`);
      }

      const rowCount = result.rowCount ?? 0;
      return `Query executed on pg:${connectionName}. Rows affected: ${rowCount}.`;
    } finally {
      await pool.end();
    }
  }

  // ─── Formatting ──────────────────────────────────────────────────────────

  private formatRows(rows: Record<string, unknown>[], source: string): string {
    if (rows.length === 0) return `No rows returned (source: ${source}).`;

    const limited = rows.slice(0, MAX_ROWS);
    const columns = Object.keys(limited[0]!);

    // Compute column widths
    const widths = columns.map((col) => {
      const vals = limited.map((row) => formatCell(row[col]));
      return Math.min(Math.max(col.length, ...vals.map((v) => v.length)), 50);
    });

    // Header
    const header = columns.map((col, i) => col.padEnd(widths[i]!)).join(' | ');
    const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

    // Rows
    const dataLines = limited.map((row) =>
      columns.map((col, i) => formatCell(row[col]).padEnd(widths[i]!)).join(' | '),
    );

    const lines = [
      `Source: ${source}`,
      `Rows: ${rows.length}${rows.length > MAX_ROWS ? ` (showing first ${MAX_ROWS})` : ''}`,
      `Columns: ${columns.join(', ')}`,
      '',
      header,
      separator,
      ...dataLines,
    ];

    return truncate(lines.join('\n'), MAX_OUTPUT_LENGTH);
  }

  // ─── Path validation ─────────────────────────────────────────────────────

  private async resolveAndValidatePath(rawPath: string): Promise<string> {
    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.allowedRoots[0] ?? process.cwd(), rawPath);

    // Block sensitive paths
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        throw new Error('Access denied: path matches blocked pattern.');
      }
    }

    // Verify within allowed roots
    const withinRoots = this.allowedRoots.some((root) => {
      const relative = path.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });

    if (!withinRoots) {
      throw new Error(`Access denied: path is outside allowed directories (${this.allowedRoots.join(', ')}).`);
    }

    if (!existsSync(resolved)) {
      throw new Error(`Database file not found: ${resolved}`);
    }

    // Resolve symlinks
    const real = await fs.realpath(resolved);
    const realWithinRoots = this.allowedRoots.some((root) => {
      const relative = path.relative(root, real);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });

    if (!realWithinRoots) {
      throw new Error('Access denied: symlink target is outside allowed directories.');
    }

    return real;
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 60) + `\n\n... (truncated, ${text.length} total chars)`;
}
