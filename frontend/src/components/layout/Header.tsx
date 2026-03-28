import { APP_CONFIG } from '@/config';
import {
  Bot,
  Languages,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
} from 'lucide-react';
import { useThemeStore } from '@/stores/ui/theme.store';
import { useLangStore } from '@/stores/ui/lang.store';
import { type Lang, LANG_LABELS } from '@/i18n';

interface HeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function Header({ sidebarOpen, onToggleSidebar }: HeaderProps) {
  const { theme, toggleTheme } = useThemeStore();
  const { lang, setLang } = useLangStore();

  const nextLang: Lang = lang === 'ru' ? 'en' : 'ru';

  return (
    <header
      className="flex h-[76px] shrink-0 items-center justify-between border-b px-4 sm:px-5"
      style={{
        borderColor: 'var(--border-primary)',
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--shell-header) 94%, var(--accent) 6%) 0%, rgba(0, 0, 0, 0) 140%)',
      }}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="icon-button flex h-11 w-11 items-center justify-center rounded-2xl"
        >
          {sidebarOpen ? <PanelLeftClose size={18} strokeWidth={1.9} /> : <PanelLeftOpen size={18} strokeWidth={1.9} />}
        </button>

        <div className="surface-card-muted flex items-center gap-3 rounded-2xl px-3 py-2">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-2xl"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--panel-surface) 90%, var(--accent) 10%) 0%, var(--panel-surface) 100%)',
              border: '1px solid var(--border-secondary)',
              boxShadow: '0 0 14px var(--accent-glow)',
            }}
          >
            <Bot size={18} strokeWidth={1.9} style={{ color: 'var(--accent-strong)' }} />
          </div>

          <div className="flex flex-col">
            <span className="text-[15px] font-semibold tracking-[0.02em]" style={{ color: 'var(--text-primary)' }}>
              {APP_CONFIG.name}
            </span>
            <span className="text-[11px] uppercase tracking-[0.28em]" style={{ color: 'var(--text-tertiary)' }}>
              v{APP_CONFIG.version}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setLang(nextLang)}
          className="control-button flex items-center gap-2 rounded-2xl px-3 py-2 text-xs font-medium"
        >
          <Languages size={14} strokeWidth={1.9} />
          <span>{LANG_LABELS[lang]}</span>
        </button>

        <button
          onClick={toggleTheme}
          className="icon-button flex h-11 w-11 items-center justify-center rounded-2xl"
        >
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.9} /> : <Moon size={16} strokeWidth={1.9} />}
        </button>
      </div>
    </header>
  );
}
