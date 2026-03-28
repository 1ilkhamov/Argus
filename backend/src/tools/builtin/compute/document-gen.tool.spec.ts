import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { DocumentGenTool } from './document-gen.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

// ─── Mock fs ──────────────────────────────────────────────────────────────────

const mockWriteFile = jest.fn();
const mockMkdir = jest.fn();
const mockStat = jest.fn();
const mockRealpath = jest.fn();

jest.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  realpath: (...args: unknown[]) => mockRealpath(...args),
}));

jest.mock('node:fs', () => ({
  existsSync: () => true,
}));

// ─── Mock Playwright ──────────────────────────────────────────────────────────

const mockPdf = jest.fn();
const mockSetContent = jest.fn();
const mockNewPage = jest.fn();
const mockNewContext = jest.fn();
const mockBrowserClose = jest.fn();
const mockLaunch = jest.fn();

jest.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE = '/Users/test/workspace';

const createTool = async (overrides?: {
  enabled?: boolean;
}): Promise<DocumentGenTool> => {
  const module = await Test.createTestingModule({
    providers: [
      DocumentGenTool,
      {
        provide: ToolRegistryService,
        useValue: { register: jest.fn() },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => {
            if (key === 'tools.systemRun.workingDirectory') return WORKSPACE;
            if (key === 'tools.fileOps.allowedRoots') return [];
            if (key === 'tools.documentGen.enabled') return overrides?.enabled ?? true;
            if (key === 'tools.documentGen.outputDir') return `${WORKSPACE}/data/documents`;
            return undefined;
          }),
        },
      },
    ],
  }).compile();

  return module.get(DocumentGenTool);
};

