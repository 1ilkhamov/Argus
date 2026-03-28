import ru from './locales/ru.json';
import en from './locales/en.json';

export type Lang = 'ru' | 'en';

export const SUPPORTED_LANGS: readonly Lang[] = ['ru', 'en'] as const;

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'RU',
  en: 'EN',
};

const locales: Record<Lang, typeof ru> = { ru, en };

type NestedKeys<T, Prefix extends string = ''> = T extends Record<string, unknown>
  ? {
      [K in keyof T & string]: T[K] extends Record<string, unknown>
        ? NestedKeys<T[K], `${Prefix}${K}.`>
        : `${Prefix}${K}`;
    }[keyof T & string]
  : never;

export type TranslationKey = NestedKeys<typeof ru>;

export function getTranslation(lang: Lang, key: TranslationKey): string {
  const parts = key.split('.');
  let result: unknown = locales[lang];

  for (const part of parts) {
    if (result && typeof result === 'object' && part in result) {
      result = (result as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }

  return typeof result === 'string' ? result : key;
}
