import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { SqlQueryTool } from './sql-query.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import { SettingsService } from '../../../settings/settings.service';

// ─── Mock node:sqlite ─────────────────────────────────────────────────────────

const mockPrepare = jest.fn();
const mockExec = jest.fn();
const mockClose = jest.fn();

jest.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor() {}
    prepare(...args: unknown[]) { return mockPrepare(...args); }
    exec(...args: unknown[]) { return mockExec(...args); }
    close() { return mockClose(); }
  },
}));

// ─── Mock fs ──────────────────────────────────────────────────────────────────

const mockRealpath = jest.fn();

jest.mock('node:fs/promises', () => ({
  realpath: (...args: unknown[]) => mockRealpath(...args),
}));

jest.mock('node:fs', () => ({
  existsSync: () => true,
}));

// ─── Mock pg ──────────────────────────────────────────────────────────────────

const mockPgQuery = jest.fn();
const mockPgEnd = jest.fn();

jest.mock('pg', () => ({
  Pool: class {
    constructor() {}
    query(...args: unknown[]) { return mockPgQuery(...args); }
    end() { return mockPgEnd(); }
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE = '/Users/test/workspace';
const mockSettingsGetValue = jest.fn();

const createTool = async (overrides?: {
  allowWrite?: boolean;
  enabled?: boolean;
}): Promise<SqlQueryTool> => {
  const module = await Test.createTestingModule({
    providers: [
      SqlQueryTool,
      {
        provide: ToolRegistryService,
        useValue: { register: jest.fn() },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => {
            if (key === 'tools.systemRun.workingDirectory') return WORKSPACE;
            if (key === 'tools.fileOps.allowedRoots') return [];
            if (key === 'tools.sqlQuery.allowWrite') return overrides?.allowWrite ?? false;
            if (key === 'tools.sqlQuery.enabled') return overrides?.enabled ?? true;
            return undefined;
          }),
        },
      },
      {
        provide: SettingsService,
        useValue: { getValue: mockSettingsGetValue },
      },
    ],
  }).compile();

  return module.get(SqlQueryTool);
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SqlQueryTool', () => {
  let tool: SqlQueryTool;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p);
    mockPrepare.mockReturnValue({
      all: jest.fn().mockReturnValue([
        { id: 1, name: 'Alice', age: 30 },
        { id: 2, name: 'Bob', age: 25 },
      ]),
      run: jest.fn().mockReturnValue({ changes: 1 }),
    });
    mockSettingsGetValue.mockResolvedValue('');
    tool = await createTool();
  });

  afterEach(() => {
    // Clean up cached connections
    tool.onModuleDestroy();
  });

  // ─── Registration ──────────────────────────────────────────────────────

  it('should have correct tool definition', () => {
    expect(tool.definition.name).toBe('sql_query');
    expect(tool.definition.safety).toBe('moderate');
    expect(tool.definition.parameters.required).toEqual(['database', 'query']);
  });

  // ─── Basic SELECT ──────────────────────────────────────────────────────

  it('should execute a SELECT query against SQLite', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT id, name, age FROM users',
    });

    expect(result).toContain('Rows: 2');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
    expect(result).toContain('id');
    expect(result).toContain('name');
    expect(result).toContain('age');
    expect(mockPrepare).toHaveBeenCalledWith('SELECT id, name, age FROM users');
  });

  it('should format empty result set', async () => {
    mockPrepare.mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      run: jest.fn().mockReturnValue({ changes: 0 }),
    });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT * FROM empty_table',
    });

    expect(result).toContain('No rows returned');
  });

  // ─── Parameterized queries ──────────────────────────────────────────────

  it('should pass parameters to prepared statements', async () => {
    const allFn = jest.fn().mockReturnValue([{ id: 1, name: 'Alice' }]);
    mockPrepare.mockReturnValue({ all: allFn, run: jest.fn() });

    await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT * FROM users WHERE id = ?',
      params: ['1'],
    });

    expect(allFn).toHaveBeenCalledWith('1');
  });

  // ─── Read-only enforcement ──────────────────────────────────────────────

  it('should block INSERT in readonly mode', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'INSERT INTO users (name) VALUES ("test")',
    });

    expect(result).toContain('read-only');
    expect(result).toContain('INSERT');
  });

  it('should block UPDATE in readonly mode', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'UPDATE users SET name = "test" WHERE id = 1',
    });

    expect(result).toContain('read-only');
  });

  it('should block DELETE in readonly mode', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'DELETE FROM users WHERE id = 1',
    });

    expect(result).toContain('read-only');
  });

  it('should allow EXPLAIN in readonly mode', async () => {
    const allFn = jest.fn().mockReturnValue([{ detail: 'SCAN users' }]);
    mockPrepare.mockReturnValue({ all: allFn, run: jest.fn() });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'EXPLAIN SELECT * FROM users',
    });

    expect(result).not.toContain('read-only');
    expect(result).toContain('SCAN users');
  });

  it('should allow PRAGMA in readonly mode', async () => {
    const allFn = jest.fn().mockReturnValue([{ name: 'users' }]);
    mockPrepare.mockReturnValue({ all: allFn, run: jest.fn() });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'PRAGMA table_list',
    });

    expect(result).not.toContain('read-only');
  });

  it('should allow WITH (CTE) in readonly mode', async () => {
    const allFn = jest.fn().mockReturnValue([{ cnt: 10 }]);
    mockPrepare.mockReturnValue({ all: allFn, run: jest.fn() });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'WITH counts AS (SELECT count(*) cnt FROM users) SELECT * FROM counts',
    });

    expect(result).not.toContain('read-only');
  });

  // ─── Write mode ─────────────────────────────────────────────────────────

  it('should allow INSERT when write mode is enabled', async () => {
    const writeTool = await createTool({ allowWrite: true });
    const runFn = jest.fn().mockReturnValue({ changes: 1 });
    mockPrepare.mockReturnValue({ all: jest.fn(), run: runFn });

    const result = await writeTool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'INSERT INTO users (name) VALUES ("test")',
    });

    expect(result).toContain('Rows affected: 1');
    writeTool.onModuleDestroy();
  });

  // ─── Blocked patterns ──────────────────────────────────────────────────

  it('should block DROP DATABASE', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'DROP DATABASE production',
    });

    expect(result).toContain('blocked');
  });

  it('should block TRUNCATE', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'TRUNCATE TABLE users',
    });

    expect(result).toContain('blocked');
  });

  it('should block LOAD_EXTENSION', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: "SELECT LOAD_EXTENSION('/tmp/evil.so')",
    });

    expect(result).toContain('blocked');
  });

  it('should block ATTACH DATABASE', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: "ATTACH DATABASE '/etc/passwd' AS evil",
    });

    expect(result).toContain('blocked');
  });

  // ─── Validation errors ─────────────────────────────────────────────────

  it('should require database parameter', async () => {
    const result = await tool.execute({ query: 'SELECT 1' });
    expect(result).toContain('"database" is required');
  });

  it('should require query parameter', async () => {
    const result = await tool.execute({ database: `${WORKSPACE}/data/app.db` });
    expect(result).toContain('"query" is required');
  });

  it('should reject overly long queries', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT ' + 'x'.repeat(5001),
    });

    expect(result).toContain('too long');
  });

  // ─── Security: path validation ─────────────────────────────────────────

  it('should block paths outside allowed roots', async () => {
    const result = await tool.execute({
      database: '/etc/secrets/db.sqlite',
      query: 'SELECT 1',
    });

    expect(result).toContain('outside allowed');
  });

  it('should block sensitive paths (.ssh)', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/.ssh/keys.db`,
      query: 'SELECT 1',
    });

    expect(result).toContain('Access denied');
  });

  it('should block .env paths', async () => {
    const result = await tool.execute({
      database: `${WORKSPACE}/.env.local`,
      query: 'SELECT 1',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block symlinks pointing outside allowed roots', async () => {
    mockRealpath.mockResolvedValue('/etc/shadow');

    const result = await tool.execute({
      database: `${WORKSPACE}/link.db`,
      query: 'SELECT 1',
    });

    expect(result).toContain('symlink');
  });

  // ─── PostgreSQL ────────────────────────────────────────────────────────

  it('should execute PostgreSQL queries via named connections', async () => {
    mockSettingsGetValue.mockResolvedValue('postgresql://user:pass@localhost:5432/mydb');
    mockPgQuery.mockResolvedValue({
      rows: [{ id: 1, status: 'active' }],
      rowCount: 1,
    });

    const result = await tool.execute({
      database: 'pg:analytics',
      query: 'SELECT * FROM events',
    });

    expect(result).toContain('id');
    expect(result).toContain('active');
    expect(mockSettingsGetValue).toHaveBeenCalledWith('tools.sql_query.pg.analytics');
    expect(mockPgEnd).toHaveBeenCalled();
  });

  it('should handle unconfigured PostgreSQL connection', async () => {
    mockSettingsGetValue.mockResolvedValue('');

    const result = await tool.execute({
      database: 'pg:missing',
      query: 'SELECT 1',
    });

    expect(result).toContain('not configured');
    expect(result).toContain('tools.sql_query.pg.missing');
  });

  it('should handle PostgreSQL write operations in result', async () => {
    const writeTool = await createTool({ allowWrite: true });
    mockSettingsGetValue.mockResolvedValue('postgresql://user:pass@localhost:5432/mydb');
    mockPgQuery.mockResolvedValue({ rows: [], rowCount: 5 });

    const result = await writeTool.execute({
      database: 'pg:analytics',
      query: 'UPDATE events SET status = $1',
      params: ['processed'],
    });

    expect(result).toContain('Rows affected: 5');
    writeTool.onModuleDestroy();
  });

  // ─── Relative paths ────────────────────────────────────────────────────

  it('should resolve relative paths from workspace', async () => {
    await tool.execute({
      database: 'data/app.db',
      query: 'SELECT 1',
    });

    expect(mockRealpath).toHaveBeenCalledWith(
      expect.stringContaining(`${WORKSPACE}/data/app.db`),
    );
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  it('should handle NULL values in results', async () => {
    mockPrepare.mockReturnValue({
      all: jest.fn().mockReturnValue([
        { id: 1, name: null, email: undefined },
      ]),
      run: jest.fn(),
    });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT * FROM users',
    });

    expect(result).toContain('NULL');
  });

  it('should handle JSON objects in results', async () => {
    mockPrepare.mockReturnValue({
      all: jest.fn().mockReturnValue([
        { id: 1, data: { key: 'value' } },
      ]),
      run: jest.fn(),
    });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT * FROM docs',
    });

    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
  });

  it('should handle database errors gracefully', async () => {
    mockPrepare.mockImplementation(() => {
      throw new Error('no such table: nonexistent');
    });

    const result = await tool.execute({
      database: `${WORKSPACE}/data/app.db`,
      query: 'SELECT * FROM nonexistent',
    });

    expect(result).toContain('no such table');
  });
});
