import type { MemoryEntry } from '../core/memory-entry.types';
import { MemoryStoreService } from '../core/memory-store.service';
import { MemoryToolsService } from './memory-tools.service';

const makeEntry = (id: string, kind: MemoryEntry['kind'] = 'fact', content = 'test'): MemoryEntry => ({
  id,
  scopeKey: 'local:default',
  kind,
  content,
  tags: [],
  source: 'user_explicit',
  horizon: 'long_term',
  importance: 0.5,
  decayRate: 0,
  accessCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  pinned: false,
});

let idCounter = 0;
const createMockStore = () => ({
  create: jest.fn().mockImplementation(async (params: { kind: string; content: string }) => {
    idCounter++;
    return makeEntry(`new-${idCounter}`, params.kind as MemoryEntry['kind'], params.content);
  }),
  getById: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue([]),
}) as unknown as MemoryStoreService;

describe('MemoryToolsService', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  describe('store', () => {
    it('creates a new memory entry', async () => {
      const store = createMockStore();
      const service = new MemoryToolsService(store);

      const result = await service.store({
        content: 'User prefers dark mode',
        kind: 'preference',
        tags: ['ui'],
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'preference',
          content: 'User prefers dark mode',
          source: 'user_explicit',
          tags: ['ui'],
        }),
      );
    });

    it('rejects content shorter than 3 chars', async () => {
      const service = new MemoryToolsService(createMockStore());
      const result = await service.store({ content: 'ab', kind: 'fact' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('3 characters');
    });

    it('rejects invalid kind', async () => {
      const service = new MemoryToolsService(createMockStore());
      const result = await service.store({ content: 'valid content', kind: 'invalid' as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid kind');
    });
  });

  describe('forget', () => {
    it('marks an existing entry as forgotten', async () => {
      const store = createMockStore();
      (store.getById as jest.Mock).mockResolvedValue(makeEntry('e1'));
      const service = new MemoryToolsService(store);

      const result = await service.forget({ id: 'e1' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ deleted: true });
      expect(store.update).toHaveBeenCalledWith('e1', { supersededBy: 'forgotten' });
    });

    it('returns error when entry not found', async () => {
      const store = createMockStore();
      const service = new MemoryToolsService(store);

      const result = await service.forget({ id: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('refuses to forget pinned entries', async () => {
      const store = createMockStore();
      (store.getById as jest.Mock).mockResolvedValue({ ...makeEntry('e1'), pinned: true });
      const service = new MemoryToolsService(store);

      const result = await service.forget({ id: 'e1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('pinned');
    });

    it('returns error for empty id', async () => {
      const service = new MemoryToolsService(createMockStore());
      const result = await service.forget({ id: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('update', () => {
    it('updates content of an existing entry', async () => {
      const entry = makeEntry('e1', 'fact', 'old content');
      const store = createMockStore();
      (store.getById as jest.Mock)
        .mockResolvedValueOnce(entry) // first call: check exists
        .mockResolvedValueOnce({ ...entry, content: 'new content' }); // second call: return updated
      const service = new MemoryToolsService(store);

      const result = await service.update({ id: 'e1', content: 'new content' });

      expect(result.success).toBe(true);
      expect(store.update).toHaveBeenCalledWith('e1', expect.objectContaining({ content: 'new content' }));
    });

    it('clamps importance to 0-1', async () => {
      const store = createMockStore();
      (store.getById as jest.Mock).mockResolvedValue(makeEntry('e1'));
      const service = new MemoryToolsService(store);

      await service.update({ id: 'e1', importance: 5.0 });

      expect(store.update).toHaveBeenCalledWith('e1', expect.objectContaining({ importance: 1 }));
    });

    it('returns error when no updates provided', async () => {
      const store = createMockStore();
      (store.getById as jest.Mock).mockResolvedValue(makeEntry('e1'));
      const service = new MemoryToolsService(store);

      const result = await service.update({ id: 'e1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No updates');
    });

    it('returns error when entry not found', async () => {
      const service = new MemoryToolsService(createMockStore());
      const result = await service.update({ id: 'nonexistent', content: 'new' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
