import { beforeEach, describe, expect, it } from 'vitest';

import { useLangStore } from './lang.store';

describe('useLangStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'ru';
    useLangStore.setState({ lang: 'ru' });
  });

  it('updates document language when switching locale', () => {
    useLangStore.getState().setLang('en');

    expect(useLangStore.getState().lang).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('returns translated labels for current language', () => {
    useLangStore.getState().setLang('en');

    expect(useLangStore.getState().t('chat.newChat')).toBe('New Chat');
  });
});
