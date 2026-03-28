import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { assertSafeRawUrl } from '../../shared/ssrf-guard';
import { analyzeImageWithVision } from '../../shared/vision-analyze';
import { BrowserSessionService } from './browser-session.service';
import { LlmService } from '../../../llm/llm.service';

/** Maximum output length returned to LLM */
const MAX_OUTPUT = 12_000;

// ─── Tool ────────────────────────────────────────────────────────────────────

@Injectable()
export class BrowserTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(BrowserTool.name);

  readonly definition: ToolDefinition = {
    name: 'browser',
    description:
      'Control a headless Chromium browser to interact with web pages. ' +
      'Use this for JS-heavy sites, SPAs, pages requiring login/interaction, or when web_fetch fails to extract content. ' +
      'For simple static pages prefer the lighter web_fetch tool.\n\n' +
      'Actions:\n' +
      '- navigate: Go to a URL\n' +
      '- screenshot: Capture the current page (optionally analyze with vision)\n' +
      '- snapshot: Get accessibility tree of the page (roles, names, refs for click/type)\n' +
      '- click: Click an element by CSS selector\n' +
      '- type: Type text into an input element\n' +
      '- press: Press a keyboard key (Enter, Tab, Escape, etc.)\n' +
      '- get_text: Extract text content from the page or a specific element\n' +
      '- scroll: Scroll up or down\n' +
      '- back / forward: Navigate browser history\n' +
      '- evaluate: Run JavaScript expression on the page\n' +
      '- select: Select an option from a dropdown\n' +
      '- wait: Wait for an element to appear\n' +
      '- sessions: List active browser sessions\n' +
      '- close: Close a browser session\n\n' +
      'Typical workflow: navigate → snapshot → click/type → get_text or screenshot.\n' +
      'Use snapshot to see interactive elements with ref IDs, then use CSS selectors to interact.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform.',
          enum: [
            'navigate', 'screenshot', 'snapshot', 'click', 'type', 'press',
            'get_text', 'scroll', 'back', 'forward', 'evaluate', 'select',
            'wait', 'sessions', 'close',
          ],
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for "navigate" action).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the target element (for click, type, get_text, select, wait).',
        },
        text: {
          type: 'string',
          description: 'Text to type (for "type" action) or value to select (for "select").',
        },
        key: {
          type: 'string',
          description: 'Key to press (for "press" action). Examples: Enter, Tab, Escape, ArrowDown.',
        },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate (for "evaluate" action).',
        },
        direction: {
          type: 'string',
          description: 'Scroll direction: "up" or "down" (for "scroll" action).',
          enum: ['up', 'down'],
        },
        full_page: {
          type: 'boolean',
          description: 'Capture full page screenshot (default: viewport only).',
        },
        analyze: {
          type: 'boolean',
          description: 'If true, analyze the screenshot with vision AI (for "screenshot" action).',
        },
        question: {
          type: 'string',
          description: 'Question about the screenshot (for "screenshot" + analyze).',
        },
        session_id: {
          type: 'string',
          description: 'Browser session ID (default: "default"). Use to manage multiple tabs/sessions.',
        },
      },
      required: ['action'],
    },
    safety: 'moderate',
    timeoutMs: 60_000,
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly browserService: BrowserSessionService,
    private readonly llmService: LlmService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('browser tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();
    const sessionId = String(args.session_id ?? 'default').trim();

    try {
      switch (action) {
        case 'navigate':
          return await this.handleNavigate(sessionId, args);
        case 'screenshot':
          return await this.handleScreenshot(sessionId, args);
        case 'snapshot':
          return await this.handleSnapshot(sessionId);
        case 'click':
          return await this.handleClick(sessionId, args);
        case 'type':
          return await this.handleType(sessionId, args);
        case 'press':
          return await this.handlePress(sessionId, args);
        case 'get_text':
          return await this.handleGetText(sessionId, args);
        case 'scroll':
          return await this.handleScroll(sessionId, args);
        case 'back':
          return await this.handleBack(sessionId);
        case 'forward':
          return await this.handleForward(sessionId);
        case 'evaluate':
          return await this.handleEvaluate(sessionId, args);
        case 'select':
          return await this.handleSelect(sessionId, args);
        case 'wait':
          return await this.handleWait(sessionId, args);
        case 'sessions':
          return this.handleListSessions();
        case 'close':
          return await this.handleClose(sessionId);
        default:
          return `Error: Unknown action "${action}". Valid actions: navigate, screenshot, snapshot, click, type, press, get_text, scroll, back, forward, evaluate, select, wait, sessions, close.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`browser ${action} failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  // ─── Action handlers ────────────────────────────────────────────────────────

  private async handleNavigate(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '').trim();
    if (!url) return 'Error: "url" is required for navigate action.';

    // SSRF validation
    await assertSafeRawUrl(url);

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.navigate(session, url);
  }

  private async handleScreenshot(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const session = await this.browserService.getOrCreateSession(sessionId);
    const fullPage = Boolean(args.full_page);
    const analyze = Boolean(args.analyze);

    const result = await this.browserService.screenshot(session, fullPage);

    if (!analyze) {
      return `Screenshot captured (${result.width}x${result.height}). Page: ${session.page.url()}\n\n[Screenshot data available as base64 PNG, ${Math.round(result.base64.length * 0.75 / 1024)}KB]`;
    }

    // Analyze with vision
    const question = String(args.question ?? 'Describe what you see on this web page in detail.').trim();
    const analysis = await this.analyzeScreenshot(result.base64, question);
    return `Screenshot analysis (${session.page.url()}):\n\n${analysis}`;
  }

  private async handleSnapshot(sessionId: string): Promise<string> {
    const session = await this.browserService.getOrCreateSession(sessionId);
    const url = session.page.url();
    const title = await session.page.title();

    const tree = await this.browserService.snapshot(session);
    return `Page: ${url}\nTitle: ${title}\n\n${tree}`;
  }

  private async handleClick(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const selector = String(args.selector ?? '').trim();
    if (!selector) return 'Error: "selector" is required for click action.';

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.click(session, selector);
  }

  private async handleType(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const selector = String(args.selector ?? '').trim();
    const text = String(args.text ?? '');
    if (!selector) return 'Error: "selector" is required for type action.';
    if (!text) return 'Error: "text" is required for type action.';

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.type(session, selector, text);
  }

  private async handlePress(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const key = String(args.key ?? '').trim();
    if (!key) return 'Error: "key" is required for press action. Examples: Enter, Tab, Escape.';

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.press(session, key);
  }

  private async handleGetText(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const selector = args.selector ? String(args.selector).trim() : undefined;
    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.getText(session, selector);
  }

  private async handleScroll(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const direction = String(args.direction ?? 'down') as 'up' | 'down';
    if (direction !== 'up' && direction !== 'down') {
      return 'Error: direction must be "up" or "down".';
    }

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.scroll(session, direction);
  }

  private async handleBack(sessionId: string): Promise<string> {
    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.back(session);
  }

  private async handleForward(sessionId: string): Promise<string> {
    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.forward(session);
  }

  private async handleEvaluate(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const expression = String(args.expression ?? '').trim();
    if (!expression) return 'Error: "expression" is required for evaluate action.';

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.evaluate(session, expression);
  }

  private async handleSelect(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const selector = String(args.selector ?? '').trim();
    const text = String(args.text ?? '').trim();
    if (!selector) return 'Error: "selector" is required for select action.';
    if (!text) return 'Error: "text" (value) is required for select action.';

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.selectOption(session, selector, text);
  }

  private async handleWait(sessionId: string, args: Record<string, unknown>): Promise<string> {
    const selector = String(args.selector ?? '').trim();
    if (!selector) return 'Error: "selector" is required for wait action.';

    const session = await this.browserService.getOrCreateSession(sessionId);
    return this.browserService.waitForSelector(session, selector);
  }

  private handleListSessions(): string {
    const sessions = this.browserService.listSessions();
    if (sessions.length === 0) return 'No active browser sessions.';

    const lines = [`Active browser sessions (${sessions.length}):\n`];
    for (const s of sessions) {
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      const idle = Math.round((Date.now() - s.lastUsedAt) / 1000);
      lines.push(`- [${s.id}] ${s.url} (age: ${age}s, idle: ${idle}s)`);
    }
    return lines.join('\n');
  }

  private async handleClose(sessionId: string): Promise<string> {
    const closed = await this.browserService.closeSession(sessionId);
    return closed
      ? `Browser session "${sessionId}" closed.`
      : `No active session with id "${sessionId}".`;
  }

  // ─── Vision analysis ────────────────────────────────────────────────────────

  private async analyzeScreenshot(base64: string, question: string): Promise<string> {
    return analyzeImageWithVision(this.llmService, base64, 'image/png', question);
  }
}
