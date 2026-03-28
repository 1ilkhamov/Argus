import { MemoryStoreService } from './memory-store.service';
import type { MemoryEntryRepository } from './memory-entry.repository';
import type { MemoryEntry, MemoryQuery } from './memory-entry.types';

function createMockRepo(): jest.Mocked<MemoryEntryRepository> {
  return {
    save: jest.fn(),
    saveBatch: jest.fn(),
    findById: jest.fn(),
    findByIds: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    delete: jest.fn().mockResolvedValue(true),
    deleteBatch: jest.fn().mockResolvedValue(0),
    incrementAccessCount: jest.fn(),
  };
}

function buildService(repo: jest.Mocked<MemoryEntryRepository>): MemoryStoreService {
  return new MemoryStoreService(repo);
}

describe('MemoryStoreService', () => {
  let repo: jest.Mocked<MemoryEntryRepository>;
  let service: MemoryStoreService;

  beforeEach(() => {
    repo = createMockRepo();
    service = buildService(repo);
  });

  describe('create', () => {
    it('should create a memory entry with defaults', async () => {
      const entry = await service.create({
        kind: 'fact',
        content: 'User prefers TypeScript',
        source: 'llm_extraction',
      });

      expect(entry.id).toBeDefined();
      expect(entry.kind).toBe('fact');
      expect(entry.content).toBe('User prefers TypeScript');
      expect(entry.source).toBe('llm_extraction');
      expect(entry.horizon).toBe('long_term'); // default for 'fact'
      expect(entry.importance).toBe(0.7); // default for 'fact'
      expect(entry.decayRate).toBe(0); // default for 'long_term'
      expect(entry.accessCount).toBe(0);
      expect(entry.pinned).toBe(false);
      expect(entry.tags).toEqual([]);
      expect(repo.save).toHaveBeenCalledWith(entry);
    });

    it('should use custom params when provided', async () => {
      const entry = await service.create({
        kind: 'episode',
        content: 'Decided to use NestJS',
        source: 'user_explicit',
        category: 'technical',
        summary: 'NestJS decision',
        tags: ['architecture', 'backend'],
        horizon: 'long_term',
        importance: 0.9,
        pinned: true,
      });

      expect(entry.kind).toBe('episode');
      expect(entry.category).toBe('technical');
      expect(entry.summary).toBe('NestJS decision');
      expect(entry.tags).toEqual(['architecture', 'backend']);
      expect(entry.horizon).toBe('long_term');
      expect(entry.importance).toBe(0.9);
      expect(entry.pinned).toBe(true);
      expect(entry.decayRate).toBe(0); // long_term = no decay
    });

    it('should set correct defaults per kind', async () => {
      const learning = await service.create({ kind: 'learning', content: 'x', source: 'agent_reflection' });
      expect(learning.importance).toBe(0.8);
      expect(learning.horizon).toBe('long_term');

      const action = await service.create({ kind: 'action', content: 'y', source: 'tool_result' });
      expect(action.importance).toBe(0.3);
      expect(action.horizon).toBe('short_term');

      const skill = await service.create({ kind: 'skill', content: 'z', source: 'agent_reflection' });
      expect(skill.importance).toBe(0.9);
      expect(skill.horizon).toBe('long_term');
    });
  });

  describe('createBatch', () => {
    it('should create multiple entries in one call', async () => {
      const entries = await service.createBatch([
        { kind: 'fact', content: 'A', source: 'llm_extraction' },
        { kind: 'episode', content: 'B', source: 'user_explicit' },
      ]);

      expect(entries).toHaveLength(2);
      expect(entries[0]!.kind).toBe('fact');
      expect(entries[1]!.kind).toBe('episode');
      expect(repo.saveBatch).toHaveBeenCalledWith(entries);
    });
  });

  describe('getById', () => {
    it('should delegate to repo.findById', async () => {
      const mockEntry = { id: 'test-id', kind: 'fact' } as MemoryEntry;
      repo.findById.mockResolvedValue(mockEntry);

      const result = await service.getById('test-id');
      expect(result).toBe(mockEntry);
      expect(repo.findById).toHaveBeenCalledWith('test-id');
    });

    it('should return undefined for missing entry', async () => {
      repo.findById.mockResolvedValue(undefined);
      const result = await service.getById('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update existing entry fields', async () => {
      const existing: MemoryEntry = {
        id: 'e1',
        scopeKey: 'local:default',
        kind: 'fact',
        content: 'old content',
        tags: ['old'],
        source: 'llm_extraction',
        horizon: 'short_term',
        importance: 0.5,
        decayRate: 0.05,
        accessCount: 3,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        pinned: false,
      };
      repo.findById.mockResolvedValue(existing);

      const updated = await service.update('e1', {
        content: 'new content',
        importance: 0.9,
        pinned: true,
      });

      expect(updated).toBeDefined();
      expect(updated!.content).toBe('new content');
      expect(updated!.importance).toBe(0.9);
      expect(updated!.pinned).toBe(true);
      expect(updated!.tags).toEqual(['old']); // unchanged
      expect(repo.save).toHaveBeenCalled();
    });

    it('should return undefined for missing entry', async () => {
      repo.findById.mockResolvedValue(undefined);
      const result = await service.update('nonexistent', { content: 'x' });
      expect(result).toBeUndefined();
    });

    it('should update decayRate when horizon changes', async () => {
      const existing: MemoryEntry = {
        id: 'e2',
        scopeKey: 'local:default',
        kind: 'episode',
        content: 'c',
        tags: [],
        source: 'llm_extraction',
        horizon: 'short_term',
        importance: 0.5,
        decayRate: 0.05,
        accessCount: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        pinned: false,
      };
      repo.findById.mockResolvedValue(existing);

      const updated = await service.update('e2', { horizon: 'long_term' });
      expect(updated!.horizon).toBe('long_term');
      expect(updated!.decayRate).toBe(0); // long_term = no decay
    });
  });

  describe('delete', () => {
    it('should delegate to repo.delete', async () => {
      repo.delete.mockResolvedValue(true);
      const result = await service.delete('e1');
      expect(result).toBe(true);
      expect(repo.delete).toHaveBeenCalledWith('e1');
    });
  });

  describe('query', () => {
    it('should delegate to repo.query', async () => {
      const mockEntries = [{ id: '1' }, { id: '2' }] as MemoryEntry[];
      repo.query.mockResolvedValue(mockEntries);

      const query: MemoryQuery = { kinds: ['fact'], minImportance: 0.5 };
      const result = await service.query(query);
      expect(result).toBe(mockEntries);
      expect(repo.query).toHaveBeenCalledWith(query);
    });
  });

  describe('recordAccess', () => {
    it('should call incrementAccessCount on repo', async () => {
      await service.recordAccess(['id1', 'id2']);
      expect(repo.incrementAccessCount).toHaveBeenCalledWith(['id1', 'id2']);
    });

    it('should skip empty array', async () => {
      await service.recordAccess([]);
      expect(repo.incrementAccessCount).not.toHaveBeenCalled();
    });
  });

  describe('supersede', () => {
    it('should create new entry and mark old as superseded', async () => {
      const old: MemoryEntry = {
        id: 'old-id',
        scopeKey: 'local:default',
        kind: 'fact',
        content: 'old',
        tags: [],
        source: 'llm_extraction',
        horizon: 'long_term',
        importance: 0.7,
        decayRate: 0,
        accessCount: 5,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        pinned: false,
      };
      repo.findById.mockResolvedValueOnce(old); // for supersede
      repo.findById.mockResolvedValueOnce(old); // for update inside supersede

      const newEntry = await service.supersede('old-id', {
        kind: 'fact',
        content: 'updated info',
        source: 'llm_extraction',
      });

      expect(newEntry).toBeDefined();
      expect(newEntry!.content).toBe('updated info');
      // save was called for new entry + update of old entry
      expect(repo.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearWorkingMemory', () => {
    it('should delete all working horizon entries', async () => {
      const workingEntries = [{ id: 'w1' }, { id: 'w2' }] as MemoryEntry[];
      repo.query.mockResolvedValue(workingEntries);
      repo.deleteBatch.mockResolvedValue(2);

      const count = await service.clearWorkingMemory();
      expect(count).toBe(2);
      expect(repo.query).toHaveBeenCalledWith({ horizons: ['working'] });
      expect(repo.deleteBatch).toHaveBeenCalledWith(['w1', 'w2']);
    });
  });
});
