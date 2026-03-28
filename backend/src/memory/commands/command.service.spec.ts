import type { MemoryEntry } from '../core/memory-entry.types';
import { MemoryStoreService } from '../core/memory-store.service';
import { ConversationalMemoryCommandService } from './command.service';

const makeEntry = (overrides: Partial<MemoryEntry>): MemoryEntry => ({
  id: 'entry-1',
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
  ...overrides,
});

const createStoreMock = (entries: MemoryEntry[] = []) => {
  const state = [...entries];

  return {
    query: jest.fn().mockImplementation(async () => [...state]),
    count: jest.fn().mockImplementation(async () => state.length),
    delete: jest.fn().mockImplementation(async (id: string) => {
      const index = state.findIndex((e) => e.id === id);
      if (index === -1) return false;
      state.splice(index, 1);
      return true;
    }),
    update: jest.fn().mockImplementation(async (id: string, patch: Partial<MemoryEntry>) => {
      const entry = state.find((e) => e.id === id);
      if (!entry) return undefined;
      Object.assign(entry, patch);
      return { ...entry };
    }),
  } as unknown as MemoryStoreService;
};

describe('ConversationalMemoryCommandService', () => {
  it('returns handled=false for non-command messages', async () => {
    const store = createStoreMock();
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Hello, how are you?');
    expect(result.handled).toBe(false);
    expect(result.operationNote).toBeUndefined();
  });

  it('returns a formatted snapshot for inspect commands', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'project', content: 'Argus' }),
      makeEntry({ id: 'e1', kind: 'episode', summary: 'ship phase 8 controls' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('покажи память');
    expect(result.handled).toBe(true);
    expect(result.operationNote).toBeDefined();
    expect(result.operationNote).toContain('Argus');
  });

  it('deletes a fact by key via forget command', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'name', content: 'Alice' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('забудь моё имя');
    expect(result.handled).toBe(true);
    expect(store.delete).toHaveBeenCalledWith('f1');
    expect(result.operationNote).toBeDefined();
  });

  it('returns not-found note when forgetting a non-existent fact', async () => {
    const store = createStoreMock([]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('забудь моё имя');
    expect(result.handled).toBe(true);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('pins a fact by key', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'project', content: 'Argus' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('закрепи проект');
    expect(result.handled).toBe(true);
    expect(store.update).toHaveBeenCalledWith('f1', { pinned: true });
  });

  it('unpins a fact by key', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'project', content: 'Argus', pinned: true }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('открепи проект');
    expect(result.handled).toBe(true);
    expect(store.update).toHaveBeenCalledWith('f1', { pinned: false });
  });

  // ─── Regression: Bug A — "закрепи роль" should pin role, not email ───

  it('pins role fact by content pattern, not by identity category', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'email', kind: 'fact', category: 'identity', content: 'Мой email изменился на ilya@cloudbase.io.' }),
      makeEntry({ id: 'role', kind: 'fact', category: 'identity', content: 'Теперь работает в CloudBase.' }),
      makeEntry({ id: 'name', kind: 'fact', category: 'identity', content: 'Меня зовут Илья.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Закрепи мою роль.');
    expect(result.handled).toBe(true);
    expect(store.update).toHaveBeenCalledWith('role', { pinned: true });
  });

  // ─── Regression: Bug B — "закрепи проект" should pin project name, not team member ───

  it('pins project name fact over team member fact when both share project category', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'team', kind: 'fact', category: 'project', content: 'Артём отвечает за ML в команде.' }),
      makeEntry({ id: 'proj', kind: 'fact', category: 'project', content: 'Проект теперь называется Orion.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Закрепи проект.');
    expect(result.handled).toBe(true);
    expect(store.update).toHaveBeenCalledWith('proj', { pinned: true });
  });

  // ─── Regression: Bug C — "закрепи sprint goal" should find goal episode by content ───

  it('finds episodic goal entry by content keyword when category differs', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'ep1', kind: 'episode', category: 'project', content: 'Цель спринта: прогнать 100 боевых сообщений.' }),
      makeEntry({ id: 'ep2', kind: 'episode', category: 'project', content: 'Code review memory pipeline.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Закрепи sprint goal.');
    expect(result.handled).toBe(true);
    expect(store.update).toHaveBeenCalledWith('ep1', { pinned: true });
  });

  // ─── P1: Content-based forget ("забудь про Python") ───────────────────────

  it('deletes a fact by content value when no structured key matches', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'ts', kind: 'fact', content: 'Main stack: TypeScript and NestJS.' }),
      makeEntry({ id: 'py', kind: 'fact', content: 'Основной стек — Python и Django.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Забудь про Python');
    expect(result.handled).toBe(true);
    expect(store.delete).toHaveBeenCalledWith('py');
  });

  it('returns not-found when content-based forget finds no match', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'ts', kind: 'fact', content: 'Main stack: TypeScript and NestJS.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Forget about Ruby');
    expect(result.handled).toBe(true);
    expect(store.delete).not.toHaveBeenCalled();
  });

  // ─── P2: Stack key recognition ─────────────────────────────────────

  it('pins a stack fact via "закрепи факт о моём стеке"', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'stack1', kind: 'fact', content: 'Main stack: TypeScript, NestJS, React, PostgreSQL.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Закрепи факт о моём стеке');
    expect(result.handled).toBe(true);
    expect(store.update).toHaveBeenCalledWith('stack1', { pinned: true });
  });

  it('forgets a stack fact via "забудь мой стек"', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'stack1', kind: 'fact', content: 'Стек пользователя — TypeScript и NestJS.' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Забудь мой стек');
    expect(result.handled).toBe(true);
    expect(store.delete).toHaveBeenCalledWith('stack1');
  });

  // ─── P6: Free-form inspect ─────────────────────────────────────────

  it('triggers inspect for "Что ты помнишь обо мне?"', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'name', content: 'Артём' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Что ты помнишь обо мне?');
    expect(result.handled).toBe(true);
    expect(result.operationNote).toContain('Артём');
  });

  it('triggers inspect for "What do you remember about me?"', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'name', content: 'Alice' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('What do you remember about me?');
    expect(result.handled).toBe(true);
    expect(result.operationNote).toContain('Alice');
  });

  it('triggers inspect for "Что ты знаешь про меня?"', async () => {
    const store = createStoreMock([
      makeEntry({ id: 'f1', kind: 'fact', category: 'project', content: 'Argus' }),
    ]);
    const service = new ConversationalMemoryCommandService(store);
    const result = await service.handle('Что ты знаешь про меня?');
    expect(result.handled).toBe(true);
    expect(result.operationNote).toContain('Argus');
  });
});
