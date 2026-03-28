import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { assertSafeUrl, isRedirectStatus } from '../../shared/ssrf-guard';

// ─── Constants ───────────────────────────────────────────────────────────────

/** HTTP timeout for requests */
const REQUEST_TIMEOUT_MS = 30_000;
/** Maximum response body size returned to LLM (characters) */
const MAX_RESPONSE_LENGTH = 12_000;
/** Maximum number of redirects to follow */
const MAX_REDIRECTS = 5;
/** Maximum request body size (characters) */
const MAX_BODY_LENGTH = 50_000;
/** Allowed HTTP methods */
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
type HttpMethod = (typeof ALLOWED_METHODS)[number];

/** Headers that must not be overridden by the LLM */
const FORBIDDEN_HEADERS = new Set([
  'host', 'transfer-encoding', 'connection', 'upgrade',
  'proxy-authorization', 'proxy-connection',
]);

@Injectable()
export class HttpRequestTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(HttpRequestTool.name);

  readonly definition: ToolDefinition = {
    name: 'http_request',
    description:
      'Make an HTTP request to any URL. Use this for calling REST APIs, webhooks, GraphQL endpoints, ' +
      'or any HTTP service. Supports all standard methods (GET, POST, PUT, PATCH, DELETE, HEAD), ' +
      'custom headers, JSON/text request bodies, and Bearer token authentication. ' +
      'Returns the response status, headers, and body. ' +
      'NOTE: For simply reading a web page, prefer the web_fetch tool instead.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to request (must start with http:// or https://).',
        },
        method: {
          type: 'string',
          description: 'HTTP method. Default: GET.',
          enum: [...ALLOWED_METHODS],
        },
        headers: {
          type: 'object',
          description:
            'Custom request headers as key-value pairs (e.g. {"Accept": "application/json", "X-Custom": "value"}). ' +
            'Content-Type defaults to application/json when body is provided.',
          properties: {},
        },
        body: {
          type: 'string',
          description:
            'Request body as a string. For JSON, pass a JSON-encoded string. ' +
            'Automatically sets Content-Type to application/json if body looks like JSON and no Content-Type is specified.',
        },
        bearer_token: {
          type: 'string',
          description: 'Bearer token for Authorization header. Shorthand for setting Authorization: Bearer <token>.',
        },
        follow_redirects: {
          type: 'boolean',
          description: 'Whether to follow HTTP redirects (default: true).',
        },
        max_response_length: {
          type: 'number',
          description: `Maximum response body length to return (default: ${MAX_RESPONSE_LENGTH}, max: ${MAX_RESPONSE_LENGTH}).`,
        },
      },
      required: ['url'],
    },
    safety: 'moderate',
    timeoutMs: REQUEST_TIMEOUT_MS,
  };

  constructor(private readonly registry: ToolRegistryService) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('http_request tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    // ─── Parse & validate inputs ──────────────────────────────────────
    const rawUrl = String(args.url ?? '').trim();
    if (!rawUrl) return 'Error: "url" is required.';

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return `Error: Invalid URL "${rawUrl}".`;
    }

    const method = this.parseMethod(args.method);
    if (!method) {
      return `Error: Invalid method "${String(args.method)}". Allowed: ${ALLOWED_METHODS.join(', ')}.`;
    }

    // Ignore body for GET/HEAD — fetch throws if body is present for these methods
    const rawBody = args.body !== undefined ? String(args.body) : undefined;
    const body = (method === 'GET' || method === 'HEAD') ? undefined : (rawBody || undefined);
    if (body && body.length > MAX_BODY_LENGTH) {
      return `Error: Request body too large (${body.length} chars, max ${MAX_BODY_LENGTH}).`;
    }

    const followRedirects = args.follow_redirects !== false;
    const maxResponseLen = Math.min(
      Math.max(Number(args.max_response_length) || MAX_RESPONSE_LENGTH, 100),
      MAX_RESPONSE_LENGTH,
    );

    // ─── Build headers ───────────────────────────────────────────────
    const headers = new Headers();
    headers.set('User-Agent', 'Argus/1.0');
    headers.set('Accept', '*/*');

    // Apply custom headers
    if (args.headers && typeof args.headers === 'object') {
      for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
        const normalized = key.toLowerCase();
        if (FORBIDDEN_HEADERS.has(normalized)) continue;
        headers.set(key, String(value));
      }
    }

    // Bearer token shorthand
    if (args.bearer_token) {
      headers.set('Authorization', `Bearer ${String(args.bearer_token)}`);
    }

    // Auto-set Content-Type for JSON bodies
    if (body && !headers.has('Content-Type')) {
      if (looksLikeJson(body)) {
        headers.set('Content-Type', 'application/json');
      } else {
        headers.set('Content-Type', 'text/plain');
      }
    }

    // ─── Execute request ─────────────────────────────────────────────
    try {
      const response = followRedirects
        ? await this.fetchWithRedirects(parsed, method, headers, body)
        : await this.fetchOnce(parsed, method, headers, body);

      return await this.formatResponse(response, rawUrl, maxResponseLen);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`http_request failed for ${method} ${rawUrl}: ${message}`);
      return `Error: ${message}`;
    }
  }

  // ─── Fetch with safe redirect following ────────────────────────────────────

  private async fetchWithRedirects(
    initialUrl: URL,
    method: HttpMethod,
    headers: Headers,
    body: string | undefined,
  ): Promise<Response> {
    let currentUrl = new URL(initialUrl.toString());

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await assertSafeUrl(currentUrl);

      const response = await fetch(currentUrl.toString(), {
        method: i === 0 ? method : 'GET', // redirects always become GET (except 307/308)
        headers,
        body: i === 0 ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!isRedirectStatus(response.status)) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect from ${currentUrl.toString()} has no Location header.`);
      }

      currentUrl = new URL(location, currentUrl);

      // 307/308 preserve method and body
      if (response.status !== 307 && response.status !== 308) {
        // Reset to GET for 301/302/303
        continue;
      }
    }

    throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
  }

  private async fetchOnce(
    url: URL,
    method: HttpMethod,
    headers: Headers,
    body: string | undefined,
  ): Promise<Response> {
    await assertSafeUrl(url);

    return fetch(url.toString(), {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  // ─── Response formatting ───────────────────────────────────────────────────

  private async formatResponse(
    response: Response,
    url: string,
    maxLen: number,
  ): Promise<string> {
    const lines: string[] = [
      `HTTP ${response.status} ${response.statusText}`,
      `URL: ${url}`,
      '',
      '--- Response Headers ---',
    ];

    // Include useful response headers
    const interestingHeaders = [
      'content-type', 'content-length', 'location', 'x-request-id',
      'x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after',
      'etag', 'last-modified', 'cache-control',
    ];

    for (const name of interestingHeaders) {
      const value = response.headers.get(name);
      if (value) {
        lines.push(`${name}: ${value}`);
      }
    }

    lines.push('');

    // Body
    if (response.status === 204 || response.status === 304) {
      lines.push('(no body)');
    } else {
      try {
        const text = await response.text();
        if (text.length === 0) {
          lines.push('(empty body)');
        } else if (text.length > maxLen) {
          lines.push('--- Response Body (truncated) ---');
          lines.push(text.slice(0, maxLen));
          lines.push(`\n... (truncated, ${text.length} total chars)`);
        } else {
          lines.push('--- Response Body ---');
          lines.push(text);
        }
      } catch {
        lines.push('(could not read response body)');
      }
    }

    return lines.join('\n');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private parseMethod(value: unknown): HttpMethod | null {
    if (!value) return 'GET';
    const upper = String(value).toUpperCase();
    return (ALLOWED_METHODS as readonly string[]).includes(upper) ? (upper as HttpMethod) : null;
  }
}


function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}
