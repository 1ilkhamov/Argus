import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import { SettingsService } from '../../../settings/settings.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { assertSafeRawUrl } from '../../shared/ssrf-guard';

/** Maximum number of results to return to the LLM */
const MAX_RESULTS = 5;
/** Maximum snippet length per result */
const MAX_SNIPPET_LENGTH = 300;
/** HTTP timeout for search requests */
const SEARCH_TIMEOUT_MS = 15_000;


type SearchProvider = 'auto' | 'brave' | 'tavily' | 'jina' | 'searxng' | 'duckduckgo';

/**
 * Provider quality priority for 'auto' mode.
 * The first provider whose credentials are available wins.
 */
const PROVIDER_PRIORITY: Exclude<SearchProvider, 'auto'>[] = [
  'brave',    // best quality — own index, structured snippets
  'tavily',   // purpose-built for AI search
  'jina',     // free tier (10M tokens)
  'searxng',  // self-hosted meta-search
  'duckduckgo', // always available, zero config
];

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface ResolvedKeys {
  braveApiKey: string;
  tavilyApiKey: string;
  jinaApiKey: string;
  searxngBaseUrl: string;
}

@Injectable()
export class WebSearchTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(WebSearchTool.name);
  private readonly configuredProvider: SearchProvider;
  private readonly envBraveApiKey: string;
  private readonly envTavilyApiKey: string;
  private readonly envJinaApiKey: string;
  private readonly envSearxngBaseUrl: string;

  readonly definition: ToolDefinition = {
    name: 'web_search',
    description:
      'Search the internet for current information. Use this when the user asks about recent events, facts you are unsure about, or anything that requires up-to-date data. Returns a list of relevant web page titles, URLs, and short snippets. IMPORTANT: snippets are brief previews only — if you need detailed or precise data (e.g. current weather, prices, full articles), use the web_fetch tool on the most relevant URL from the results.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string',
        },
        max_results: {
          type: 'number',
          description: `Maximum number of results to return (1-${MAX_RESULTS}, default ${MAX_RESULTS})`,
        },
      },
      required: ['query'],
    },
    safety: 'safe',
    timeoutMs: SEARCH_TIMEOUT_MS,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {
    this.configuredProvider = (this.configService.get<string>('tools.webSearch.provider') || 'auto') as SearchProvider;
    this.envBraveApiKey = this.configService.get<string>('tools.webSearch.braveApiKey') || '';
    this.envTavilyApiKey = this.configService.get<string>('tools.webSearch.tavilyApiKey') || '';
    this.envJinaApiKey = this.configService.get<string>('tools.webSearch.jinaApiKey') || '';
    this.envSearxngBaseUrl = this.configService.get<string>('tools.webSearch.searxngUrl') || 'http://localhost:8888';
  }

  async onModuleInit(): Promise<void> {
    this.registry.register(this);
    const keys = await this.resolveKeys();
    const resolved = this.resolveProvider(this.configuredProvider, keys);
    const autoNote = this.configuredProvider === 'auto'
      ? ` (auto-selected from: ${this.availableProviders(keys).join(', ')})`
      : '';
    this.logger.log(`Web search tool registered (provider=${resolved}${autoNote})`);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return 'Error: search query is empty.';
    }

    const maxResults = Math.min(
      Math.max(Number(args.max_results) || MAX_RESULTS, 1),
      MAX_RESULTS,
    );

    // Resolve keys dynamically (DB overrides .env) so UI changes take effect immediately
    const keys = await this.resolveKeys();
    const provider = this.resolveProvider(this.configuredProvider, keys);
    let results: SearchResult[];

    try {
      results = await this.searchWith(provider, query, maxResults, keys);
    } catch (error) {
      // Fallback: try next providers in priority chain
      const fallback = this.findFallback(provider, keys);
      if (fallback) {
        this.logger.warn(
          `Provider ${provider} failed (${error instanceof Error ? error.message : error}), falling back to ${fallback}`,
        );
        try {
          results = await this.searchWith(fallback, query, maxResults, keys);
        } catch (fallbackError) {
          throw new Error(
            `Primary provider ${provider} failed: ${error instanceof Error ? error.message : error}; ` +
            `fallback ${fallback} also failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`,
          );
        }
      } else {
        throw error;
      }
    }

    if (results.length === 0) {
      return `No results found for: "${query}"`;
    }

    return this.formatResults(query, results);
  }

  // ─── Provider resolution + dynamic key resolution ──────────────────────────

  private async resolveKeys(): Promise<ResolvedKeys> {
    const [brave, tavily, jina, searxng] = await Promise.all([
      this.settingsService.getValue('tools.web_search.brave_api_key'),
      this.settingsService.getValue('tools.web_search.tavily_api_key'),
      this.settingsService.getValue('tools.web_search.jina_api_key'),
      this.settingsService.getValue('tools.web_search.searxng_url'),
    ]);
    return {
      braveApiKey: brave || this.envBraveApiKey,
      tavilyApiKey: tavily || this.envTavilyApiKey,
      jinaApiKey: jina || this.envJinaApiKey,
      searxngBaseUrl: searxng || this.envSearxngBaseUrl,
    };
  }

  /**
   * Resolve 'auto' to the best available provider, or validate explicit choice.
   */
  private resolveProvider(configured: SearchProvider, keys: ResolvedKeys): Exclude<SearchProvider, 'auto'> {
    if (configured !== 'auto') {
      return configured as Exclude<SearchProvider, 'auto'>;
    }

    for (const p of PROVIDER_PRIORITY) {
      if (this.isProviderAvailable(p, keys)) return p;
    }

    return 'duckduckgo';
  }

  private availableProviders(keys: ResolvedKeys): string[] {
    return PROVIDER_PRIORITY.filter((p) => this.isProviderAvailable(p, keys));
  }

  private isProviderAvailable(provider: Exclude<SearchProvider, 'auto'>, keys: ResolvedKeys): boolean {
    switch (provider) {
      case 'brave': return !!keys.braveApiKey;
      case 'tavily': return !!keys.tavilyApiKey;
      case 'jina': return !!keys.jinaApiKey;
      case 'searxng': return keys.searxngBaseUrl !== 'http://localhost:8888' && !!keys.searxngBaseUrl;
      case 'duckduckgo': return true;
    }
  }

  private findFallback(failed: Exclude<SearchProvider, 'auto'>, keys: ResolvedKeys): Exclude<SearchProvider, 'auto'> | null {
    const idx = PROVIDER_PRIORITY.indexOf(failed);
    for (let i = idx + 1; i < PROVIDER_PRIORITY.length; i++) {
      if (this.isProviderAvailable(PROVIDER_PRIORITY[i]!, keys)) return PROVIDER_PRIORITY[i]!;
    }
    return failed !== 'duckduckgo' ? 'duckduckgo' : null;
  }

  private async searchWith(
    provider: Exclude<SearchProvider, 'auto'>,
    query: string,
    maxResults: number,
    keys: ResolvedKeys,
  ): Promise<SearchResult[]> {
    switch (provider) {
      case 'brave': return this.searchBrave(query, maxResults, keys.braveApiKey);
      case 'tavily': return this.searchTavily(query, maxResults, keys.tavilyApiKey);
      case 'jina': return this.searchJina(query, maxResults, keys.jinaApiKey);
      case 'searxng': return this.searchSearxng(query, maxResults, keys.searxngBaseUrl);
      case 'duckduckgo': return this.searchDuckDuckGo(query, maxResults);
    }
  }

  // ─── Brave Search (best quality, API key required) ──────────────────────────

  private async searchBrave(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
    if (!apiKey) {
      throw new Error('Brave Search API key not configured');
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Brave Search API returned status ${response.status}`);
    }

    const data = await response.json() as BraveSearchResponse;

    return (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url,
      snippet: truncate(r.description || '', MAX_SNIPPET_LENGTH),
    }));
  }

  // ─── DuckDuckGo (zero config, always available via duck-duck-scrape) ────────

  private async searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    const MAX_RETRIES = 2;
    const BASE_DELAY_MS = 1500;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        const ddgResults = await ddgSearch(query, {
          safeSearch: SafeSearchType.MODERATE,
        });

        if (ddgResults.noResults || !ddgResults.results || ddgResults.results.length === 0) {
          return [];
        }

        return ddgResults.results.slice(0, maxResults).map((r) => ({
          title: r.title || 'Untitled',
          url: r.url,
          snippet: truncate(r.description || '', MAX_SNIPPET_LENGTH),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isRateLimit = message.includes('anomaly') || message.includes('rate');

        if (isRateLimit && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger.warn(`DDG rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error('DDG search exhausted all retries');
  }

  // ─── Jina Search (free tier available) ──────────────────────────────────────

  private async searchJina(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
    if (!apiKey) {
      throw new Error('Jina Search API key not configured');
    }

    const response = await fetch('https://s.jina.ai/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        q: query,
        num: maxResults,
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Jina Search API returned status ${response.status}`);
    }

    const data = await response.json() as JinaSearchResponse;

    return (data.data ?? []).slice(0, maxResults).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url,
      snippet: truncate(r.description || r.content || '', MAX_SNIPPET_LENGTH),
    }));
  }

  // ─── Tavily (purpose-built for AI, API key required) ────────────────────────

  private async searchTavily(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
    if (!apiKey) {
      throw new Error('Tavily API key not configured');
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
        search_depth: 'basic',
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Tavily API returned status ${response.status}`);
    }

    const data = await response.json() as TavilyResponse;

    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url,
      snippet: truncate(r.content || '', MAX_SNIPPET_LENGTH),
    }));
  }

  // ─── SearXNG (self-hosted) ─────────────────────────────────────────────────

  private async searchSearxng(query: string, maxResults: number, baseUrl: string): Promise<SearchResult[]> {
    await assertSafeRawUrl(baseUrl);

    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Argus/1.0' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned status ${response.status}`);
    }

    const data = await response.json() as SearxngResponse;

    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url,
      snippet: truncate(r.content || '', MAX_SNIPPET_LENGTH),
    }));
  }

  // ─── Formatting ────────────────────────────────────────────────────────────

  private formatResults(query: string, results: SearchResult[]): string {
    const lines = [`Web search results for: "${query}"\n`];

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    URL: ${r.url}`);
      if (r.snippet) {
        lines.push(`    ${r.snippet}`);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}


// ─── Provider response types ─────────────────────────────────────────────────

type TavilyResponse = {
  results?: Array<{
    title?: string;
    url: string;
    content?: string;
  }>;
};

type SearxngResponse = {
  results?: Array<{
    title?: string;
    url: string;
    content?: string;
  }>;
};

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url: string;
      description?: string;
    }>;
  };
};

type JinaSearchResponse = {
  data?: Array<{
    title?: string;
    url: string;
    description?: string;
    content?: string;
  }>;
};
