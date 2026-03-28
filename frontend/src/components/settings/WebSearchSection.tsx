import { useEffect, useState } from 'react';
import { Eye, EyeOff, Trash2, Save, ExternalLink, Check } from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { useSettingsStore } from '@/stores/settings/settings.store';
import { useLangStore } from '@/stores/ui/lang.store';
import { getTranslation } from '@/i18n';

const API_KEYS = [
  { key: 'tools.web_search.brave_api_key', label: 'Brave Search', placeholder: 'BSA...', url: 'https://brave.com/search/api/' },
  { key: 'tools.web_search.tavily_api_key', label: 'Tavily', placeholder: 'tvly-...', url: 'https://tavily.com/' },
  { key: 'tools.web_search.jina_api_key', label: 'Jina Search', placeholder: 'jina_...', url: 'https://jina.ai/' },
  { key: 'tools.web_search.searxng_url', label: 'SearXNG URL', placeholder: 'https://searx.example.com' },
];

const PROVIDER_OPTIONS = ['auto', 'brave', 'tavily', 'jina', 'searxng', 'duckduckgo'];

export function WebSearchSection() {
  const { lang } = useLangStore();
  const t = (key: Parameters<typeof getTranslation>[1]) => getTranslation(lang, key);
  const { settings, updateSetting, deleteSetting } = useSettingsStore();

  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const vals: Record<string, string> = {};
    for (const s of settings) vals[s.key] = s.sensitive ? '' : s.value;
    setEditValues(vals);
  }, [settings]);

  const handleSave = async (key: string) => {
    const value = editValues[key];
    if (!value) return;
    setSaving((p) => ({ ...p, [key]: true }));
    try {
      await updateSetting(key, value);
      setEditValues((p) => ({ ...p, [key]: '' }));
    } finally {
      setSaving((p) => ({ ...p, [key]: false }));
    }
  };

  const getSetting = (key: string) => settings.find((s) => s.key === key);
  const isActive = (key: string) => {
    const s = getSetting(key);
    return s?.value && s.value !== '••••••••' && s.value !== '';
  };

  const providerSetting = getSetting('tools.web_search.provider');

  return (
    <>
      {/* Provider selector */}
      <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('settings.providerLabel')}
          </span>
          <CustomSelect
            value={editValues['tools.web_search.provider'] || providerSetting?.value || 'auto'}
            options={PROVIDER_OPTIONS}
            onChange={(val) => {
              setEditValues((p) => ({ ...p, 'tools.web_search.provider': val }));
              updateSetting('tools.web_search.provider', val);
            }}
          />
        </div>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.providerDesc')}
        </p>
      </div>

      {/* API Keys — all in one card */}
      <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
        <div className="space-y-3">
          {API_KEYS.map(({ key, label, placeholder, url }) => {
            const setting = getSetting(key);
            const active = isActive(key);
            return (
              <div key={key}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                  {url && (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="opacity-30 hover:opacity-70">
                      <ExternalLink size={11} strokeWidth={1.9} style={{ color: 'var(--text-tertiary)' }} />
                    </a>
                  )}
                  {active && (
                    <Check size={12} strokeWidth={2.5} style={{ color: 'var(--accent)' }} />
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <input
                      type={setting?.sensitive && !showValues[key] ? 'password' : 'text'}
                      value={editValues[key] ?? ''}
                      onChange={(e) => setEditValues((p) => ({ ...p, [key]: e.target.value }))}
                      placeholder={active ? '••••••••' : placeholder}
                      className="w-full rounded-lg border px-2.5 py-1.5 pr-8 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
                      style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSave(key); }}
                    />
                    {setting?.sensitive && (
                      <button onClick={() => setShowValues((p) => ({ ...p, [key]: !p[key] }))} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-80">
                        {showValues[key] ? <EyeOff size={13} style={{ color: 'var(--text-tertiary)' }} /> : <Eye size={13} style={{ color: 'var(--text-tertiary)' }} />}
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => handleSave(key)}
                    disabled={!editValues[key] || saving[key]}
                    className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-20"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                    title={t('settings.save')}
                  >
                    <Save size={13} strokeWidth={1.9} />
                  </button>
                  {active && setting?.updatedAt && (
                    <button
                      onClick={() => { setSaving((p) => ({ ...p, [key]: true })); deleteSetting(key).finally(() => setSaving((p) => ({ ...p, [key]: false }))); }}
                      disabled={saving[key]}
                      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-20"
                      title={t('settings.reset')}
                      style={{ color: 'var(--error)' }}
                    >
                      <Trash2 size={13} strokeWidth={1.9} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
