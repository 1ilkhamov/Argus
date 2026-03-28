import { create } from 'zustand';

export type AppPage = 'chat' | 'settings' | 'memory' | 'tools';

interface DashboardState {
  activePage: AppPage;
  setPage: (page: AppPage) => void;
  togglePage: (page: AppPage) => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  activePage: 'chat',

  setPage: (page) => set({ activePage: page }),

  togglePage: (page) =>
    set({ activePage: get().activePage === page ? 'chat' : page }),
}));
