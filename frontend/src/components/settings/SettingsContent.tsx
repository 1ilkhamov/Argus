import { useEffect, useState } from 'react';
import { Settings, Search, Send, Mail, MessageSquare } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings/settings.store';
import { useLangStore } from '@/stores/ui/lang.store';
import { getTranslation } from '@/i18n';
import { PageHeader, TabBar, PageScrollArea, PageFooter, PageError, PageLoading } from '@/components/common';
import type { TabItem } from '@/components/common';
import { WebSearchSection } from './WebSearchSection';
import { TelegramBotSection } from './TelegramBotSection';
import { TelegramClientSection } from './TelegramClientSection';
import { EmailSection } from './EmailSection';

type SettingsTab = 'search' | 'telegram' | 'email';

export function SettingsContent() {
  const { lang } = useLangStore();
  const t = (key: Parameters<typeof getTranslation>[1]) => getTranslation(lang, key);
  const { isLoading, error, fetchSettings } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>('telegram');
  const [tgSubTab, setTgSubTab] = useState<'bot' | 'account'>('account');

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const tabItems: TabItem<SettingsTab>[] = [
    { key: 'search', label: t('settings.tabSearch' as Parameters<typeof getTranslation>[1]), icon: Search },
    { key: 'telegram', label: t('settings.tabTelegram' as Parameters<typeof getTranslation>[1]), icon: Send },
    { key: 'email', label: t('settings.tabEmail' as Parameters<typeof getTranslation>[1]), icon: Mail },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader icon={Settings} title={t('settings.title')} />
      <TabBar tabs={tabItems} activeTab={activeTab} onChange={setActiveTab} variant="underline" />

      {error && <PageError message={error} onDismiss={() => {}} dismissLabel={t('common.dismiss')} />}

      <PageScrollArea>
        {isLoading ? (
          <PageLoading label={t('common.loading')} />
        ) : (
          <div className="space-y-1">
            {activeTab === 'search' && <WebSearchSection />}

            {activeTab === 'telegram' && (
              <>
                {/* Sub-tabs: Bot / Account */}
                <div className="mb-3 flex gap-1 rounded-xl p-1" style={{ background: 'var(--panel-surface)' }}>
                  <button
                    onClick={() => setTgSubTab('bot')}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      background: tgSubTab === 'bot' ? 'var(--accent-soft)' : 'transparent',
                      color: tgSubTab === 'bot' ? 'var(--accent)' : 'var(--text-tertiary)',
                    }}
                  >
                    <Send size={12} strokeWidth={1.9} />
                    {t('settings.tgSectionBot')}
                  </button>
                  <button
                    onClick={() => setTgSubTab('account')}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                    style={{
                      background: tgSubTab === 'account' ? 'var(--accent-soft)' : 'transparent',
                      color: tgSubTab === 'account' ? 'var(--accent)' : 'var(--text-tertiary)',
                    }}
                  >
                    <MessageSquare size={12} strokeWidth={1.9} />
                    {t('settings.tgSectionAccount')}
                  </button>
                </div>

                {tgSubTab === 'bot' && <TelegramBotSection />}
                {tgSubTab === 'account' && <TelegramClientSection />}
              </>
            )}

            {activeTab === 'email' && <EmailSection />}
          </div>
        )}
      </PageScrollArea>

      <PageFooter>
        <p className="text-center text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.encryptionNote')}
        </p>
      </PageFooter>
    </div>
  );
}
