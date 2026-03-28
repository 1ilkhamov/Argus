import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BrowserSession {
  id: string;
  context: import('playwright').BrowserContext;
  page: import('playwright').Page;
  createdAt: number;
  lastUsedAt: number;
}

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
}

export interface SnapshotNode {
  role: string;
  name: string;
  ref: number;
  value?: string;
  focused?: boolean;
  checked?: boolean;
  disabled?: boolean;
  children?: SnapshotNode[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SESSIONS = 3;
const CLEANUP_INTERVAL_MS = 60_000; // check every minute
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class BrowserSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserSessionService.name);
  private browser: import('playwright').Browser | null = null;
  private readonly sessions = new Map<string, BrowserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sessionTimeoutMs: number;
  private refCounter = 0;

  constructor(private readonly configService: ConfigService) {
    this.sessionTimeoutMs = this.configService.get<number>(
      'tools.browser.sessionTimeoutMs',
      DEFAULT_SESSION_TIMEOUT_MS,
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  private async ensureBrowser(): Promise<import('playwright').Browser> {
    if (this.browser?.isConnected()) return this.browser;

    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--no-first-run',
      ],
    });

    this.logger.log('Chromium browser launched (headless)');

    // Start cleanup timer
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS);
    }

    return this.browser;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.logger.log('Browser closed');
    }
  }

  // ─── Session management ─────────────────────────────────────────────────────

  async getOrCreateSession(sessionId?: string): Promise<BrowserSession> {
    const id = sessionId || 'default';

    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      // Close oldest session
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      )[0];
      if (oldest) {
        await this.closeSession(oldest[0]);
      }
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'UTC',
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
    });

    // Block known tracking/ad domains
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (this.isBlockedResource(url)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);

    const session: BrowserSession = {
      id,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    this.sessions.set(id, session);
    this.logger.log(`Browser session "${id}" created`);
    return session;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    await session.context.close().catch(() => {});
    this.logger.log(`Browser session "${sessionId}" closed`);
    return true;
  }

  listSessions(): Array<{ id: string; createdAt: number; lastUsedAt: number; url: string }> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      url: s.page.url(),
    }));
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async navigate(session: BrowserSession, url: string): Promise<string> {
    const response = await session.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    session.lastUsedAt = Date.now();

    const status = response?.status() ?? 0;
    const title = await session.page.title();
    const finalUrl = session.page.url();

    return `Navigated to: ${finalUrl}\nStatus: ${status}\nTitle: ${title}`;
  }

  // ─── Screenshot ─────────────────────────────────────────────────────────────

  async screenshot(session: BrowserSession, fullPage = false): Promise<ScreenshotResult> {
    const buffer = await session.page.screenshot({
      fullPage,
      type: 'png',
    });

    session.lastUsedAt = Date.now();

    const viewport = session.page.viewportSize() ?? DEFAULT_VIEWPORT;
    return {
      base64: buffer.toString('base64'),
      width: viewport.width,
      height: viewport.height,
    };
  }

  // ─── Accessibility snapshot ─────────────────────────────────────────────────

  async snapshot(session: BrowserSession): Promise<string> {
    session.lastUsedAt = Date.now();

    // Build accessibility-like tree from DOM using ARIA roles and semantic elements
    const tree = await session.page.evaluate(() => {
      let counter = 0;

      const ROLE_MAP: Record<string, string> = {
        A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox',
        SELECT: 'combobox', IMG: 'img', H1: 'heading', H2: 'heading',
        H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
        NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
        FORM: 'form', TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem',
        ARTICLE: 'article', SECTION: 'region', ASIDE: 'complementary',
      };

      const INPUT_ROLE_MAP: Record<string, string> = {
        checkbox: 'checkbox', radio: 'radio', submit: 'button',
        button: 'button', search: 'searchbox', email: 'textbox',
        password: 'textbox', number: 'spinbutton', range: 'slider',
      };

      interface SnapNode {
        ref: number; role: string; name: string;
        value?: string; focused?: boolean; checked?: boolean;
        disabled?: boolean; children?: SnapNode[];
      }

      function getRole(el: Element): string {
        const ariaRole = el.getAttribute('role');
        if (ariaRole) return ariaRole;
        if (el.tagName === 'INPUT') {
          const t = (el as HTMLInputElement).type || 'text';
          return INPUT_ROLE_MAP[t] || 'textbox';
        }
        return ROLE_MAP[el.tagName] || '';
      }

      function getName(el: Element): string {
        return (
          el.getAttribute('aria-label') ||
          el.getAttribute('alt') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          (el.tagName === 'A' ? (el as HTMLAnchorElement).textContent?.trim().slice(0, 80) : '') ||
          (el.tagName === 'BUTTON' ? (el as HTMLButtonElement).textContent?.trim().slice(0, 80) : '') ||
          (/^H[1-6]$/.test(el.tagName) ? el.textContent?.trim().slice(0, 120) : '') ||
          (el.tagName === 'IMG' ? (el as HTMLImageElement).src.split('/').pop()?.slice(0, 60) : '') ||
          (el.tagName === 'LABEL' ? el.textContent?.trim().slice(0, 80) : '') ||
          ''
        );
      }

      function walk(el: Element): SnapNode | null {
        const role = getRole(el);
        const name = getName(el);
        const children: SnapNode[] = [];

        for (const child of el.children) {
          const node = walk(child);
          if (node) children.push(node);
        }

        // Skip nodes with no role and no interesting children
        if (!role && children.length === 0) return null;
        // Skip generic containers with only one child (flatten)
        if (!role && children.length === 1) return children[0]!;

        const node: SnapNode = { ref: ++counter, role: role || 'group', name };

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          node.value = (el as HTMLInputElement).value;
        }
        if (document.activeElement === el) node.focused = true;
        if ((el as HTMLInputElement).checked !== undefined && el.tagName === 'INPUT') {
          node.checked = (el as HTMLInputElement).checked;
        }
        if ((el as HTMLButtonElement).disabled) node.disabled = true;

        if (children.length > 0) node.children = children;
        return node;
      }

      return walk(document.body);
    });

    if (!tree) return 'Page has no accessible content.';

    const lines: string[] = [];
    this.formatSnapshotNode(tree as SnapshotNode, lines, 0);

    const output = lines.join('\n');
    return output.length > 15_000
      ? output.slice(0, 15_000) + '\n... (snapshot truncated)'
      : output;
  }

  private formatSnapshotNode(node: SnapshotNode, lines: string[], depth: number): void {
    const indent = '  '.repeat(depth);
    let line = `${indent}[${node.ref}] ${node.role}`;
    if (node.name) line += `: "${node.name}"`;
    if (node.value !== undefined) line += ` = "${node.value}"`;
    if (node.focused) line += ' (focused)';
    if (node.checked !== undefined) line += ` [${node.checked ? 'checked' : 'unchecked'}]`;
    if (node.disabled) line += ' (disabled)';

    lines.push(line);

    if (node.children) {
      for (const child of node.children) {
        this.formatSnapshotNode(child, lines, depth + 1);
      }
    }
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  async click(session: BrowserSession, selector: string): Promise<string> {
    await session.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    session.lastUsedAt = Date.now();

    // Wait briefly for any navigation/reaction
    await session.page.waitForLoadState('domcontentloaded').catch(() => {});
    const title = await session.page.title();
    return `Clicked "${selector}". Current page: ${session.page.url()} — ${title}`;
  }

  async type(session: BrowserSession, selector: string, text: string): Promise<string> {
    await session.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    session.lastUsedAt = Date.now();
    return `Typed "${text.length > 50 ? text.slice(0, 50) + '…' : text}" into "${selector}".`;
  }

  async press(session: BrowserSession, key: string): Promise<string> {
    await session.page.keyboard.press(key);
    session.lastUsedAt = Date.now();
    await session.page.waitForLoadState('domcontentloaded').catch(() => {});
    return `Pressed key: ${key}. Current page: ${session.page.url()}`;
  }

  async getText(session: BrowserSession, selector?: string): Promise<string> {
    let text: string;

    if (selector) {
      text = await session.page.textContent(selector, { timeout: ACTION_TIMEOUT_MS }) ?? '';
    } else {
      text = await session.page.evaluate(() => document.body.innerText);
    }

    session.lastUsedAt = Date.now();

    if (!text.trim()) return 'No text content found.';
    return text.length > 12_000
      ? text.slice(0, 12_000) + `\n\n... (truncated, ${text.length} total chars)`
      : text;
  }

  async evaluate(session: BrowserSession, expression: string): Promise<string> {
    // Security: limit expression length
    if (expression.length > 5000) {
      throw new Error('Expression too long (max 5000 chars).');
    }

    const result = await session.page.evaluate((expr) => {
      try {
        // eslint-disable-next-line no-eval
        const r = eval(expr);
        return JSON.stringify(r, null, 2) ?? 'undefined';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }, expression);

    session.lastUsedAt = Date.now();

    const output = String(result);
    return output.length > 8000
      ? output.slice(0, 8000) + `\n... (truncated, ${output.length} total chars)`
      : output;
  }

  async scroll(session: BrowserSession, direction: 'up' | 'down', amount = 500): Promise<string> {
    const delta = direction === 'down' ? amount : -amount;
    await session.page.evaluate((d) => window.scrollBy(0, d), delta);
    session.lastUsedAt = Date.now();

    const scrollY = await session.page.evaluate(() => Math.round(window.scrollY));
    const scrollHeight = await session.page.evaluate(() => document.documentElement.scrollHeight);
    return `Scrolled ${direction} by ${amount}px. Position: ${scrollY}/${scrollHeight}px.`;
  }

  async back(session: BrowserSession): Promise<string> {
    await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    session.lastUsedAt = Date.now();
    return `Navigated back. Current: ${session.page.url()} — ${await session.page.title()}`;
  }

  async forward(session: BrowserSession): Promise<string> {
    await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    session.lastUsedAt = Date.now();
    return `Navigated forward. Current: ${session.page.url()} — ${await session.page.title()}`;
  }

  async waitForSelector(session: BrowserSession, selector: string, timeoutMs = 5000): Promise<string> {
    await session.page.waitForSelector(selector, { timeout: timeoutMs });
    session.lastUsedAt = Date.now();
    return `Element "${selector}" is now visible.`;
  }

  async selectOption(session: BrowserSession, selector: string, value: string): Promise<string> {
    const selected = await session.page.selectOption(selector, value, { timeout: ACTION_TIMEOUT_MS });
    session.lastUsedAt = Date.now();
    return `Selected "${selected.join(', ')}" in "${selector}".`;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt > this.sessionTimeoutMs) {
        this.closeSession(id).catch(() => {});
        this.logger.log(`Session "${id}" expired (inactive ${Math.round((now - session.lastUsedAt) / 1000)}s)`);
      }
    }

    // If no sessions remain, close the browser to free memory
    if (this.sessions.size === 0 && this.browser) {
      this.browser.close().catch(() => {});
      this.browser = null;
      this.logger.log('Browser closed (no active sessions)');
    }
  }

  // ─── Resource blocking ──────────────────────────────────────────────────────

  private isBlockedResource(url: string): boolean {
    const blocked = [
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'facebook.net/tr', 'analytics.google.com', 'google-analytics.com',
      'hotjar.com', 'mixpanel.com', 'segment.io',
    ];
    return blocked.some((domain) => url.includes(domain));
  }
}
