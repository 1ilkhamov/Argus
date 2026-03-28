import { Test } from '@nestjs/testing';

import { KnowledgeSearchTool } from './knowledge-search.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import { AutoRecallService } from '../../../memory/recall/auto-recall.service';
import type { RecalledMemory, MemoryEntry } from '../../../memory/core/memory-entry.types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'entry-1',
    scopeKey: 'local:default',
    kind: 'fact',
    content: 'User prefers TypeScript',
    tags: ['language'],
    source: 'user_explicit',
    horizon: 'long_term',
    importance: 0.7,
    decayRate: 0,
    accessCount: 3,
    lastAccessedAt: '2026-03-20T10:00:00.000Z',
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-20T10:00:00.000Z',
    pinned: false,
    ...overrides,
  };
}

function makeRecalled(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    entry: makeEntry(),
    score: 0.85,
    matchSource: 'semantic',
    confidence: 'high',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('KnowledgeSearchTool', () => {
  let tool: KnowledgeSearchTool;
  let recallMock: jest.Mock;

  beforeEach(async () => {
    recallMock = jest.fn().mockResolvedValue([]);

    const module = await Test.createTestingModule({
      providers: [
        KnowledgeSearchTool,
        {
          provide: ToolRegistryService,
          useValue: { register: jest.fn() },
        },
        {
          provide: AutoRecallService,
          useValue: { recall: recallMock },
        },
      ],
    }).compile();

    tool = module.get(KnowledgeSearchTool);
  });

  it('should have correct definition', () => {
    expect(tool.definition.name).toBe('knowledge_search');
    expect(tool.definition.safety).toBe('safe');
    expect(tool.definition.parameters.required).toEqual(['query']);
  });

  it('should return error for empty query', async () => {
    const result = await tool.execute({ query: '' });
    expect(result).toContain('Error');
    expect(result).toContain('query');
    expect(recallMock).not.toHaveBeenCalled();
  });

  it('should return error for query exceeding max length', async () => {
    const result = await tool.execute({ query: 'x'.repeat(501) });
    expect(result).toContain('Error');
    expect(result).toContain('too long');
  });

  it('should return error for invalid kind', async () => {
    const result = await tool.execute({ query: 'test', kinds: ['invalid_kind'] });
    expect(result).toContain('Error');
    expect(result).toContain('Invalid kind');
  });

  it('should return "no memories found" when recall returns empty', async () => {
    recallMock.mockResolvedValue([]);
    const result = await tool.execute({ query: 'something obscure' });
    expect(result).toContain('No memories found');
    expect(result).toContain('something obscure');
  });

  it('should pass correct options to recall', async () => {
    recallMock.mockResolvedValue([]);
    await tool.execute({
      query: 'TypeScript preference',
      kinds: ['fact', 'preference'],
      tags: ['language'],
      include_graph: false,
      limit: 5,
    });

    expect(recallMock).toHaveBeenCalledWith('TypeScript preference', {
      limit: 5,
      kinds: ['fact', 'preference'],
      tags: ['language'],
      includeGraph: false,
    });
  });

  it('should format results with confidence, source, and metadata', async () => {
    recallMock.mockResolvedValue([
      makeRecalled({
        entry: makeEntry({
          id: 'e-1',
          kind: 'fact',
          content: 'User prefers TypeScript for backend',
          tags: ['language', 'backend'],
          importance: 0.8,
          pinned: true,
          category: 'technical',
        }),
        score: 0.92,
        matchSource: 'semantic',
        confidence: 'high',
      }),
    ]);

    const result = await tool.execute({ query: 'programming language' });

    expect(result).toContain('1 result(s)');
    expect(result).toContain('FACT');
    expect(result).toContain('confidence: high');
    expect(result).toContain('source: semantic');
    expect(result).toContain('0.920');
    expect(result).toContain('User prefers TypeScript for backend');
    expect(result).toContain('importance: 0.80');
    expect(result).toContain('pinned');
    expect(result).toContain('category: technical');
    expect(result).toContain('tags: [language, backend]');
    expect(result).toContain('id: e-1');
  });

  it('should filter by min_importance post-recall', async () => {
    recallMock.mockResolvedValue([
      makeRecalled({ entry: makeEntry({ id: 'high', importance: 0.9 }), score: 0.8 }),
      makeRecalled({ entry: makeEntry({ id: 'low', importance: 0.3 }), score: 0.7 }),
    ]);

    const result = await tool.execute({ query: 'test', min_importance: 0.5 });

    expect(result).toContain('1 result(s)');
    expect(result).toContain('id: high');
    expect(result).not.toContain('id: low');
  });

  it('should show contradiction warnings', async () => {
    recallMock.mockResolvedValue([
      makeRecalled({
        entry: makeEntry({ id: 'e-1' }),
        contradicts: ['e-2', 'e-3'],
      }),
    ]);

    const result = await tool.execute({ query: 'test' });
    expect(result).toContain('contradict');
    expect(result).toContain('e-2');
    expect(result).toContain('e-3');
  });

  it('should show summary instead of content when available', async () => {
    recallMock.mockResolvedValue([
      makeRecalled({
        entry: makeEntry({
          content: 'Very long detailed content that should not be shown',
          summary: 'Short summary',
        }),
      }),
    ]);

    const result = await tool.execute({ query: 'test' });
    expect(result).toContain('Short summary');
    expect(result).not.toContain('Very long detailed content');
  });

  it('should handle recall service errors gracefully', async () => {
    recallMock.mockRejectedValue(new Error('Qdrant connection failed'));
    const result = await tool.execute({ query: 'test' });
    expect(result).toContain('Error searching knowledge base');
    expect(result).toContain('Qdrant connection failed');
  });

  it('should include graph search by default', async () => {
    recallMock.mockResolvedValue([]);
    await tool.execute({ query: 'test' });
    expect(recallMock).toHaveBeenCalledWith('test', expect.objectContaining({
      includeGraph: true,
    }));
  });

  it('should clamp limit to max', async () => {
    recallMock.mockResolvedValue([]);
    await tool.execute({ query: 'test', limit: 100 });
    expect(recallMock).toHaveBeenCalledWith('test', expect.objectContaining({
      limit: 20,
    }));
  });

  it('should show filters in empty result message', async () => {
    recallMock.mockResolvedValue([]);
    const result = await tool.execute({
      query: 'test',
      kinds: ['fact'],
      tags: ['work'],
    });
    expect(result).toContain('kinds: fact');
    expect(result).toContain('tags: work');
    expect(result).toContain('broadening');
  });

  it('should accept single kind as string (graceful parse)', async () => {
    recallMock.mockResolvedValue([]);
    await tool.execute({ query: 'test', kinds: 'fact' as unknown });
    expect(recallMock).toHaveBeenCalledWith('test', expect.objectContaining({
      kinds: ['fact'],
    }));
  });
});
