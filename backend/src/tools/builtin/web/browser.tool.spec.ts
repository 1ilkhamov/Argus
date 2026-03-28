import { Test } from '@nestjs/testing';

import { BrowserTool } from './browser.tool';
import { BrowserSessionService } from './browser-session.service';
import type { BrowserSession } from './browser-session.service';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import { LlmService } from '../../../llm/llm.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPage = {
  url: jest.fn().mockReturnValue('https://example.com'),
  title: jest.fn().mockResolvedValue('Example Page'),
};

const mockSession: BrowserSession = {
  id: 'default',
  context: {} as BrowserSession['context'],
  page: mockPage as unknown as BrowserSession['page'],
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
};

const mockBrowserService = {
  getOrCreateSession: jest.fn().mockResolvedValue(mockSession),
  closeSession: jest.fn().mockResolvedValue(true),
  listSessions: jest.fn().mockReturnValue([]),
  navigate: jest.fn().mockResolvedValue('Navigated to: https://example.com\nStatus: 200\nTitle: Example Page'),
  screenshot: jest.fn().mockResolvedValue({ base64: 'abc123', width: 1280, height: 900 }),
  snapshot: jest.fn().mockResolvedValue('[1] heading: "Welcome"\n  [2] link: "Home"'),
  click: jest.fn().mockResolvedValue('Clicked "button.submit". Current page: https://example.com — Example Page'),
  type: jest.fn().mockResolvedValue('Typed "hello" into "input#name".'),
  press: jest.fn().mockResolvedValue('Pressed key: Enter. Current page: https://example.com'),
  getText: jest.fn().mockResolvedValue('Page text content here.'),
  evaluate: jest.fn().mockResolvedValue('"result"'),
  scroll: jest.fn().mockResolvedValue('Scrolled down by 500px. Position: 500/2000px.'),
  back: jest.fn().mockResolvedValue('Navigated back. Current: https://example.com — Example Page'),
  forward: jest.fn().mockResolvedValue('Navigated forward. Current: https://example.com/next — Next Page'),
  waitForSelector: jest.fn().mockResolvedValue('Element ".loaded" is now visible.'),
  selectOption: jest.fn().mockResolvedValue('Selected "option1" in "select#dropdown".'),
};

const mockLlmService = {
  complete: jest.fn().mockResolvedValue({ content: 'Screenshot shows a search page with a form.' }),
};

