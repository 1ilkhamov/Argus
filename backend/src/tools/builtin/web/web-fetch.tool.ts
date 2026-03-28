import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { assertSafeUrl, isRedirectStatus } from '../../shared/ssrf-guard';

/** Maximum content length returned to the LLM (characters) */
const MAX_CONTENT_LENGTH = 12_000;
/** HTTP timeout for fetch requests */
const FETCH_TIMEOUT_MS = 20_000;
/** Redirect limit to avoid SSRF chains */
const MAX_REDIRECTS = 5;

@Injectable()
export class WebFetchTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(WebFetchTool.name);

  readonly definition: ToolDefinition = {
    name: 'web_fetch',
    description:
      'Fetch and read the text content of a web page by URL (lightweight, no browser needed). ' +
      'Best for static HTML pages, articles, documentation, and simple pages. ' +
      'You SHOULD use this after web_search when you need full content from search result URLs. ' +
      'NOTE: This tool does NOT execute JavaScript — for JS-heavy sites or SPAs (React, Angular, etc.) use the browser tool instead. ' +
      'Also use this when the user provides a URL to read.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the web page to fetch (must start with http:// or https://)',
        },
        max_length: {
          type: 'number',
          description: `Maximum characters to return (default ${MAX_CONTENT_LENGTH}, max ${MAX_CONTENT_LENGTH})`,
        },
      },
      required: ['url'],
    },
    safety: 'safe',
    timeoutMs: FETCH_TIMEOUT_MS,
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('Web fetch tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) {
      return 'Error: URL is required.';
    }

    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return `Error: invalid URL "${rawUrl}"`;
    }

    const maxLength = Math.min(
      Math.max(Number(args.max_length) || MAX_CONTENT_LENGTH, 500),
      MAX_CONTENT_LENGTH,
    );

    try {
      const response = await this.fetchSafely(parsed);

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText} for ${rawUrl}`;
      }

      const contentType = response.headers.get('content-type') || '';

      // Handle JSON responses directly
      if (contentType.includes('application/json')) {
        const json = await response.text();
        return truncateContent(`[JSON from ${rawUrl}]\n\n${json}`, maxLength);
      }

      // Handle plain text
      if (contentType.includes('text/plain')) {
        const text = await response.text();
        return truncateContent(`[Text from ${rawUrl}]\n\n${text}`, maxLength);
      }

      // Handle HTML — extract text
      const html = await response.text();
      const extracted = extractTextFromHtml(html);

      if (!extracted.trim()) {
        return `Fetched ${rawUrl} but could not extract meaningful text content (page may be JavaScript-rendered).`;
      }

      return truncateContent(`[Content from ${rawUrl}]\n\n${extracted}`, maxLength);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`web_fetch failed for ${rawUrl}: ${message}`);
      return `Error fetching ${rawUrl}: ${message}`;
    }
  }

  private async fetchSafely(initialUrl: URL): Promise<Response> {
    let currentUrl = new URL(initialUrl.toString());

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertSafeUrl(currentUrl);

      const response = await fetch(currentUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Argus/1.0; +https://github.com/argus)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!isRedirectStatus(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect response from ${currentUrl.toString()} did not include a location header.`);
      }

      currentUrl = new URL(location, currentUrl);
    }

    throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
  }
}

// ─── HTML text extraction ─────────────────────────────────────────────────────

/**
 * Extract readable text from HTML.
 * Strips scripts, styles, nav, header, footer, and HTML tags.
 * Preserves basic structure with line breaks.
 */
function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove doctype, comments
  text = text.replace(/<!DOCTYPE[^>]*>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove script, style, svg, nav, header, footer, aside
  text = text.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert block elements to newlines
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(ul|ol|table|tbody|thead)>/gi, '\n');

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.trim()) : '';

  // Extract meta description
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const metaDesc = metaDescMatch ? decodeHtmlEntities(metaDescMatch[1]!.trim()) : '';

  // Strip remaining tags
  text = text.replace(/<[^>]*>/g, ' ');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  // Prepend title and description if available
  const header: string[] = [];
  if (title) header.push(`Title: ${title}`);
  if (metaDesc) header.push(`Description: ${metaDesc}`);

  if (header.length > 0) {
    return header.join('\n') + '\n\n' + text;
  }

  return text;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»');
}

function truncateContent(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + '\n\n[... truncated]';
}
