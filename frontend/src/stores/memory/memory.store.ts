import { create } from 'zustand';

import type { MemoryEntryDto, MemoryKind, MemoryStatsResponse } from '@/types/memory.types';
import { memoryApi } from '@/api/resources/memory.api';

interface MemoryState {
  facts: MemoryEntryDto[];
  episodes: MemoryEntryDto[];
  stats: MemoryStatsResponse | null;
  isLoading: boolean;
  error: string | null;

  loadEntries: () => Promise<void>;
  loadStats: () => Promise<void>;
  createEntry: (kind: MemoryKind, content: string, category?: string) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  pinEntry: (id: string, pinned: boolean) => Promise<void>;
  clearError: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  facts: [],
  episodes: [],
  stats: null,
  isLoading: false,
  error: null,

  loadEntries: async () => {
    set({ isLoading: true, error: null });
    try {
      const [factsRes, episodesRes] = await Promise.all([
        memoryApi.listEntries('fact'),
        memoryApi.listEntries('episode'),
      ]);
      set({
        facts: factsRes.entries,
        episodes: episodesRes.entries,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load memory',
        isLoading: false,
      });
    }
  },

  loadStats: async () => {
    try {
      const stats = await memoryApi.getStats();
      set({ stats });
    } catch {
      // stats are non-critical, silently ignore
    }
  },

  createEntry: async (kind: MemoryKind, content: string, category?: string) => {
    try {
      const entry = await memoryApi.createEntry({ kind, content, category });
      if (kind === 'fact') {
        set({ facts: [entry, ...get().facts] });
      } else {
        set({ episodes: [entry, ...get().episodes] });
      }
      // Refresh stats after creation
      void get().loadStats();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create entry' });
    }
  },

  deleteEntry: async (id: string) => {
    try {
      await memoryApi.deleteEntry(id);
      set({
        facts: get().facts.filter((e) => e.id !== id),
        episodes: get().episodes.filter((e) => e.id !== id),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete entry' });
    }
  },

  pinEntry: async (id: string, pinned: boolean) => {
    try {
      const updated = await memoryApi.pinEntry(id, pinned);
      const replace = (list: MemoryEntryDto[]) => list.map((e) => (e.id === id ? updated : e));
      set({
        facts: replace(get().facts),
        episodes: replace(get().episodes),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to update entry' });
    }
  },

  clearError: () => set({ error: null }),
}));
