import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum markdown content length */
const MAX_CONTENT_LENGTH = 100_000;

/** Maximum output file path length */
const MAX_PATH_LENGTH = 500;

/** Document generation timeout */
const TIMEOUT_MS = 30_000;

/** Allowed output formats */
const ALLOWED_FORMATS = ['pdf', 'html'] as const;
type OutputFormat = (typeof ALLOWED_FORMATS)[number];

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
export class DocumentGenTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(DocumentGenTool.name);
  private readonly allowedRoots: string[];
  private readonly outputDir: string;
  private readonly enabled: boolean;

  readonly definition: ToolDefinition = {
    name: 'document_gen',
    description:
      'Generate documents (PDF or HTML) from Markdown content.\n\n' +
      'Use cases:\n' +
      '- Create PDF reports, summaries, letters, invoices\n' +
      '- Export formatted HTML documents\n' +
      '- Generate documentation from markdown\n\n' +
      'Provide markdown content and an output path. ' +
      'The document will be styled with a clean, professional look. ' +
      'For PDF generation, uses a headless browser renderer for high quality output.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Markdown content to convert into a document.',
        },
        output_path: {
          type: 'string',
          description:
            'Output file path (absolute or workspace-relative). ' +
            'Extension determines format: .pdf or .html. E.g. "reports/summary.pdf".',
        },
        title: {
          type: 'string',
          description: 'Document title (used in HTML <title> and PDF metadata). Optional.',
        },
        page_size: {
          type: 'string',
          description: 'Page size for PDF: "A4" (default), "Letter", "A3", "Legal".',
          enum: ['A4', 'Letter', 'A3', 'Legal'],
        },
        landscape: {
          type: 'boolean',
          description: 'Use landscape orientation for PDF. Default: false.',
        },
      },
      required: ['content', 'output_path'],
    },
    safety: 'moderate',
    timeoutMs: TIMEOUT_MS,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
  ) {
    const workspace = this.configService.get<string>('tools.systemRun.workingDirectory', process.cwd());
    const configuredRoots = this.configService.get<string[]>('tools.fileOps.allowedRoots', []);
    const roots = configuredRoots.length > 0 ? configuredRoots : [workspace];
    this.allowedRoots = [...new Set(roots.filter((r) => r.trim().length > 0).map((r) => path.resolve(r)))];
    this.outputDir = this.configService.get<string>(
      'tools.documentGen.outputDir',
      path.join(workspace, 'data', 'documents'),
    );
    this.enabled = this.configService.get<boolean>('tools.documentGen.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('document_gen tool is disabled via config');
      return;
    }
    this.registry.register(this);
    this.logger.log(`document_gen tool registered (output dir: ${this.outputDir})`);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = String(args.content ?? '').trim();
    const rawPath = String(args.output_path ?? '').trim();
    const title = String(args.title ?? '').trim() || 'Document';
    const pageSize = String(args.page_size ?? 'A4').trim();
    const landscape = Boolean(args.landscape);

    // ─── Validation ──────────────────────────────────────────────────────

    if (!content) return 'Error: "content" is required.';
    if (!rawPath) return 'Error: "output_path" is required.';

    if (content.length > MAX_CONTENT_LENGTH) {
      return `Error: Content too long (${content.length} chars, max ${MAX_CONTENT_LENGTH}).`;
    }

    if (rawPath.length > MAX_PATH_LENGTH) {
      return `Error: Output path too long (${rawPath.length} chars, max ${MAX_PATH_LENGTH}).`;
    }

    const ext = path.extname(rawPath).toLowerCase().replace('.', '') as OutputFormat;
    if (!ALLOWED_FORMATS.includes(ext)) {
      return `Error: Unsupported format ".${ext}". Use .pdf or .html.`;
    }

    try {
      const outputPath = await this.resolveAndValidateOutput(rawPath);

      // Ensure output directory exists
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const html = this.markdownToHtml(content, title);

      if (ext === 'html') {
        await fs.writeFile(outputPath, html, 'utf-8');
        const stat = await fs.stat(outputPath);
        return [
          `HTML document generated successfully.`,
          `Path: ${outputPath}`,
          `Size: ${formatSize(stat.size)}`,
        ].join('\n');
      }

      // PDF via Playwright
      return await this.generatePdf(html, outputPath, pageSize, landscape);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`document_gen failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  // ─── PDF Generation ──────────────────────────────────────────────────────

  private async generatePdf(
    html: string,
    outputPath: string,
    pageSize: string,
    landscape: boolean,
  ): Promise<string> {
    const { chromium } = await import('playwright');

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.setContent(html, { waitUntil: 'networkidle' });

      await page.pdf({
        path: outputPath,
        format: pageSize as 'A4' | 'Letter' | 'A3' | 'Legal',
        landscape,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate:
          '<div style="width:100%;text-align:center;font-size:9px;color:#999;">' +
          '<span class="pageNumber"></span> / <span class="totalPages"></span>' +
          '</div>',
      });

      const stat = await fs.stat(outputPath);

      return [
        `PDF document generated successfully.`,
        `Path: ${outputPath}`,
        `Size: ${formatSize(stat.size)}`,
        `Page size: ${pageSize}${landscape ? ' (landscape)' : ''}`,
      ].join('\n');
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  // ─── Markdown → HTML ─────────────────────────────────────────────────────

  /**
   * Converts Markdown to styled HTML. Uses a lightweight regex-based parser
   * to avoid external dependencies. Handles: headings, paragraphs, bold,
   * italic, code blocks, inline code, lists, blockquotes, links, images,
   * horizontal rules, and tables.
   */
  private markdownToHtml(markdown: string, title: string): string {
    const body = this.parseMarkdown(markdown);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; line-height: 1.3; }
    h1 { font-size: 2em; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.2em; }
    h3 { font-size: 1.25em; }
    h4 { font-size: 1.1em; }
    p { margin: 0.8em 0; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.9em;
    }
    pre {
      background: #f6f8fa;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
      border: 1px solid #e1e4e8;
    }
    pre code { background: none; padding: 0; font-size: 0.85em; }
    blockquote {
      border-left: 4px solid #dfe2e5;
      padding: 0.5em 1em;
      margin: 1em 0;
      color: #555;
      background: #fafafa;
    }
    ul, ol { margin: 0.8em 0; padding-left: 2em; }
    li { margin: 0.3em 0; }
    hr { border: none; border-top: 2px solid #e0e0e0; margin: 2em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #dfe2e5; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    img { max-width: 100%; height: auto; }
    strong { font-weight: 600; }
    em { font-style: italic; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
  }

  private parseMarkdown(md: string): string {
    const lines = md.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
    let codeBlockLang = '';
    let inList = false;
    let listType: 'ul' | 'ol' = 'ul';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Code blocks
      if (line.trimStart().startsWith('```')) {
        if (inCodeBlock) {
          result.push(`<pre><code class="language-${escapeHtml(codeBlockLang)}">${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
          codeBlockContent = [];
          codeBlockLang = '';
          inCodeBlock = false;
        } else {
          if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
          codeBlockLang = line.trimStart().slice(3).trim();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
        continue;
      }

      // Empty line — close list
      if (!line.trim()) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        continue;
      }

      // Headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        const level = headingMatch[1]!.length;
        result.push(`<h${level}>${this.inlineFormat(headingMatch[2]!)}</h${level}>`);
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        result.push('<hr>');
        continue;
      }

      // Blockquote
      if (line.trimStart().startsWith('> ')) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        const quoteContent = line.trimStart().slice(2);
        result.push(`<blockquote><p>${this.inlineFormat(quoteContent)}</p></blockquote>`);
        continue;
      }

      // Table row detection (simplified)
      if (line.includes('|') && line.trim().startsWith('|')) {
        if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        const tableResult = this.parseTable(lines, i);
        if (tableResult) {
          result.push(tableResult.html);
          i = tableResult.endIndex;
          continue;
        }
      }

      // Unordered list
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (ulMatch) {
        if (!inList || listType !== 'ul') {
          if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
          result.push('<ul>');
          inList = true;
          listType = 'ul';
        }
        result.push(`<li>${this.inlineFormat(ulMatch[2]!)}</li>`);
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
      if (olMatch) {
        if (!inList || listType !== 'ol') {
          if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
          result.push('<ol>');
          inList = true;
          listType = 'ol';
        }
        result.push(`<li>${this.inlineFormat(olMatch[2]!)}</li>`);
        continue;
      }

      // Paragraph
      if (inList) { result.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
      result.push(`<p>${this.inlineFormat(line)}</p>`);
    }

    // Close open blocks
    if (inCodeBlock) {
      result.push(`<pre><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
    }
    if (inList) {
      result.push(listType === 'ul' ? '</ul>' : '</ol>');
    }

    return result.join('\n');
  }

  private parseTable(lines: string[], startIndex: number): { html: string; endIndex: number } | null {
    const headerLine = lines[startIndex]!;
    const separatorLine = lines[startIndex + 1];

    if (!separatorLine || !/^\|[\s-:|]+\|$/.test(separatorLine.trim())) {
      return null;
    }

    const parseRow = (line: string): string[] =>
      line.split('|').slice(1, -1).map((cell) => cell.trim());

    const headers = parseRow(headerLine);
    const rows: string[][] = [];

    let endIndex = startIndex + 1;
    for (let i = startIndex + 2; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim().startsWith('|')) break;
      rows.push(parseRow(line));
      endIndex = i;
    }

    const headerHtml = headers.map((h) => `<th>${this.inlineFormat(h)}</th>`).join('');
    const bodyHtml = rows.map((row) =>
      '<tr>' + row.map((cell) => `<td>${this.inlineFormat(cell)}</td>`).join('') + '</tr>',
    ).join('\n');

    return {
      html: `<table>\n<thead><tr>${headerHtml}</tr></thead>\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`,
      endIndex,
    };
  }

  /** Apply inline formatting: bold, italic, code, links, images */
  private inlineFormat(text: string): string {
    let result = escapeHtml(text);

    // Inline code (must be first to avoid double-processing)
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Images
    result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

    // Links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Bold + Italic
    result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

    // Bold
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
    result = result.replace(/_(.+?)_/g, '<em>$1</em>');

    // Strikethrough
    result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');

    return result;
  }

  // ─── Path validation ─────────────────────────────────────────────────────

  private async resolveAndValidateOutput(rawPath: string): Promise<string> {
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

    // If directory part exists and has symlinks, verify target
    const dir = path.dirname(resolved);
    if (existsSync(dir)) {
      const realDir = await fs.realpath(dir);
      const realResolved = path.join(realDir, path.basename(resolved));
      const realWithinRoots = this.allowedRoots.some((root) => {
        const relative = path.relative(root, realResolved);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });

      if (!realWithinRoots) {
        throw new Error('Access denied: symlink target directory is outside allowed directories.');
      }

      return realResolved;
    }

    return resolved;
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