const createTool = async (): Promise<BrowserTool> => {
  const module = await Test.createTestingModule({
    providers: [
      BrowserTool,
      { provide: BrowserSessionService, useValue: mockBrowserService },
      { provide: ToolRegistryService, useValue: { register: jest.fn() } },
      { provide: LlmService, useValue: mockLlmService },
    ],
  }).compile();

  return module.get(BrowserTool);
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BrowserTool', () => {
  let tool: BrowserTool;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBrowserService.getOrCreateSession.mockResolvedValue(mockSession);
    mockBrowserService.closeSession.mockResolvedValue(true);
    tool = await createTool();
  });

  // ─── Definition ──────────────────────────────────────────────────────────

  it('should have correct tool definition', () => {
    expect(tool.definition.name).toBe('browser');
    expect(tool.definition.safety).toBe('moderate');
    expect(tool.definition.parameters.required).toEqual(['action']);
  });

  // ─── Navigate ────────────────────────────────────────────────────────────

  it('should navigate to a URL', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'https://example.com' });
    expect(result).toContain('Navigated to');
    expect(mockBrowserService.navigate).toHaveBeenCalledWith(mockSession, 'https://example.com');
  });

  it('should require url for navigate', async () => {
    const result = await tool.execute({ action: 'navigate' });
    expect(result).toContain('"url" is required');
  });

  it('should block navigation to localhost', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'http://localhost:3000' });
    expect(result).toContain('not allowed');
  });

  it('should block navigation to private IPs', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'http://192.168.1.1' });
    expect(result).toContain('not allowed');
  });

  it('should block navigation to metadata endpoint', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'http://169.254.169.254/latest/meta-data' });
    expect(result).toContain('not allowed');
  });

  it('should block non-HTTP URLs', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'file:///etc/passwd' });
    expect(result).toContain('Only HTTP and HTTPS');
  });

  it('should block URLs with credentials', async () => {
    const result = await tool.execute({ action: 'navigate', url: 'http://admin:pass@example.com' });
    expect(result).toContain('credentials');
  });

  // ─── Screenshot ──────────────────────────────────────────────────────────

  it('should take a screenshot', async () => {
    const result = await tool.execute({ action: 'screenshot' });
    expect(result).toContain('Screenshot captured');
    expect(result).toContain('1280x900');
    expect(mockBrowserService.screenshot).toHaveBeenCalledWith(mockSession, false);
  });

  it('should take full page screenshot', async () => {
    await tool.execute({ action: 'screenshot', full_page: true });
    expect(mockBrowserService.screenshot).toHaveBeenCalledWith(mockSession, true);
  });

  it('should analyze screenshot with vision when analyze=true', async () => {
    const result = await tool.execute({ action: 'screenshot', analyze: true });
    expect(result).toContain('Screenshot analysis');
    expect(result).toContain('search page');
    expect(mockLlmService.complete).toHaveBeenCalled();
  });

  // ─── Snapshot ────────────────────────────────────────────────────────────

  it('should return accessibility snapshot', async () => {
    const result = await tool.execute({ action: 'snapshot' });
    expect(result).toContain('heading');
    expect(result).toContain('link');
    expect(result).toContain('example.com');
  });

  // ─── Click ───────────────────────────────────────────────────────────────

  it('should click an element', async () => {
    const result = await tool.execute({ action: 'click', selector: 'button.submit' });
    expect(result).toContain('Clicked');
    expect(mockBrowserService.click).toHaveBeenCalledWith(mockSession, 'button.submit');
  });

  it('should require selector for click', async () => {
    const result = await tool.execute({ action: 'click' });
    expect(result).toContain('"selector" is required');
  });

  // ─── Type ────────────────────────────────────────────────────────────────

  it('should type text into an element', async () => {
    const result = await tool.execute({ action: 'type', selector: 'input#name', text: 'hello' });
    expect(result).toContain('Typed');
    expect(mockBrowserService.type).toHaveBeenCalledWith(mockSession, 'input#name', 'hello');
  });

  it('should require selector and text for type', async () => {
    const r1 = await tool.execute({ action: 'type' });
    expect(r1).toContain('"selector" is required');

    const r2 = await tool.execute({ action: 'type', selector: 'input' });
    expect(r2).toContain('"text" is required');
  });

  // ─── Press ───────────────────────────────────────────────────────────────

  it('should press a key', async () => {
    const result = await tool.execute({ action: 'press', key: 'Enter' });
    expect(result).toContain('Pressed key');
    expect(mockBrowserService.press).toHaveBeenCalledWith(mockSession, 'Enter');
  });

  it('should require key for press', async () => {
    const result = await tool.execute({ action: 'press' });
    expect(result).toContain('"key" is required');
  });

  // ─── Get text ────────────────────────────────────────────────────────────

  it('should get page text', async () => {
    const result = await tool.execute({ action: 'get_text' });
    expect(result).toContain('Page text');
    expect(mockBrowserService.getText).toHaveBeenCalledWith(mockSession, undefined);
  });

  it('should get text from specific selector', async () => {
    await tool.execute({ action: 'get_text', selector: '.content' });
    expect(mockBrowserService.getText).toHaveBeenCalledWith(mockSession, '.content');
  });

  // ─── Scroll ──────────────────────────────────────────────────────────────

  it('should scroll down', async () => {
    const result = await tool.execute({ action: 'scroll', direction: 'down' });
    expect(result).toContain('Scrolled down');
  });

  it('should scroll up', async () => {
    await tool.execute({ action: 'scroll', direction: 'up' });
    expect(mockBrowserService.scroll).toHaveBeenCalledWith(mockSession, 'up');
  });

  // ─── Back / Forward ──────────────────────────────────────────────────────

  it('should navigate back', async () => {
    const result = await tool.execute({ action: 'back' });
    expect(result).toContain('Navigated back');
  });

  it('should navigate forward', async () => {
    const result = await tool.execute({ action: 'forward' });
    expect(result).toContain('Navigated forward');
  });

  // ─── Evaluate ────────────────────────────────────────────────────────────

  it('should evaluate JS expression', async () => {
    const result = await tool.execute({ action: 'evaluate', expression: 'document.title' });
    expect(mockBrowserService.evaluate).toHaveBeenCalledWith(mockSession, 'document.title');
  });

  it('should require expression for evaluate', async () => {
    const result = await tool.execute({ action: 'evaluate' });
    expect(result).toContain('"expression" is required');
  });

  // ─── Select ──────────────────────────────────────────────────────────────

  it('should select an option', async () => {
    const result = await tool.execute({ action: 'select', selector: 'select#lang', text: 'en' });
    expect(mockBrowserService.selectOption).toHaveBeenCalledWith(mockSession, 'select#lang', 'en');
  });

  it('should require selector and text for select', async () => {
    const r1 = await tool.execute({ action: 'select' });
    expect(r1).toContain('"selector" is required');
  });

  // ─── Wait ────────────────────────────────────────────────────────────────

  it('should wait for selector', async () => {
    const result = await tool.execute({ action: 'wait', selector: '.loaded' });
    expect(result).toContain('is now visible');
  });

  it('should require selector for wait', async () => {
    const result = await tool.execute({ action: 'wait' });
    expect(result).toContain('"selector" is required');
  });

  // ─── Sessions ────────────────────────────────────────────────────────────

  it('should list sessions (empty)', async () => {
    const result = await tool.execute({ action: 'sessions' });
    expect(result).toContain('No active');
  });

  it('should list active sessions', async () => {
    mockBrowserService.listSessions.mockReturnValue([
      { id: 'default', createdAt: Date.now() - 5000, lastUsedAt: Date.now() - 1000, url: 'https://example.com' },
    ]);

    const result = await tool.execute({ action: 'sessions' });
    expect(result).toContain('default');
    expect(result).toContain('example.com');
  });

  // ─── Close ───────────────────────────────────────────────────────────────

  it('should close a session', async () => {
    const result = await tool.execute({ action: 'close' });
    expect(result).toContain('closed');
  });

  it('should handle closing non-existent session', async () => {
    mockBrowserService.closeSession.mockResolvedValue(false);

    const result = await tool.execute({ action: 'close', session_id: 'nonexistent' });
    expect(result).toContain('No active session');
  });

  // ─── Unknown action ──────────────────────────────────────────────────────

  it('should reject unknown actions', async () => {
    const result = await tool.execute({ action: 'destroy' });
    expect(result).toContain('Unknown action');
  });

  // ─── Error handling ──────────────────────────────────────────────────────

  it('should handle service errors gracefully', async () => {
    mockBrowserService.getOrCreateSession.mockRejectedValue(new Error('Browser crashed'));

    const result = await tool.execute({ action: 'snapshot' });
    expect(result).toContain('Browser crashed');
  });

  // ─── Session ID ──────────────────────────────────────────────────────────

  it('should pass custom session_id to service', async () => {
    await tool.execute({ action: 'snapshot', session_id: 'my-session' });
    expect(mockBrowserService.getOrCreateSession).toHaveBeenCalledWith('my-session');
  });

  it('should default session_id to "default"', async () => {
    await tool.execute({ action: 'snapshot' });
    expect(mockBrowserService.getOrCreateSession).toHaveBeenCalledWith('default');
  });
});
