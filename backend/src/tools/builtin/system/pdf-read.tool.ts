import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum PDF file size (20 MB) */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Maximum text output length returned to the LLM */
const MAX_OUTPUT_LENGTH = 15_000;

/** Maximum pages to extract at once */
const MAX_PAGES = 100;

/** Protected files/paths that must never be exposed. */
const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)\.(?:ssh|gnupg|aws|kube)(?:\/|$)/i,
  /(?:^|\/)\.(?:bash_history|zsh_history|npmrc|pypirc|netrc)$/i,
  /(?:^|\/)\.env(?:\.(?:local|development|production|staging|test))?$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|\/).+\.(?:pem|key|p12|pfx)$/i,
];

// ─── Tool ────────────────────────────────────────────────────────────────────

@Injectable()
export class PdfReadTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(PdfReadTool.name);
  private readonly allowedRoots: string[];

  readonly definition: ToolDefinition = {
    name: 'pdf_read',
    description:
      'Extract text content and metadata from a PDF file.\n\n' +
      'Features:\n' +
      '- Extract all text or specific page ranges\n' +
      '- Get document metadata (title, author, page count, creation date)\n' +
      '- Supports large documents with pagination\n\n' +
      'The file path must be within the allowed workspace directories.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative path to the PDF file.',
        },
        page_start: {
          type: 'number',
          description: 'First page to extract (1-indexed). Default: 1.',
        },
        page_end: {
          type: 'number',
          description: 'Last page to extract (inclusive). Default: last page.',
        },
        metadata_only: {
          type: 'boolean',
          description: 'If true, return only metadata (title, author, pages, dates) without text content.',
        },
      },
      required: ['path'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {
    const workspace = this.configService.get<string>('tools.systemRun.workingDirectory', process.cwd());
    const configuredRoots = this.configService.get<string[]>('tools.fileOps.allowedRoots', []);
    const roots = configuredRoots.length > 0 ? configuredRoots : [workspace];
    this.allowedRoots = [...new Set(roots.filter((r) => r.trim().length > 0).map((r) => path.resolve(r)))];
  }

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log(`pdf_read tool registered (allowed roots: ${this.allowedRoots.join(', ')})`);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const rawPath = String(args.path ?? '').trim();
      if (!rawPath) return 'Error: "path" is required.';

      const filePath = await this.resolveAndValidate(rawPath);
      const metadataOnly = Boolean(args.metadata_only);
      const pageStart = Number(args.page_start) || 1;
      const pageEnd = Number(args.page_end) || 0; // 0 = all

      // Read file
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) return 'Error: Path is a directory, not a PDF file.';
      if (stat.size > MAX_FILE_SIZE) {
        return `Error: PDF too large (${formatSize(stat.size)}, max ${formatSize(MAX_FILE_SIZE)}).`;
      }
      if (stat.size === 0) return 'Error: File is empty.';

      // Verify extension
      if (!filePath.toLowerCase().endsWith('.pdf')) {
        return 'Error: File does not have .pdf extension. Only PDF files are supported.';
      }

      const buffer = await fs.readFile(filePath);
      const uint8 = new Uint8Array(buffer);

      // pdf-parse v2 — class-based API
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse(uint8);
      await parser.load();

      const textResult: PdfTextResult = await parser.getText();
      const infoResult: PdfInfoResult = await parser.getInfo();
      const totalPages = textResult.total ?? infoResult.total ?? 0;

      // ─── Metadata ────────────────────────────────────────────────────────
      const info = infoResult.info ?? {};
      const meta: string[] = [
        `File: ${filePath}`,
        `Size: ${formatSize(stat.size)}`,
        `Pages: ${totalPages}`,
      ];

      if (info.Title) meta.push(`Title: ${info.Title}`);
      if (info.Author) meta.push(`Author: ${info.Author}`);
      if (info.Subject) meta.push(`Subject: ${info.Subject}`);
      if (info.Creator) meta.push(`Creator: ${info.Creator}`);
      if (info.Producer) meta.push(`Producer: ${info.Producer}`);
      if (info.PDFFormatVersion) meta.push(`PDF Version: ${info.PDFFormatVersion}`);
      if (info.CreationDate) meta.push(`Created: ${this.formatPdfDate(info.CreationDate)}`);
      if (info.ModDate) meta.push(`Modified: ${this.formatPdfDate(info.ModDate)}`);

      if (metadataOnly) {
        return meta.join('\n');
      }

      // ─── Text extraction ─────────────────────────────────────────────────
      // v2 getText() returns { pages: [{text, num}], text, total }
      const pages = textResult.pages ?? [];
      const fullText = textResult.text ?? '';

      if (!fullText.trim()) {
        return meta.join('\n') + '\n\nNo extractable text found (the PDF may contain only images/scans).';
      }

      // Use per-page data if available, otherwise fall back to splitting full text
      const pageTexts = pages.length > 0
        ? pages.map((p) => p.text)
        : this.splitPages(fullText, totalPages);

      const start = Math.max(1, pageStart);
      const end = pageEnd > 0 ? Math.min(pageEnd, pageTexts.length) : pageTexts.length;

      if (start > pageTexts.length) {
        return `Error: page_start (${start}) exceeds total pages (${pageTexts.length}).`;
      }
      if (end - start + 1 > MAX_PAGES) {
        return `Error: Too many pages requested (${end - start + 1}, max ${MAX_PAGES}). Use page_start/page_end to narrow the range.`;
      }

      const selectedPages = pageTexts.slice(start - 1, end);
      const rangeLabel = start === 1 && end === pageTexts.length
        ? `all ${pageTexts.length} pages`
        : `pages ${start}-${end} of ${pageTexts.length}`;

      let output = meta.join('\n') + `\nExtracted: ${rangeLabel}\n\n`;

      for (let i = 0; i < selectedPages.length; i++) {
        const pageNum = start + i;
        const pageText = selectedPages[i]!.trim();
        if (pageText) {
          output += `── Page ${pageNum} ──\n${pageText}\n\n`;
        }
      }

      return truncate(output.trim(), MAX_OUTPUT_LENGTH);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`pdf_read failed: ${msg}`);

      if (msg.includes('Invalid PDF') || msg.includes('not a PDF')) {
        return 'Error: The file does not appear to be a valid PDF document.';
      }

      return `Error: ${msg}`;
    }
  }

  // ─── Page splitting ─────────────────────────────────────────────────────────

  private splitPages(text: string, expectedPages: number): string[] {
    // pdf-parse inserts form feed (\f) between pages
    const byFormFeed = text.split('\f').filter((p) => p.trim().length > 0);

    if (byFormFeed.length > 1) {
      return byFormFeed;
    }

    // Fallback: if no form feeds, try to split evenly based on expected page count
    if (expectedPages > 1) {
      const lines = text.split('\n');
      const linesPerPage = Math.ceil(lines.length / expectedPages);

      if (linesPerPage > 5) {
        const pages: string[] = [];
        for (let i = 0; i < lines.length; i += linesPerPage) {
          pages.push(lines.slice(i, i + linesPerPage).join('\n'));
        }
        return pages;
      }
    }

    // Single page / can't split
    return [text];
  }

  // ─── Date formatting ────────────────────────────────────────────────────────

  private formatPdfDate(raw: string): string {
    // PDF dates: D:YYYYMMDDHHmmSS or standard ISO strings
    if (typeof raw !== 'string') return String(raw);

    const match = raw.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
    if (match) {
      const [, year, month, day, hour, min, sec] = match;
      return `${year}-${month}-${day}${hour ? ` ${hour}:${min ?? '00'}:${sec ?? '00'}` : ''}`;
    }

    return raw;
  }

  // ─── Path validation (reuses file-ops patterns) ─────────────────────────────

  private async resolveAndValidate(rawPath: string): Promise<string> {
    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.allowedRoots[0] ?? process.cwd(), rawPath);

    // Block sensitive paths
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        throw new Error(`Access denied: path matches blocked pattern.`);
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

    // Resolve symlinks for the existing part of the path
    if (existsSync(resolved)) {
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

    throw new Error(`File not found: ${resolved}`);
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PdfTextResult {
  pages: Array<{ text: string; num: number }>;
  text: string;
  total: number;
}

interface PdfInfoResult {
  total: number;
  info: Record<string, string>;
  metadata: unknown;
  fingerprints?: string[];
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 80) + `\n\n... (truncated, ${text.length} total chars. Use page_start/page_end to read specific pages)`;
}
