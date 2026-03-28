import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { PdfReadTool } from './pdf-read.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

// ─── Mock pdf-parse v2 ───────────────────────────────────────────────────────

let mockGetText = jest.fn();
let mockGetInfo = jest.fn();
let mockLoad = jest.fn();

jest.mock('pdf-parse', () => ({
  PDFParse: class {
    load() { return mockLoad(); }
    getText() { return mockGetText(); }
    getInfo() { return mockGetInfo(); }
  },
}));

// ─── Mock fs ─────────────────────────────────────────────────────────────────

const mockStat = jest.fn();
const mockReadFile = jest.fn();
const mockRealpath = jest.fn();

jest.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  realpath: (...args: unknown[]) => mockRealpath(...args),
}));

jest.mock('node:fs', () => ({
  existsSync: () => true,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const WORKSPACE = '/Users/test/workspace';

const makeTextResult = (overrides: Partial<{
  pages: Array<{ text: string; num: number }>;
  text: string;
  total: number;
}> = {}) => ({
  pages: overrides.pages ?? [
    { text: 'Page 1 content', num: 1 },
    { text: 'Page 2 content', num: 2 },
    { text: 'Page 3 content', num: 3 },
  ],
  text: overrides.text ?? 'Page 1 content\n\n-- 1 of 3 --\n\nPage 2 content\n\n-- 2 of 3 --\n\nPage 3 content\n\n-- 3 of 3 --\n\n',
  total: overrides.total ?? 3,
});

const makeInfoResult = (overrides: Partial<{
  info: Record<string, string>;
  total: number;
}> = {}) => ({
  total: overrides.total ?? 3,
  info: overrides.info ?? { Title: 'Test PDF', Author: 'Test Author', PDFFormatVersion: '1.4' },
  metadata: null,
});

const setupMockPdf = (textOverrides?: Parameters<typeof makeTextResult>[0], infoOverrides?: Parameters<typeof makeInfoResult>[0]) => {
  mockLoad.mockResolvedValue(undefined);
  mockGetText.mockResolvedValue(makeTextResult(textOverrides));
  mockGetInfo.mockResolvedValue(makeInfoResult(infoOverrides));
};

const makeStatResult = (size = 1024, isDir = false) => ({
  size,
  isDirectory: () => isDir,
});

const createTool = async (): Promise<PdfReadTool> => {
  const module = await Test.createTestingModule({
    providers: [
      PdfReadTool,
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
            return undefined;
          }),
        },
      },
    ],
  }).compile();

  return module.get(PdfReadTool);
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PdfReadTool', () => {
  let tool: PdfReadTool;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLoad = jest.fn();
    mockGetText = jest.fn();
    mockGetInfo = jest.fn();
    mockRealpath.mockImplementation(async (p: string) => p);
    mockStat.mockResolvedValue(makeStatResult());
    mockReadFile.mockResolvedValue(Buffer.from('fake-pdf-data'));
    setupMockPdf();
    tool = await createTool();
  });

  // ─── Registration ────────────────────────────────────────────────────────

  it('should have correct tool definition', () => {
    expect(tool.definition.name).toBe('pdf_read');
    expect(tool.definition.safety).toBe('safe');
    expect(tool.definition.parameters.required).toEqual(['path']);
  });

  // ─── Basic extraction ────────────────────────────────────────────────────

  it('should extract text from a PDF', async () => {
    const result = await tool.execute({ path: `${WORKSPACE}/doc.pdf` });

    expect(result).toContain('doc.pdf');
    expect(result).toContain('Pages: 3');
    expect(result).toContain('Page 1 content');
    expect(result).toContain('Page 2 content');
    expect(result).toContain('Page 3 content');
  });

  it('should include metadata in output', async () => {
    const result = await tool.execute({ path: `${WORKSPACE}/doc.pdf` });

    expect(result).toContain('Title: Test PDF');
    expect(result).toContain('Author: Test Author');
  });

  // ─── Metadata only ───────────────────────────────────────────────────────

  it('should return only metadata when metadata_only=true', async () => {
    const result = await tool.execute({
      path: `${WORKSPACE}/doc.pdf`,
      metadata_only: true,
    });

    expect(result).toContain('Pages: 3');
    expect(result).toContain('Title: Test PDF');
    expect(result).not.toContain('Page 1 content');
    expect(result).not.toContain('── Page');
  });

  // ─── Page range ──────────────────────────────────────────────────────────

  it('should extract specific page range', async () => {
    const result = await tool.execute({
      path: `${WORKSPACE}/doc.pdf`,
      page_start: 2,
      page_end: 2,
    });

    expect(result).toContain('Page 2 content');
    expect(result).toContain('pages 2-2');
    expect(result).not.toContain('Page 1 content');
    expect(result).not.toContain('Page 3 content');
  });

  it('should handle page_start beyond total pages', async () => {
    const result = await tool.execute({
      path: `${WORKSPACE}/doc.pdf`,
      page_start: 50,
    });

    expect(result).toContain('exceeds total pages');
  });

  // ─── Validation errors ───────────────────────────────────────────────────

  it('should require path parameter', async () => {
    const result = await tool.execute({});
    expect(result).toContain('"path" is required');
  });

  it('should reject empty path', async () => {
    const result = await tool.execute({ path: '' });
    expect(result).toContain('"path" is required');
  });

  it('should reject directories', async () => {
    mockStat.mockResolvedValue(makeStatResult(0, true));

    const result = await tool.execute({ path: `${WORKSPACE}/some-dir` });
    expect(result).toContain('directory');
  });

  it('should reject non-PDF files', async () => {
    const result = await tool.execute({ path: `${WORKSPACE}/readme.txt` });
    expect(result).toContain('.pdf extension');
  });

  it('should reject files that are too large', async () => {
    mockStat.mockResolvedValue(makeStatResult(25 * 1024 * 1024)); // 25 MB

    const result = await tool.execute({ path: `${WORKSPACE}/huge.pdf` });
    expect(result).toContain('too large');
  });

  it('should reject empty files', async () => {
    mockStat.mockResolvedValue(makeStatResult(0));

    const result = await tool.execute({ path: `${WORKSPACE}/empty.pdf` });
    expect(result).toContain('empty');
  });

  // ─── Security: path validation ───────────────────────────────────────────

  it('should block paths outside allowed roots', async () => {
    const result = await tool.execute({ path: '/etc/secrets/doc.pdf' });
    expect(result).toContain('outside allowed');
  });

  it('should block sensitive paths (.ssh)', async () => {
    const result = await tool.execute({ path: `${WORKSPACE}/.ssh/key.pdf` });
    expect(result).toContain('Access denied');
  });

  it('should block .env files', async () => {
    const result = await tool.execute({ path: `${WORKSPACE}/.env.local` });
    expect(result).toContain('blocked pattern');
  });

  it('should block symlinks pointing outside allowed roots', async () => {
    mockRealpath.mockResolvedValue('/etc/shadow');

    const result = await tool.execute({ path: `${WORKSPACE}/link.pdf` });
    expect(result).toContain('symlink');
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it('should handle PDF with no extractable text', async () => {
    setupMockPdf({ text: '   ', pages: [], total: 1 }, { total: 1 });

    const result = await tool.execute({ path: `${WORKSPACE}/scanned.pdf` });
    expect(result).toContain('No extractable text');
    expect(result).toContain('images/scans');
  });

  it('should handle PDF with no per-page data (fallback splitting)', async () => {
    setupMockPdf({
      pages: [],
      text: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\nLine 12',
      total: 2,
    }, { total: 2 });

    const result = await tool.execute({ path: `${WORKSPACE}/noff.pdf` });
    expect(result).toContain('Line 1');
    expect(result).toContain('Page 1');
  });

  it('should handle pdf-parse load errors gracefully', async () => {
    mockLoad.mockRejectedValue(new Error('Invalid PDF structure'));

    const result = await tool.execute({ path: `${WORKSPACE}/corrupt.pdf` });
    expect(result).toContain('valid PDF');
  });

  it('should handle generic errors gracefully', async () => {
    mockLoad.mockRejectedValue(new Error('Something went wrong'));

    const result = await tool.execute({ path: `${WORKSPACE}/bad.pdf` });
    expect(result).toContain('Something went wrong');
  });

  it('should format PDF dates correctly', async () => {
    setupMockPdf(undefined, {
      info: {
        Title: 'Dated',
        CreationDate: 'D:20250115143022',
      },
    });

    const result = await tool.execute({
      path: `${WORKSPACE}/dated.pdf`,
      metadata_only: true,
    });

    expect(result).toContain('2025-01-15 14:30:22');
  });

  it('should truncate very long output', async () => {
    const longText = 'x'.repeat(20_000);
    setupMockPdf({ text: longText, pages: [{ text: longText, num: 1 }], total: 1 }, { total: 1 });

    const result = await tool.execute({ path: `${WORKSPACE}/long.pdf` });
    expect(result.length).toBeLessThanOrEqual(15_100); // MAX_OUTPUT_LENGTH + some slack
    expect(result).toContain('truncated');
  });

  // ─── Relative paths ──────────────────────────────────────────────────────

  it('should resolve relative paths from workspace', async () => {
    await tool.execute({ path: 'docs/manual.pdf' });

    expect(mockStat).toHaveBeenCalledWith(
      expect.stringContaining(`${WORKSPACE}/docs/manual.pdf`),
    );
  });
});
