import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { FileOpsTool } from './file-ops.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

describe('FileOpsTool — smart edit actions', () => {
  let tool: FileOpsTool;
  let tmpDir: string;

  beforeEach(async () => {
    // Use home dir because macOS /var/folders is blocked by BLOCKED_WRITE_PATTERNS
    tmpDir = await fs.mkdtemp(path.join(os.homedir(), '.argus-test-file-ops-'));

    const module = await Test.createTestingModule({
      providers: [
        FileOpsTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'tools.systemRun.workingDirectory') return tmpDir;
              if (key === 'tools.fileOps.allowedRoots') return [tmpDir];
              return fallback;
            }),
          },
        },
      ],
    }).compile();

    tool = module.get(FileOpsTool);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Helper ─────────────────────────────────────────────────────────────────

  async function writeTestFile(name: string, content: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  async function readTestFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  // ─── replace_in_file ────────────────────────────────────────────────────────

  describe('replace_in_file', () => {
    it('should replace first occurrence', async () => {
      const file = await writeTestFile('test.txt', 'hello world\nhello again\n');

      const result = await tool.execute({
        action: 'replace_in_file',
        path: file,
        old_text: 'hello',
        new_text: 'goodbye',
      });

      expect(result).toContain('1 occurrence');
      const content = await readTestFile(file);
      expect(content).toBe('goodbye world\nhello again\n');
    });

    it('should replace all occurrences with replace_all', async () => {
      const file = await writeTestFile('test.txt', 'hello world\nhello again\n');

      const result = await tool.execute({
        action: 'replace_in_file',
        path: file,
        old_text: 'hello',
        new_text: 'goodbye',
        replace_all: true,
      });

      expect(result).toContain('2 occurrence');
      const content = await readTestFile(file);
      expect(content).toBe('goodbye world\ngoodbye again\n');
    });

    it('should delete text when new_text is empty', async () => {
      const file = await writeTestFile('test.txt', 'foo bar baz');

      const result = await tool.execute({
        action: 'replace_in_file',
        path: file,
        old_text: ' bar',
        new_text: '',
      });

      expect(result).toContain('deleted');
      const content = await readTestFile(file);
      expect(content).toBe('foo baz');
    });

    it('should return error with hints when old_text not found', async () => {
      const file = await writeTestFile('test.txt', 'line one\nline two\nline three\n');

      const result = await tool.execute({
        action: 'replace_in_file',
        path: file,
        old_text: 'line  two', // extra space
        new_text: 'replaced',
      });

      expect(result).toContain('not found');
      expect(result).toContain('line');
    });

    it('should handle multiline old_text', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\nline3\n');

      await tool.execute({
        action: 'replace_in_file',
        path: file,
        old_text: 'line1\nline2',
        new_text: 'replaced',
      });

      const content = await readTestFile(file);
      expect(content).toBe('replaced\nline3\n');
    });

    it('should require old_text', async () => {
      const file = await writeTestFile('test.txt', 'content');
      const result = await tool.execute({
        action: 'replace_in_file',
        path: file,
        new_text: 'x',
      });
      expect(result).toContain('Error');
      expect(result).toContain('old_text');
    });
  });

  // ─── insert_lines ──────────────────────────────────────────────────────────

  describe('insert_lines', () => {
    it('should insert before a specific line', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\nline3\n');

      const result = await tool.execute({
        action: 'insert_lines',
        path: file,
        content: 'inserted',
        line: 2,
      });

      expect(result).toContain('before line 2');
      const content = await readTestFile(file);
      expect(content).toBe('line1\ninserted\nline2\nline3\n');
    });

    it('should append at end when line=0', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\n');

      const result = await tool.execute({
        action: 'insert_lines',
        path: file,
        content: 'appended',
        line: 0,
      });

      expect(result).toContain('end of');
      const content = await readTestFile(file);
      expect(content).toBe('line1\nline2\nappended');
    });

    it('should append at end when line exceeds file length', async () => {
      const file = await writeTestFile('test.txt', 'line1\n');

      await tool.execute({
        action: 'insert_lines',
        path: file,
        content: 'appended',
        line: 999,
      });

      const content = await readTestFile(file);
      expect(content).toContain('appended');
    });

    it('should insert at line 1 (beginning)', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\n');

      await tool.execute({
        action: 'insert_lines',
        path: file,
        content: 'header',
        line: 1,
      });

      const content = await readTestFile(file);
      expect(content).toBe('header\nline1\nline2\n');
    });

    it('should insert multiline content', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline3\n');

      await tool.execute({
        action: 'insert_lines',
        path: file,
        content: 'new1\nnew2',
        line: 2,
      });

      const content = await readTestFile(file);
      expect(content).toBe('line1\nnew1\nnew2\nline3\n');
    });

    it('should require content', async () => {
      const file = await writeTestFile('test.txt', 'content');
      const result = await tool.execute({
        action: 'insert_lines',
        path: file,
        line: 1,
      });
      expect(result).toContain('Error');
    });
  });

  // ─── delete_lines ──────────────────────────────────────────────────────────

  describe('delete_lines', () => {
    it('should delete a single line', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\nline3\n');

      const result = await tool.execute({
        action: 'delete_lines',
        path: file,
        line_start: 2,
        line_end: 2,
      });

      expect(result).toContain('1 line');
      const content = await readTestFile(file);
      expect(content).toBe('line1\nline3\n');
    });

    it('should delete a range of lines', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\nline3\nline4\nline5\n');

      const result = await tool.execute({
        action: 'delete_lines',
        path: file,
        line_start: 2,
        line_end: 4,
      });

      expect(result).toContain('3 line');
      const content = await readTestFile(file);
      expect(content).toBe('line1\nline5\n');
    });

    it('should clamp line_end to file length', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\n');

      await tool.execute({
        action: 'delete_lines',
        path: file,
        line_start: 1,
        line_end: 999,
      });

      const content = await readTestFile(file);
      // All lines deleted (including trailing empty from split)
      expect(content.trim()).toBe('');
    });

    it('should require line_start', async () => {
      const file = await writeTestFile('test.txt', 'content');
      const result = await tool.execute({
        action: 'delete_lines',
        path: file,
        line_end: 3,
      });
      expect(result).toContain('line_start');
    });

    it('should require line_end >= line_start', async () => {
      const file = await writeTestFile('test.txt', 'content');
      const result = await tool.execute({
        action: 'delete_lines',
        path: file,
        line_start: 3,
        line_end: 1,
      });
      expect(result).toContain('line_end');
    });

    it('should error when line_start exceeds file length', async () => {
      const file = await writeTestFile('test.txt', 'line1\n');
      const result = await tool.execute({
        action: 'delete_lines',
        path: file,
        line_start: 999,
        line_end: 1000,
      });
      expect(result).toContain('exceeds');
    });
  });

  // ─── patch ─────────────────────────────────────────────────────────────────

  describe('patch', () => {
    it('should apply a simple unified diff', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\nline3\n');

      const diff = [
        '@@ -1,3 +1,3 @@',
        ' line1',
        '-line2',
        '+line2_modified',
        ' line3',
      ].join('\n');

      const result = await tool.execute({
        action: 'patch',
        path: file,
        diff,
      });

      expect(result).toContain('1 hunk');
      const content = await readTestFile(file);
      expect(content).toBe('line1\nline2_modified\nline3\n');
    });

    it('should apply multi-hunk diff', async () => {
      const file = await writeTestFile('test.txt', 'aaa\nbbb\nccc\nddd\neee\n');

      const diff = [
        '@@ -1,2 +1,2 @@',
        '-aaa',
        '+AAA',
        ' bbb',
        '@@ -4,2 +4,2 @@',
        '-ddd',
        '+DDD',
        ' eee',
      ].join('\n');

      const result = await tool.execute({
        action: 'patch',
        path: file,
        diff,
      });

      expect(result).toContain('2 hunk');
      const content = await readTestFile(file);
      expect(content).toBe('AAA\nbbb\nccc\nDDD\neee\n');
    });

    it('should add lines', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline3\n');

      const diff = [
        '@@ -1,2 +1,3 @@',
        ' line1',
        '+line2',
        ' line3',
      ].join('\n');

      await tool.execute({ action: 'patch', path: file, diff });

      const content = await readTestFile(file);
      expect(content).toBe('line1\nline2\nline3\n');
    });

    it('should remove lines', async () => {
      const file = await writeTestFile('test.txt', 'line1\nline2\nline3\n');

      const diff = [
        '@@ -1,3 +1,2 @@',
        ' line1',
        '-line2',
        ' line3',
      ].join('\n');

      await tool.execute({ action: 'patch', path: file, diff });

      const content = await readTestFile(file);
      expect(content).toBe('line1\nline3\n');
    });

    it('should error on context mismatch', async () => {
      const file = await writeTestFile('test.txt', 'aaa\nbbb\nccc\n');

      const diff = [
        '@@ -1,3 +1,3 @@',
        ' aaa',
        '-xxx', // does not match
        '+yyy',
        ' ccc',
      ].join('\n');

      const result = await tool.execute({ action: 'patch', path: file, diff });
      expect(result).toContain('Error');
      expect(result).toContain('mismatch');
    });

    it('should error on invalid diff format', async () => {
      const file = await writeTestFile('test.txt', 'content');
      const result = await tool.execute({
        action: 'patch',
        path: file,
        diff: 'not a valid diff',
      });
      expect(result).toContain('No valid diff hunks');
    });

    it('should require diff parameter', async () => {
      const file = await writeTestFile('test.txt', 'content');
      const result = await tool.execute({
        action: 'patch',
        path: file,
      });
      expect(result).toContain('diff');
    });
  });
});
