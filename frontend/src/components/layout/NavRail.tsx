import { MessageSquare, Wrench, Brain, Settings } from 'lucide-react';

import { useDashboardStore, type AppPage } from '@/stores/ui/dashboard.store';
import { useLangStore, type TranslationKey } from '@/stores/ui/lang.store';

const NAV_ITEMS: { key: AppPage; icon: typeof Settings; label: TranslationKey }[] = [
  { key: 'chat', icon: MessageSquare, label: 'chat.newChat' },
  { key: 'tools', icon: Wrench, label: 'tools.title' },
  { key: 'memory', icon: Brain, label: 'memory.title' },
  { key: 'settings', icon: Settings, label: 'settings.title' },
];

export function NavRail() {
  const { activePage, setPage } = useDashboardStore();
  const { t } = useLangStore();

  return (
    <nav
      className="flex h-full w-[60px] shrink-0 flex-col items-center gap-1 py-3"
      style={{
        borderRight: '1px solid var(--border-secondary)',
        background: 'color-mix(in srgb, var(--panel-surface) 60%, transparent)',
      }}
    >
      <div className="flex flex-1 flex-col items-center gap-1 pt-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activePage === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              className="group relative flex h-10 w-10 items-center justify-center rounded-xl transition-all"
              style={{
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
              }}
              title={t(item.label)}
            >
              <Icon
                size={18}
                strokeWidth={1.8}
                style={{ color: isActive ? 'var(--accent)' : 'var(--text-tertiary)' }}
              />
              
            </button>
          );
        })}
      </div>
    </nav>
  );
}
