import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, statSync } from 'node:fs';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

/** Maximum file size we will read (bytes) */
const MAX_READ_SIZE = 512_000; // 512 KB
/** Maximum content length for write operations */
const MAX_WRITE_SIZE = 256_000; // 256 KB
/** Maximum output length returned to the LLM */
const MAX_OUTPUT_LENGTH = 12_000;
/** Maximum number of search results */
const MAX_SEARCH_RESULTS = 50;
/** Maximum directory listing entries */
const MAX_LIST_ENTRIES = 100;

type FileAccessMode = 'read' | 'write';

/** Protected files/paths that must never be exposed to the tool. */
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)\.(?:ssh|gnupg|aws|kube)(?:\/|$)/i,
  /(?:^|\/)\.(?:bash_history|zsh_history|npmrc|pypirc|netrc)$/i,
  /(?:^|\/)\.env(?:\.(?:local|development|production|staging|test))?$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|\/).+\.(?:pem|key|p12|pfx)$/i,
];

/**
 * Patterns that are always blocked for write/delete operations.
 * Prevents accidental damage to system or critical files.
 */
const BLOCKED_WRITE_PATTERNS: RegExp[] = [
  /^\/(?:System|Library|usr|bin|sbin|etc|var|private)\//i,
  /^\/Applications\//i,
  /^\/(dev|proc|sys)\//i,
  /\.(?:app|framework|dylib|so|dll|exe)$/i,
  /(?:^|\/)\.(?:ssh|gnupg|aws|kube)\//i,
];

