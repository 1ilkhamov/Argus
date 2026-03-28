import type { MemoryEntry, MemoryQuery } from './memory-entry.types';

export const MEMORY_ENTRY_REPOSITORY = Symbol('MEMORY_ENTRY_REPOSITORY');

export abstract class MemoryEntryRepository {
  abstract save(entry: MemoryEntry): Promise<void>;
  abstract saveBatch(entries: MemoryEntry[]): Promise<void>;
  abstract findById(id: string): Promise<MemoryEntry | undefined>;
  abstract findByIds(ids: string[]): Promise<MemoryEntry[]>;
  abstract query(query: MemoryQuery): Promise<MemoryEntry[]>;
  abstract count(query: MemoryQuery): Promise<number>;
  abstract delete(id: string): Promise<boolean>;
  abstract deleteBatch(ids: string[]): Promise<number>;
  abstract incrementAccessCount(ids: string[]): Promise<void>;
}
