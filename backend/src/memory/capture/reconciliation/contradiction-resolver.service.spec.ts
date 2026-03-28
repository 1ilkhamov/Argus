import type { LlmService } from '../../../llm/llm.service';
import type { MemoryEntry } from '../../core/memory-entry.types';
import { ContradictionResolverService } from './contradiction-resolver.service';

const makeEntry = (
  id: string,
  kind: MemoryEntry['kind'],
  content: string,
  category?: string,
): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind,
  content,
  category,
  tags: [],
  source: 'llm_extraction',
  horizon: 'long_term',
  importance: 0.5,
  decayRate: 0.01,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
});

describe('ContradictionResolverService', () => {
  describe('findConflicts — preference interleave', () => {
    it('reaches category-only candidates for preferences even when word-overlap entries exist', async () => {
      // Simulate: many preferences with word overlap, plus a semantically contradicting one
      // without any word overlap (e.g., "warm tone" vs "no emotions")
      const existing: MemoryEntry[] = [
        makeEntry('p1', 'preference', 'Пиши по-русски, кратко и по делу.', 'communication'),
        makeEntry('p2', 'preference', 'Отвечай кратко и без лишней воды.', 'communication'),
        makeEntry('p3', 'preference', 'Не предлагать следующие шаги.', 'communication'),
        makeEntry('p4', 'preference', 'Switch to English for the next answer.', 'communication'),
        makeEntry('p5', 'preference', 'Не бойся спорить со мной.', 'communication'),
        makeEntry('p6', 'preference', 'Предпочитает русский язык.', 'communication'),
        makeEntry('p7', 'preference', 'Хочет более тёплый тон ответов.', 'communication'),
        makeEntry('p8', 'preference', 'Просит отвечать с примерами.', 'communication'),
      ];

      const newContent = 'Снова кратко и по делу, без эмоций.';

      // Track which entries the LLM was asked about
      const checkedIds: string[] = [];
      const llm = {
        complete: jest.fn().mockImplementation(async (_messages: unknown) => {
          const msgContent = (_messages as Array<{ content: string }>)[1]!.content;
          // Extract the entry that was checked from the prompt
          for (const entry of existing) {
            if (msgContent.includes(entry.content)) {
              checkedIds.push(entry.id);
              // Only flag p7 (warm tone) as contradiction
              if (entry.id === 'p7') {
                return {
                  content: JSON.stringify({
                    isContradiction: true,
                    action: 'keep_new',
                    reason: 'warm tone contradicts no emotions',
                  }),
                };
              }
            }
          }
          return {
            content: JSON.stringify({ isContradiction: false, action: 'keep_both', reason: 'compatible' }),
          };
        }),
      } as unknown as LlmService;

      const service = new ContradictionResolverService(llm);
      const conflicts = await service.findConflicts(existing, newContent, 'preference', 'communication');

      // p7 should have been reached and flagged
      expect(checkedIds).toContain('p7');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.existingEntry.id).toBe('p7');
      expect(conflicts[0]!.resolution!.action).toBe('keep_new');
    });

    it('uses higher maxChecks (10) for preferences vs default (5) for episodes', async () => {
      // Create 8 preference entries — all should be reachable
      const prefs: MemoryEntry[] = Array.from({ length: 8 }, (_, i) =>
        makeEntry(`pref-${i}`, 'preference', `Preference number ${i}`, 'communication'),
      );

      const checkedCount = { prefs: 0, episodes: 0 };

      const llm = {
        complete: jest.fn().mockResolvedValue({
          content: JSON.stringify({ isContradiction: false, action: 'keep_both', reason: 'ok' }),
        }),
      } as unknown as LlmService;

      const service = new ContradictionResolverService(llm);

      // Preferences should check up to 10
      await service.findConflicts(prefs, 'new pref', 'preference', 'communication');
      checkedCount.prefs = (llm.complete as jest.Mock).mock.calls.length;

      (llm.complete as jest.Mock).mockClear();

      // Episodes should check up to 5
      const episodes: MemoryEntry[] = Array.from({ length: 8 }, (_, i) =>
        makeEntry(`ep-${i}`, 'episode', `Episode event number ${i}`),
      );
      await service.findConflicts(episodes, 'new episode event', 'episode');
      checkedCount.episodes = (llm.complete as jest.Mock).mock.calls.length;

      expect(checkedCount.prefs).toBe(8); // all 8 checked (< 10 limit)
      expect(checkedCount.episodes).toBe(5); // capped at 5
    });
  });

  describe('checkAndResolve', () => {
    it('returns not-contradiction when LLM is unavailable', async () => {
      const service = new ContradictionResolverService();
      const entry = makeEntry('e1', 'fact', 'User works at NovaTech');
      const result = await service.checkAndResolve(entry, 'User works at CloudBase');
      expect(result.isContradiction).toBe(false);
    });

    it('parses keep_new resolution', async () => {
      const llm = {
        complete: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            isContradiction: true,
            action: 'keep_new',
            reason: 'user changed jobs',
          }),
        }),
      } as unknown as LlmService;

      const service = new ContradictionResolverService(llm);
      const entry = makeEntry('e1', 'fact', 'Works at NovaTech');
      const result = await service.checkAndResolve(entry, 'Works at CloudBase');

      expect(result.isContradiction).toBe(true);
      expect(result.resolution!.action).toBe('keep_new');
    });

    it('parses merge resolution', async () => {
      const llm = {
        complete: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            isContradiction: true,
            action: 'merge',
            merged: 'Uses SQLite for storage with Qdrant for vectors',
            reason: 'complementary info',
          }),
        }),
      } as unknown as LlmService;

      const service = new ContradictionResolverService(llm);
      const entry = makeEntry('e1', 'fact', 'Uses SQLite');
      const result = await service.checkAndResolve(entry, 'Uses Qdrant for vectors');

      expect(result.isContradiction).toBe(true);
      expect(result.resolution!.action).toBe('merge');
      expect((result.resolution as { merged: string }).merged).toBe(
        'Uses SQLite for storage with Qdrant for vectors',
      );
    });

    it('handles LLM error gracefully', async () => {
      const llm = {
        complete: jest.fn().mockRejectedValue(new Error('timeout')),
      } as unknown as LlmService;

      const service = new ContradictionResolverService(llm);
      const entry = makeEntry('e1', 'fact', 'something');
      const result = await service.checkAndResolve(entry, 'something else');

      expect(result.isContradiction).toBe(false);
    });

    it('handles malformed LLM JSON gracefully', async () => {
      const llm = {
        complete: jest.fn().mockResolvedValue({ content: 'not json at all' }),
      } as unknown as LlmService;

      const service = new ContradictionResolverService(llm);
      const entry = makeEntry('e1', 'fact', 'something');
      const result = await service.checkAndResolve(entry, 'something else');

      expect(result.isContradiction).toBe(false);
    });
  });
});
