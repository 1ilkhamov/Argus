import { create } from 'zustand';
import { settingsApi, type SettingDto } from '@/api/resources/settings.api';

interface SettingsState {
  settings: SettingDto[];
  isLoading: boolean;
  error: string | null;
  isOpen: boolean;

  openSettings: () => void;
  closeSettings: () => void;
  fetchSettings: () => Promise<void>;
  updateSetting: (key: string, value: string) => Promise<void>;
  deleteSetting: (key: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: [],
  isLoading: false,
  error: null,
  isOpen: false,

  openSettings: () => set({ isOpen: true }),
  closeSettings: () => set({ isOpen: false }),

  fetchSettings: async () => {
    set({ isLoading: true, error: null });
    try {
      const settings = await settingsApi.getAll();
      set({ settings, isLoading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load settings', isLoading: false });
    }
  },

  updateSetting: async (key: string, value: string) => {
    set({ error: null });
    try {
      const updated = await settingsApi.update(key, value);
      set({
        settings: get().settings.map((s) => (s.key === key ? updated : s)),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to update setting' });
      throw error;
    }
  },

  deleteSetting: async (key: string) => {
    set({ error: null });
    try {
      await settingsApi.remove(key);
      // Refetch to get .env fallback values
      await get().fetchSettings();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete setting' });
      throw error;
    }
  },
}));
