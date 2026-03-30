import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { type Lang, type TranslationKey, getTranslation } from '@/i18n';
import { STORAGE_KEYS } from '@/constants';

export type { Lang, TranslationKey };

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey) => string;
}

export const useLangStore = create<LangState>()(
  persist(
    (set, get) => ({
      lang: 'ru',

      setLang: (lang: Lang) => {
        document.documentElement.lang = lang;
        set({ lang });
      },

      t: (key: TranslationKey) => getTranslation(get().lang, key),
    }),
    {
      name: STORAGE_KEYS.lang,
      partialize: (state) => ({ lang: state.lang }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          document.documentElement.lang = state.lang;
        }
      },
    },
  ),
);
