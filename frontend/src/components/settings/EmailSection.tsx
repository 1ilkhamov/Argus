import { useEffect, useState } from 'react';
import { Eye, EyeOff, Save } from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { useSettingsStore } from '@/stores/settings/settings.store';
import { useLangStore } from '@/stores/ui/lang.store';
import { getTranslation } from '@/i18n';

const PROVIDER_OPTIONS = ['gmail', 'outlook', 'yandex', 'mailru', 'icloud', 'custom'];
const MAIN_FIELDS = [
  { key: 'tools.email.email', labelKey: 'settings.emailAddressLabel', placeholder: 'user@gmail.com', sensitive: false },
  { key: 'tools.email.password', labelKey: 'settings.emailPasswordLabel', placeholder: 'xxxx-xxxx-xxxx-xxxx', sensitive: true },
];
const CUSTOM_FIELDS = [
  { key: 'tools.email.imap_host', labelKey: 'settings.emailImapHostLabel', placeholder: 'imap.example.com' },
  { key: 'tools.email.imap_port', labelKey: 'settings.emailImapPortLabel', placeholder: '993' },
  { key: 'tools.email.smtp_host', labelKey: 'settings.emailSmtpHostLabel', placeholder: 'smtp.example.com' },
  { key: 'tools.email.smtp_port', labelKey: 'settings.emailSmtpPortLabel', placeholder: '587' },
];

export function EmailSection() {
  const { lang } = useLangStore();
  const t = (key: Parameters<typeof getTranslation>[1]) => getTranslation(lang, key);
  const { settings, updateSetting } = useSettingsStore();

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
  const emailVal = getSetting('tools.email.email');
  const hasEmail = emailVal?.value && emailVal.value !== '••••••••' && emailVal.value !== '';
  const currentProvider = editValues['tools.email.provider'] || getSetting('tools.email.provider')?.value || 'gmail';

  const renderField = (field: { key: string; labelKey: string; placeholder: string; sensitive?: boolean }) => {
    const setting = getSetting(field.key);
    const isSensitive = field.sensitive ?? setting?.sensitive;
    return (
      <div key={field.key}>
        <div className="mb-1">
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {t(field.labelKey as Parameters<typeof getTranslation>[1])}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <input
              type={isSensitive && !showValues[field.key] ? 'password' : 'text'}
              value={editValues[field.key] ?? ''}
              onChange={(e) => setEditValues((p) => ({ ...p, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className="w-full rounded-lg border px-2.5 py-1.5 pr-8 text-[13px] outline-none transition-colors focus:border-[var(--accent)]"
              style={{ background: 'var(--shell-bg)', borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(field.key); }}
            />
            {isSensitive && (
              <button onClick={() => setShowValues((p) => ({ ...p, [field.key]: !p[field.key] }))} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-80">
                {showValues[field.key] ? <EyeOff size={13} style={{ color: 'var(--text-tertiary)' }} /> : <Eye size={13} style={{ color: 'var(--text-tertiary)' }} />}
              </button>
            )}
          </div>
          <button
            onClick={() => handleSave(field.key)}
            disabled={!editValues[field.key] || saving[field.key]}
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-20"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
            title={t('settings.save')}
          >
            <Save size={13} strokeWidth={1.9} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Status */}
      <div className="flex items-center gap-2 rounded-2xl px-4 py-2.5" style={{ background: 'var(--panel-surface)' }}>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: hasEmail ? 'var(--accent)' : 'var(--text-tertiary)' }} />
        <span className="text-[13px] font-medium" style={{ color: hasEmail ? 'var(--accent)' : 'var(--text-tertiary)' }}>
          {hasEmail ? t('settings.emailConnected') : t('settings.emailNotConfigured')}
        </span>
      </div>

      {/* Main card: provider + email + password */}
      <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
        <div className="space-y-3">
          {/* Provider */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {t('settings.emailProviderLabel')}
              </span>
              <CustomSelect
                value={currentProvider}
                options={PROVIDER_OPTIONS}
                onChange={(val) => {
                  setEditValues((p) => ({ ...p, 'tools.email.provider': val }));
                  updateSetting('tools.email.provider', val);
                }}
              />
            </div>
          </div>

          {/* Email + Password */}
          {MAIN_FIELDS.map(renderField)}
        </div>
      </div>

      {/* Custom IMAP/SMTP — only if provider === 'custom' */}
      {currentProvider === 'custom' && (
        <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--panel-surface)' }}>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            IMAP / SMTP
          </p>
          <div className="space-y-3">
            {CUSTOM_FIELDS.map((f) => renderField({ ...f, sensitive: false }))}
          </div>
        </div>
      )}
    </>
  );
}
