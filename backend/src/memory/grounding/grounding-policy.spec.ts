import type { RecalledMemory } from '../core/memory-entry.types';
import type { ArchivedChatEvidenceItem } from '../archive/archive-chat-retrieval.types';
import {
  buildMemoryGroundingRetryInstruction,
  resolveMemoryGroundingContext,
  validateMemoryGroundingResponse,
} from './grounding-policy';

const makeRecalledMemory = (overrides: Partial<RecalledMemory> = {}): RecalledMemory => ({
  entry: {
    id: 'mem-1',
    scopeKey: 'local:default',
    kind: 'fact',
    content: 'test',
    tags: [],
    source: 'llm_extraction',
    importance: 0.8,
    horizon: 'long_term',
    decayRate: 0.01,
    pinned: false,
    accessCount: 0,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  },
  score: 0.9,
  matchSource: 'semantic',
  confidence: 'high',
  ...overrides,
});

const makeArchiveEvidence = (overrides: Partial<ArchivedChatEvidenceItem> = {}): ArchivedChatEvidenceItem => ({
  conversationId: 'conv-1',
  messageId: 'msg-1',
  createdAt: '2026-03-01T00:00:00.000Z',
  role: 'user',
  excerpt: 'test excerpt',
  score: 4.3,
  ...overrides,
});

describe('memory-grounding-policy', () => {
  it('marks direct name/project/goal recall requests as memory questions with structured evidence', () => {
    const result = resolveMemoryGroundingContext(
      'What did I call my project earlier?',
      [makeRecalledMemory({ entry: { id: 'mem-1', scopeKey: 'local:default', kind: 'fact', content: 'project=Argus', tags: [], source: 'llm_extraction', importance: 0.8, horizon: 'long_term', decayRate: 0.01, pinned: false, accessCount: 0, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' } })],
      [],
    );

    expect(result.isMemoryQuestion).toBe(true);
    expect(result.intent).toBe('project');
    expect(result.evidenceStrength).toBe('structured');
    expect(result.shouldUseUncertaintyFirst).toBe(false);
  });

  it('falls back to uncertainty-first for memory questions without structured or archive support', () => {
    const result = resolveMemoryGroundingContext('Как меня зовут?', [], []);

    expect(result.isMemoryQuestion).toBe(true);
    expect(result.intent).toBe('name');
    expect(result.evidenceStrength).toBe('none');
    expect(result.shouldUseUncertaintyFirst).toBe(true);
  });

  it('treats discussion-summary questions with archive evidence as grounded historical support', () => {
    const result = resolveMemoryGroundingContext(
      'Что мы обсуждали раньше?',
      [],
      [makeArchiveEvidence({ excerpt: 'Мы обсуждали Argus memory retrieval.' })],
    );

    expect(result.isMemoryQuestion).toBe(true);
    expect(result.intent).toBe('summary');
    expect(result.evidenceStrength).toBe('archive_only');
    expect(result.archiveEvidenceCount).toBe(1);
    expect(result.shouldUseUncertaintyFirst).toBe(false);
  });

  it('rejects unsupported confident memory claims when no grounded evidence exists', () => {
    const context = resolveMemoryGroundingContext('Как меня зовут?', [], []);

    const validation = validateMemoryGroundingResponse('Тебя зовут Алекс.', context);

    expect(validation.compliant).toBe(false);
    expect(validation.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['missing_uncertainty_lead', 'unsupported_memory_claim']),
    );
    expect(buildMemoryGroundingRetryInstruction(context, validation.violations)).toContain(
      'There is no grounded memory evidence for this memory question.',
    );
  });

  it('requires archive-only answers to be labeled as prior-chat evidence', () => {
    const context = resolveMemoryGroundingContext(
      'What did we discuss earlier?',
      [],
      [makeArchiveEvidence({ excerpt: 'We discussed Argus memory retrieval.' })],
    );

    const unsupported = validateMemoryGroundingResponse('We discussed Argus memory retrieval.', context);
    const grounded = validateMemoryGroundingResponse(
      'Based on earlier chat evidence, we discussed Argus memory retrieval.',
      context,
    );

    expect(unsupported.compliant).toBe(false);
    expect(unsupported.violations.map((violation) => violation.code)).toContain('missing_archive_qualification');
    expect(grounded.compliant).toBe(true);
  });
});
