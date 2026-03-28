import { create } from 'zustand';

import type { ToolInfoDto } from '@/types/tools.types';
import { toolsApi } from '@/api/resources/tools.api';

interface ToolsState {
  tools: ToolInfoDto[];
  isLoading: boolean;
  error: string | null;

  loadTools: () => Promise<void>;
  clearError: () => void;
}

export const useToolsStore = create<ToolsState>((set) => ({
  tools: [],
  isLoading: false,
  error: null,

  loadTools: async () => {
    set({ isLoading: true, error: null });
    try {
      const tools = await toolsApi.listTools();
      set({ tools, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load tools',
        isLoading: false,
      });
    }
  },

  clearError: () => set({ error: null }),
}));