@Injectable()
export class FileOpsTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(FileOpsTool.name);
  private readonly allowedRoots: string[];

  readonly definition: ToolDefinition = {
    name: 'file_ops',
    description:
      'Read, write, list, search, and manage files on the local filesystem.\n\n' +
      'Actions:\n' +
      '- read: Read file contents (text files up to 512KB)\n' +
      '- write: Create or overwrite a file\n' +
      '- append: Append content to an existing file\n' +
      '- replace_in_file: Find and replace text in a file (precise edits without rewriting the whole file)\n' +
      '- insert_lines: Insert text at a specific line number\n' +
      '- delete_lines: Delete a range of lines\n' +
      '- patch: Apply a unified diff patch to a file\n' +
      '- list: List files and directories at a path\n' +
      '- search: Search for files by name pattern (glob)\n' +
      '- info: Get file/directory metadata (size, dates, permissions)\n' +
      '- mkdir: Create a directory (with parents)\n' +
      '- delete: Delete a file or empty directory\n' +
      '- move: Move or rename a file/directory\n' +
      '- copy: Copy a file',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'append', 'replace_in_file', 'insert_lines', 'delete_lines', 'patch', 'list', 'search', 'info', 'mkdir', 'delete', 'move', 'copy'],
          description: 'The file operation to perform.',
        },
        path: {
          type: 'string',
          description: 'Target file or directory path (absolute or relative to workspace).',
        },
        content: {
          type: 'string',
          description: 'File content for write/append actions.',
        },
        destination: {
          type: 'string',
          description: 'Destination path for move/copy actions.',
        },
        pattern: {
          type: 'string',
          description: 'Glob pattern for search action (e.g. "*.ts", "**/*.json").',
        },
        encoding: {
          type: 'string',
          description: 'File encoding for read/write. Default: "utf-8".',
        },
        line_start: {
          type: 'number',
          description: 'For read: start reading from this line number (1-indexed).',
        },
        line_end: {
          type: 'number',
          description: 'For read/delete_lines: stop line number (inclusive).',
        },
        old_text: {
          type: 'string',
          description: 'For replace_in_file: exact text to find (must match file content precisely, including whitespace).',
        },
        new_text: {
          type: 'string',
          description: 'For replace_in_file: replacement text. Use empty string to delete the matched text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'For replace_in_file: replace all occurrences (default: false, first only).',
        },
        line: {
          type: 'number',
          description: 'For insert_lines: line number to insert BEFORE (1-indexed). Use 0 or omit to append at end.',
        },
        diff: {
          type: 'string',
          description: 'For patch: unified diff content to apply.',
        },
      },
      required: ['action'],
    },
    safety: 'moderate',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {
    const workspace = this.configService.get<string>('tools.systemRun.workingDirectory', process.cwd());
    const configuredRoots = this.configService.get<string[]>('tools.fileOps.allowedRoots', []);
    const roots = configuredRoots.length > 0 ? configuredRoots : [workspace];
    this.allowedRoots = [...new Set(roots.filter((root) => root.trim().length > 0).map((root) => path.resolve(root)))];
  }

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log(`file_ops tool registered (allowed roots: ${this.allowedRoots.join(', ')})`);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();
    const filePath = this.resolvePath(String(args.path ?? ''));

    try {
      switch (action) {
        case 'read':
          return await this.readFile(await this.resolveAndValidatePath(filePath, 'read'), args);
        case 'write':
          return await this.writeFile(await this.resolveAndValidatePath(filePath, 'write'), String(args.content ?? ''), args);
        case 'append':
          return await this.appendFile(await this.resolveAndValidatePath(filePath, 'write'), String(args.content ?? ''), args);
        case 'list':
          return await this.listDir(await this.resolveAndValidatePath(filePath, 'read'));
        case 'search':
          return await this.searchFiles(await this.resolveAndValidatePath(filePath, 'read'), String(args.pattern ?? '*'));
        case 'info':
          return await this.fileInfo(await this.resolveAndValidatePath(filePath, 'read'));
        case 'mkdir':
          return await this.makeDir(await this.resolveAndValidatePath(filePath, 'write'));
        case 'delete':
          return await this.deleteFile(await this.resolveAndValidatePath(filePath, 'write'));
        case 'move':
          return await this.moveFile(
            await this.resolveAndValidatePath(filePath, 'write'),
            await this.resolveAndValidatePath(this.resolvePath(String(args.destination ?? '')), 'write'),
          );
        case 'copy':
          return await this.copyFile(
            await this.resolveAndValidatePath(filePath, 'read'),
            await this.resolveAndValidatePath(this.resolvePath(String(args.destination ?? '')), 'write'),
          );
        case 'replace_in_file':
          return await this.replaceInFile(await this.resolveAndValidatePath(filePath, 'write'), args);
        case 'insert_lines':
          return await this.insertLines(await this.resolveAndValidatePath(filePath, 'write'), args);
        case 'delete_lines':
          return await this.deleteLines(await this.resolveAndValidatePath(filePath, 'write'), args);
        case 'patch':
          return await this.applyPatch(await this.resolveAndValidatePath(filePath, 'write'), args);
        default:
          return `Error: Unknown action "${action}". Valid actions: read, write, append, replace_in_file, insert_lines, delete_lines, patch, list, search, info, mkdir, delete, move, copy.`;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`file_ops ${action} failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────────────────

  private async readFile(filePath: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) return 'Error: Path is a directory. Use action "list" instead.';
    if (stat.size > MAX_READ_SIZE) {
      return `Error: File too large (${formatSize(stat.size)}, max ${formatSize(MAX_READ_SIZE)}). Use line_start/line_end to read a portion.`;
    }

    const encoding = (String(args.encoding ?? 'utf-8')) as BufferEncoding;
    const raw = await fs.readFile(filePath, { encoding });

    const lineStart = Number(args.line_start) || 0;
    const lineEnd = Number(args.line_end) || 0;

    if (lineStart > 0 || lineEnd > 0) {
      const lines = raw.split('\n');
      const start = Math.max(1, lineStart) - 1;
      const end = lineEnd > 0 ? Math.min(lineEnd, lines.length) : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
      return truncate(`File: ${filePath} (lines ${start + 1}-${end} of ${lines.length})\n\n${numbered}`, MAX_OUTPUT_LENGTH);
    }

    return truncate(`File: ${filePath} (${formatSize(stat.size)})\n\n${raw}`, MAX_OUTPUT_LENGTH);
  }

  private async writeFile(filePath: string, content: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Write blocked for safety. Path matches protected pattern: ${blocked}`;

    if (content.length > MAX_WRITE_SIZE) {
      return `Error: Content too large (${content.length} chars, max ${MAX_WRITE_SIZE}).`;
    }

    const encoding = (String(args.encoding ?? 'utf-8')) as BufferEncoding;

    // Create parent directories if needed
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, { encoding });

    this.logger.log(`Wrote ${content.length} chars to ${filePath}`);
    return `Successfully wrote ${content.length} characters to ${filePath}`;
  }

  private async appendFile(filePath: string, content: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Write blocked for safety. Path matches protected pattern: ${blocked}`;

    if (content.length > MAX_WRITE_SIZE) {
      return `Error: Content too large (${content.length} chars, max ${MAX_WRITE_SIZE}).`;
    }

    const encoding = (String(args.encoding ?? 'utf-8')) as BufferEncoding;
    await fs.appendFile(filePath, content, { encoding });

    this.logger.log(`Appended ${content.length} chars to ${filePath}`);
    return `Successfully appended ${content.length} characters to ${filePath}`;
  }

  private async listDir(dirPath: string): Promise<string> {
    if (!dirPath) return 'Error: No path provided.';

    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return 'Error: Path is not a directory.';

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    if (entries.length === 0) return `Directory ${dirPath} is empty.`;

    const lines: string[] = [`Directory: ${dirPath} (${entries.length} entries)\n`];
    const sorted = entries.sort((a, b) => {
      // Directories first, then files
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted.slice(0, MAX_LIST_ENTRIES)) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        const s = statSync(fullPath);
        const type = entry.isDirectory() ? 'DIR ' : 'FILE';
        const size = entry.isDirectory() ? '' : ` (${formatSize(s.size)})`;
        lines.push(`  ${type} ${entry.name}${size}`);
      } catch {
        lines.push(`  ?    ${entry.name}`);
      }
    }

    if (entries.length > MAX_LIST_ENTRIES) {
      lines.push(`\n... and ${entries.length - MAX_LIST_ENTRIES} more entries`);
    }

    return lines.join('\n');
  }

  private async searchFiles(basePath: string, pattern: string): Promise<string> {
    if (!basePath) return 'Error: No path provided.';

    const results: string[] = [];
    await this.walkDir(basePath, pattern, results, 0, 5);

    if (results.length === 0) return `No files matching "${pattern}" found in ${basePath}`;

    const header = `Found ${results.length} files matching "${pattern}" in ${basePath}:\n`;
    return header + results.slice(0, MAX_SEARCH_RESULTS).join('\n');
  }

  private async fileInfo(filePath: string): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const stat = await fs.stat(filePath);
    const lines = [
      `Path: ${filePath}`,
      `Type: ${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other'}`,
      `Size: ${formatSize(stat.size)}`,
      `Created: ${stat.birthtime.toISOString()}`,
      `Modified: ${stat.mtime.toISOString()}`,
      `Permissions: ${(stat.mode & 0o777).toString(8)}`,
    ];

    if (stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      lines.push(`Extension: ${ext || '(none)'}`);
    }

    return lines.join('\n');
  }

  private async makeDir(dirPath: string): Promise<string> {
    if (!dirPath) return 'Error: No path provided.';

    const blocked = this.isBlockedWrite(dirPath);
    if (blocked) return `Error: Blocked for safety. Path matches: ${blocked}`;

    await fs.mkdir(dirPath, { recursive: true });
    return `Directory created: ${dirPath}`;
  }

  private async deleteFile(filePath: string): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Delete blocked for safety. Path matches: ${blocked}`;

    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      // Only delete empty directories for safety
      const entries = await fs.readdir(filePath);
      if (entries.length > 0) {
        return `Error: Directory is not empty (${entries.length} entries). Remove contents first or use system_run with rm -r.`;
      }
      await fs.rmdir(filePath);
      this.logger.log(`Deleted empty directory: ${filePath}`);
      return `Deleted empty directory: ${filePath}`;
    }

    await fs.unlink(filePath);
    this.logger.log(`Deleted file: ${filePath}`);
    return `Deleted file: ${filePath}`;
  }

  private async moveFile(src: string, dest: string): Promise<string> {
    if (!src) return 'Error: No source path provided.';
    if (!dest) return 'Error: No destination path provided.';

    const blocked = this.isBlockedWrite(src) || this.isBlockedWrite(dest);
    if (blocked) return `Error: Move blocked for safety. Path matches: ${blocked}`;

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    this.logger.log(`Moved ${src} → ${dest}`);
    return `Moved ${src} → ${dest}`;
  }

  private async copyFile(src: string, dest: string): Promise<string> {
    if (!src) return 'Error: No source path provided.';
    if (!dest) return 'Error: No destination path provided.';

    const blocked = this.isBlockedWrite(dest);
    if (blocked) return `Error: Copy blocked for safety. Destination matches: ${blocked}`;

    const stat = await fs.stat(src);
    if (stat.isDirectory()) return 'Error: Cannot copy directories. Use system_run with cp -r instead.';

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    this.logger.log(`Copied ${src} → ${dest}`);
    return `Copied ${src} → ${dest} (${formatSize(stat.size)})`;
  }

  // ─── Smart Edit Actions ─────────────────────────────────────────────────────

  private async replaceInFile(filePath: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const oldText = args.old_text != null ? String(args.old_text) : '';
    const newText = args.new_text != null ? String(args.new_text) : '';
    const replaceAll = Boolean(args.replace_all);

    if (!oldText) return 'Error: "old_text" is required — the exact text to find in the file.';

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Write blocked for safety. Path matches: ${blocked}`;

    const content = await fs.readFile(filePath, 'utf-8');

    if (!content.includes(oldText)) {
      // Help the agent debug: show nearby context
      const lines = content.split('\n');
      const firstWord = oldText.split(/\s+/)[0] ?? '';
      const nearLines = firstWord
        ? lines
            .map((l, i) => ({ line: i + 1, text: l }))
            .filter((l) => l.text.includes(firstWord))
            .slice(0, 3)
        : [];

      let hint = 'Error: old_text not found in file. The text must match exactly (including whitespace and indentation).';
      if (nearLines.length > 0) {
        hint += `\n\nLines containing "${firstWord}":\n` + nearLines.map((l) => `  ${l.line}: ${l.text}`).join('\n');
      }
      return hint;
    }

    let updated: string;
    let count: number;

    if (replaceAll) {
      count = content.split(oldText).length - 1;
      updated = content.split(oldText).join(newText);
    } else {
      count = 1;
      const idx = content.indexOf(oldText);
      updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
    }

    await fs.writeFile(filePath, updated, 'utf-8');
    this.logger.log(`replace_in_file: ${count} replacement(s) in ${filePath}`);

    const action = newText === '' ? 'deleted' : 'replaced';
    return `Successfully ${action} ${count} occurrence(s) in ${filePath}.`;
  }

  private async insertLines(filePath: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const content = String(args.content ?? '');
    if (!content) return 'Error: "content" is required — text to insert.';

    const lineNum = Number(args.line) || 0;

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Write blocked for safety. Path matches: ${blocked}`;

    const existing = await fs.readFile(filePath, 'utf-8');
    const lines = existing.split('\n');

    if (lineNum <= 0 || lineNum > lines.length) {
      // Append at end
      const newContent = existing.endsWith('\n') ? existing + content : existing + '\n' + content;
      await fs.writeFile(filePath, newContent, 'utf-8');
      this.logger.log(`insert_lines: appended at end of ${filePath}`);
      return `Successfully inserted text at end of ${filePath} (after line ${lines.length}).`;
    }

    // Insert BEFORE the specified line
    const insertContent = content.endsWith('\n') ? content : content + '\n';
    const before = lines.slice(0, lineNum - 1);
    const after = lines.slice(lineNum - 1);
    const updated = [...before, ...insertContent.split('\n').slice(0, -1), ...after].join('\n');

    await fs.writeFile(filePath, updated, 'utf-8');
    this.logger.log(`insert_lines: inserted before line ${lineNum} in ${filePath}`);
    return `Successfully inserted text before line ${lineNum} in ${filePath}.`;
  }

  private async deleteLines(filePath: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const lineStart = Number(args.line_start) || 0;
    const lineEnd = Number(args.line_end) || 0;

    if (lineStart <= 0) return 'Error: "line_start" is required (1-indexed).';
    if (lineEnd <= 0) return 'Error: "line_end" is required (1-indexed, inclusive).';
    if (lineEnd < lineStart) return 'Error: "line_end" must be >= "line_start".';

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Write blocked for safety. Path matches: ${blocked}`;

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    if (lineStart > lines.length) return `Error: line_start (${lineStart}) exceeds file length (${lines.length} lines).`;

    const effectiveEnd = Math.min(lineEnd, lines.length);
    const deleted = lines.splice(lineStart - 1, effectiveEnd - lineStart + 1);
    const updated = lines.join('\n');

    await fs.writeFile(filePath, updated, 'utf-8');
    this.logger.log(`delete_lines: removed lines ${lineStart}-${effectiveEnd} from ${filePath}`);
    return `Successfully deleted ${deleted.length} line(s) (${lineStart}-${effectiveEnd}) from ${filePath}.`;
  }

  private async applyPatch(filePath: string, args: Record<string, unknown>): Promise<string> {
    if (!filePath) return 'Error: No path provided.';

    const diff = String(args.diff ?? '');
    if (!diff) return 'Error: "diff" is required — unified diff content.';

    const blocked = this.isBlockedWrite(filePath);
    if (blocked) return `Error: Write blocked for safety. Path matches: ${blocked}`;

    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Parse unified diff hunks
    const hunks = this.parseDiffHunks(diff);
    if (hunks.length === 0) return 'Error: No valid diff hunks found. Expected unified diff format with @@ -X,Y +X,Y @@ headers.';

    // Apply hunks in reverse order to preserve line numbers
    const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

    let applied = 0;
    const errors: string[] = [];

    for (const hunk of sortedHunks) {
      const result = this.applyHunk(lines, hunk);
      if (result.success) {
        applied++;
      } else {
        errors.push(result.error!);
      }
    }

    if (applied === 0) {
      return `Error: Failed to apply any hunks.\n${errors.join('\n')}`;
    }

    const updated = lines.join('\n');
    await fs.writeFile(filePath, updated, 'utf-8');
    this.logger.log(`patch: applied ${applied}/${hunks.length} hunk(s) to ${filePath}`);

    if (errors.length > 0) {
      return `Partially applied: ${applied}/${hunks.length} hunks succeeded.\nFailed:\n${errors.join('\n')}`;
    }

    return `Successfully applied ${applied} hunk(s) to ${filePath}.`;
  }

  private parseDiffHunks(diff: string): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> {
    const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> = [];
    const hunkHeaderRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

    const diffLines = diff.split('\n');
    let currentHunk: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] } | null = null;

    for (const line of diffLines) {
      const match = hunkHeaderRegex.exec(line);
      if (match) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = {
          oldStart: parseInt(match[1]!, 10),
          oldCount: parseInt(match[2] ?? '1', 10),
          newStart: parseInt(match[3]!, 10),
          newCount: parseInt(match[4] ?? '1', 10),
          lines: [],
        };
        continue;
      }

      if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentHunk.lines.push(line);
      }
    }

    if (currentHunk) hunks.push(currentHunk);
    return hunks;
  }

  private applyHunk(
    fileLines: string[],
    hunk: { oldStart: number; oldCount: number; lines: string[] },
  ): { success: boolean; error?: string } {
    const oldLines = hunk.lines.filter((l) => l.startsWith('-') || l.startsWith(' ')).map((l) => l.slice(1));
    const startIdx = hunk.oldStart - 1;

    // Verify context matches
    for (let i = 0; i < oldLines.length; i++) {
      const fileIdx = startIdx + i;
      if (fileIdx >= fileLines.length) {
        return { success: false, error: `Hunk @${hunk.oldStart}: file too short at line ${fileIdx + 1}` };
      }
      if (fileLines[fileIdx] !== oldLines[i]) {
        return {
          success: false,
          error: `Hunk @${hunk.oldStart}: mismatch at line ${fileIdx + 1}.\n  Expected: "${oldLines[i]}"\n  Actual:   "${fileLines[fileIdx]}"`,
        };
      }
    }

    // Build replacement lines
    const newLines = hunk.lines
      .filter((l) => l.startsWith('+') || l.startsWith(' '))
      .map((l) => l.slice(1));

    fileLines.splice(startIdx, oldLines.length, ...newLines);
    return { success: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private resolvePath(p: string): string {
    if (!p) return '';
    if (path.isAbsolute(p)) return path.normalize(p);
    // Resolve relative paths against workspace
    const workspace = this.allowedRoots[0] ?? process.cwd();
    return path.resolve(workspace, p);
  }

  private async resolveAndValidatePath(filePath: string, mode: FileAccessMode): Promise<string> {
    if (!filePath) {
      throw new Error('No path provided.');
    }

    const blockedPath = this.isBlockedPath(filePath);
    if (blockedPath) {
      throw new Error(`Path is protected for safety. Path matches: ${blockedPath}`);
    }

    if (mode === 'write') {
      const blockedWrite = this.isBlockedWrite(filePath);
      if (blockedWrite) {
        throw new Error(`Write blocked for safety. Path matches protected pattern: ${blockedWrite}`);
      }
    }

    const canonicalPath = await this.resolveCanonicalPath(filePath);
    if (!this.isWithinAllowedRoots(canonicalPath)) {
      throw new Error(`Path is outside allowed roots. Allowed roots: ${this.allowedRoots.join(', ')}`);
    }

    return filePath;
  }

  private async resolveCanonicalPath(filePath: string): Promise<string> {
    const existingAncestor = await this.findExistingAncestor(filePath);
    const realAncestor = await fs.realpath(existingAncestor).catch(() => existingAncestor);
    return path.resolve(realAncestor, path.relative(existingAncestor, filePath));
  }

  private async findExistingAncestor(filePath: string): Promise<string> {
    let current = path.resolve(filePath);

    while (!existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }

      current = parent;
    }

    return current;
  }

  private isWithinAllowedRoots(candidatePath: string): boolean {
    return this.allowedRoots.some((root) => {
      const relative = path.relative(root, candidatePath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  }

  private isBlockedPath(filePath: string): string | null {
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(filePath)) {
        return pattern.source;
      }
    }
    return null;
  }

  private isBlockedWrite(filePath: string): string | null {
    for (const pattern of BLOCKED_WRITE_PATTERNS) {
      if (pattern.test(filePath)) {
        return pattern.source;
      }
    }
    return null;
  }

  private async walkDir(
    dir: string,
    pattern: string,
    results: string[],
    depth: number,
    maxDepth: number,
  ): Promise<void> {
    if (depth > maxDepth || results.length >= MAX_SEARCH_RESULTS) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_RESULTS) break;
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.walkDir(fullPath, pattern, results, depth + 1, maxDepth);
        } else if (this.matchGlob(entry.name, pattern)) {
          const stat = statSync(fullPath);
          results.push(`  ${fullPath} (${formatSize(stat.size)})`);
        }
      }
    } catch {
      // Permission denied or other error — skip directory
    }
  }

  private matchGlob(filename: string, pattern: string): boolean {
    // Simple glob: * matches any chars, ? matches single char
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`, 'i').test(filename);
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 50) + `\n\n... (truncated, ${text.length} total chars)`;
}