const setupPlaywrightMock = () => {
  mockPdf.mockResolvedValue(undefined);
  mockSetContent.mockResolvedValue(undefined);
  mockNewPage.mockResolvedValue({
    setContent: mockSetContent,
    pdf: mockPdf,
  });
  mockNewContext.mockResolvedValue({
    newPage: mockNewPage,
  });
  mockBrowserClose.mockResolvedValue(undefined);
  mockLaunch.mockResolvedValue({
    newContext: mockNewContext,
    close: mockBrowserClose,
  });
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentGenTool', () => {
  let tool: DocumentGenTool;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 12345 });
    mockRealpath.mockImplementation(async (p: string) => p);
    setupPlaywrightMock();
    tool = await createTool();
  });

  // ─── Registration ──────────────────────────────────────────────────────

  it('should have correct tool definition', () => {
    expect(tool.definition.name).toBe('document_gen');
    expect(tool.definition.safety).toBe('moderate');
    expect(tool.definition.parameters.required).toEqual(['content', 'output_path']);
  });

  // ─── HTML generation ───────────────────────────────────────────────────

  it('should generate an HTML document', async () => {
    const result = await tool.execute({
      content: '# Hello World\n\nThis is a test.',
      output_path: `${WORKSPACE}/output/doc.html`,
      title: 'Test Document',
    });

    expect(result).toContain('HTML document generated successfully');
    expect(result).toContain('doc.html');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // Check HTML content
    const writtenHtml = mockWriteFile.mock.calls[0]![1] as string;
    expect(writtenHtml).toContain('<!DOCTYPE html>');
    expect(writtenHtml).toContain('<title>Test Document</title>');
    expect(writtenHtml).toContain('<h1>Hello World</h1>');
    expect(writtenHtml).toContain('This is a test.');
  });

  it('should convert markdown headings to HTML', async () => {
    await tool.execute({
      content: '# H1\n## H2\n### H3\n#### H4',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<h1>H1</h1>');
    expect(html).toContain('<h2>H2</h2>');
    expect(html).toContain('<h3>H3</h3>');
    expect(html).toContain('<h4>H4</h4>');
  });

  it('should convert bold and italic', async () => {
    await tool.execute({
      content: 'This is **bold** and *italic* and ***both***.',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<strong><em>both</em></strong>');
  });

  it('should convert code blocks', async () => {
    await tool.execute({
      content: '```javascript\nconst x = 1;\n```',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('should convert inline code', async () => {
    await tool.execute({
      content: 'Use `console.log()` to debug.',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<code>console.log()</code>');
  });

  it('should convert unordered lists', async () => {
    await tool.execute({
      content: '- Item 1\n- Item 2\n- Item 3',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Item 1</li>');
    expect(html).toContain('<li>Item 2</li>');
    expect(html).toContain('<li>Item 3</li>');
    expect(html).toContain('</ul>');
  });

  it('should convert ordered lists', async () => {
    await tool.execute({
      content: '1. First\n2. Second\n3. Third',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('</ol>');
  });

  it('should convert blockquotes', async () => {
    await tool.execute({
      content: '> This is a quote.',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<blockquote>');
    expect(html).toContain('This is a quote.');
  });

  it('should convert horizontal rules', async () => {
    await tool.execute({
      content: 'Above\n\n---\n\nBelow',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<hr>');
  });

  it('should convert links', async () => {
    await tool.execute({
      content: 'Visit [Google](https://google.com) today.',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<a href="https://google.com">Google</a>');
  });

  it('should convert tables', async () => {
    await tool.execute({
      content: '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Age</th>');
    expect(html).toContain('<td>Alice</td>');
    expect(html).toContain('<td>30</td>');
  });

  it('should escape HTML in content', async () => {
    await tool.execute({
      content: 'Use <script>alert("xss")</script> carefully.',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  // ─── PDF generation ────────────────────────────────────────────────────

  it('should generate a PDF document via Playwright', async () => {
    const result = await tool.execute({
      content: '# Report\n\nImportant data here.',
      output_path: `${WORKSPACE}/output/report.pdf`,
      title: 'Monthly Report',
    });

    expect(result).toContain('PDF document generated successfully');
    expect(result).toContain('report.pdf');
    expect(mockLaunch).toHaveBeenCalledWith({ headless: true });
    expect(mockSetContent).toHaveBeenCalledTimes(1);
    expect(mockPdf).toHaveBeenCalledTimes(1);
    expect(mockBrowserClose).toHaveBeenCalledTimes(1);

    // Verify PDF options
    const pdfOpts = mockPdf.mock.calls[0]![0] as Record<string, unknown>;
    expect(pdfOpts.format).toBe('A4');
    expect(pdfOpts.landscape).toBe(false);
    expect(pdfOpts.printBackground).toBe(true);
  });

  it('should pass landscape and page size options to PDF', async () => {
    await tool.execute({
      content: '# Wide Report',
      output_path: `${WORKSPACE}/wide.pdf`,
      page_size: 'Letter',
      landscape: true,
    });

    const pdfOpts = mockPdf.mock.calls[0]![0] as Record<string, unknown>;
    expect(pdfOpts.format).toBe('Letter');
    expect(pdfOpts.landscape).toBe(true);
  });

  it('should close browser even on error', async () => {
    mockPdf.mockRejectedValue(new Error('PDF generation failed'));

    const result = await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/fail.pdf`,
    });

    expect(result).toContain('PDF generation failed');
    expect(mockBrowserClose).toHaveBeenCalled();
  });

  // ─── Validation errors ─────────────────────────────────────────────────

  it('should require content parameter', async () => {
    const result = await tool.execute({ output_path: `${WORKSPACE}/doc.pdf` });
    expect(result).toContain('"content" is required');
  });

  it('should require output_path parameter', async () => {
    const result = await tool.execute({ content: '# Hello' });
    expect(result).toContain('"output_path" is required');
  });

  it('should reject empty content', async () => {
    const result = await tool.execute({ content: '', output_path: `${WORKSPACE}/doc.pdf` });
    expect(result).toContain('"content" is required');
  });

  it('should reject overly long content', async () => {
    const result = await tool.execute({
      content: 'x'.repeat(100_001),
      output_path: `${WORKSPACE}/doc.pdf`,
    });

    expect(result).toContain('too long');
  });

  it('should reject unsupported formats', async () => {
    const result = await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/doc.docx`,
    });

    expect(result).toContain('Unsupported format');
    expect(result).toContain('.docx');
  });

  it('should reject .txt format', async () => {
    const result = await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/doc.txt`,
    });

    expect(result).toContain('Unsupported format');
  });

  // ─── Security: path validation ─────────────────────────────────────────

  it('should block paths outside allowed roots', async () => {
    const result = await tool.execute({
      content: '# Test',
      output_path: '/etc/evil/doc.pdf',
    });

    expect(result).toContain('outside allowed');
  });

  it('should block sensitive paths (.ssh)', async () => {
    const result = await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/.ssh/doc.pdf`,
    });

    expect(result).toContain('Access denied');
  });

  it('should block .gnupg paths', async () => {
    const result = await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/.gnupg/doc.pdf`,
    });

    expect(result).toContain('Access denied');
  });

  // ─── Relative paths ────────────────────────────────────────────────────

  it('should resolve relative paths from workspace', async () => {
    await tool.execute({
      content: '# Hello',
      output_path: 'reports/summary.html',
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(`${WORKSPACE}/reports/summary.html`),
      expect.any(String),
      'utf-8',
    );
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  it('should create output directory if it does not exist', async () => {
    await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/new-dir/deep/doc.html`,
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('new-dir/deep'),
      { recursive: true },
    );
  });

  it('should use default title if not provided', async () => {
    await tool.execute({
      content: '# Test',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<title>Document</title>');
  });

  it('should handle strikethrough text', async () => {
    await tool.execute({
      content: 'This is ~~deleted~~ text.',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<del>deleted</del>');
  });

  it('should include professional CSS styling', async () => {
    await tool.execute({
      content: '# Styled',
      output_path: `${WORKSPACE}/doc.html`,
    });

    const html = mockWriteFile.mock.calls[0]![1] as string;
    expect(html).toContain('<style>');
    expect(html).toContain('font-family');
    expect(html).toContain('line-height');
  });
});
